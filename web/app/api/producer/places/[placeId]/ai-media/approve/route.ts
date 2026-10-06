import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import { AiMediaError, validateAiMediaOutputKey, validateAiMediaStatus, type AiMediaOutputKey } from "@/lib/ai-media";
import { promoteAiMediaOutputToPublic, removePromotedAiMediaObject } from "@/lib/ai-media-storage";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA APPROVAL — approve or reject ONE draft output (owner/manager only).
 *
 * Approval is the ONLY path that publishes AI-derived media:
 * - the draft is re-read server-side; only a `draft` can be decided;
 * - on approval the private object is promoted into the public `place-media`
 *   bucket (server code) and the resulting https URL is recorded;
 * - the server-only `approve_ai_media_output` RPC stores the decision and, for
 *   the `hook` output only, updates the canonical `places.cover_image_url`;
 * - a failed approval removes the just-promoted object so no unreferenced
 *   public asset survives;
 * - rejection never publishes and never touches the Place cover.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await params;
    const actor = await requireAuthenticatedActor(request);
    // Approval is a publication-grade action: owner/manager only.
    const access = await requireProducerAccess(request, placeId, ["owner", "manager"]);

    const body = await request.json();
    if (!body || typeof body !== "object") throw new AiMediaError("ai_media_status_invalid");

    const outputKey = (body as { outputKey?: unknown }).outputKey;
    if (!validateAiMediaOutputKey(outputKey)) {
      throw new AiMediaError("ai_media_output_key_invalid");
    }
    const status = (body as { status?: unknown }).status;
    if (!validateAiMediaStatus(status) || status === "draft") {
      throw new AiMediaError("ai_media_status_invalid");
    }

    const supabase = createSupabaseServiceClient();

    // Re-read the draft server-side; the client's claim about it is not trusted.
    const { data: existing, error: readError } = await supabase
      .from("ai_media")
      .select("id, storage_path, mime_type, status")
      .eq("place_id", placeId)
      .eq("producer_id", access.producerId)
      .eq("output_key", outputKey)
      .maybeSingle<{ id: string; storage_path: string; mime_type: string; status: string }>();
    if (readError) throw new Error("ai_media_unavailable");
    if (!existing) return NextResponse.json({ error: "ai_media_output_not_found" }, { status: 404 });
    if (existing.status !== "draft") {
      return NextResponse.json({ error: "ai_media_output_not_draft" }, { status: 400 });
    }

    let promotedPublicUrl: string | null = null;
    let promotedPublicPath: string | null = null;
    if (status === "approved") {
      const promoted = await promoteAiMediaOutputToPublic({
        placeId,
        outputKey: outputKey as AiMediaOutputKey,
        storagePath: existing.storage_path,
        mimeType: existing.mime_type,
      });
      promotedPublicUrl = promoted.publicUrl;
      promotedPublicPath = promoted.publicPath;
    }

    const { error } = await supabase.rpc("approve_ai_media_output", {
      p_user_id: actor.userId,
      p_place_id: placeId,
      p_producer_id: access.producerId,
      p_output_key: outputKey,
      p_status: status,
      p_public_url: promotedPublicUrl,
    });

    if (error) {
      // Reconcile the promotion away; the approval did not happen.
      if (promotedPublicPath) await removePromotedAiMediaObject(promotedPublicPath);
      const message = String(error.message);
      if (message.includes("ai_media_output_not_found")) {
        return NextResponse.json({ error: "ai_media_output_not_found" }, { status: 404 });
      }
      if (message.includes("ai_media_output_not_draft")) {
        return NextResponse.json({ error: "ai_media_output_not_draft" }, { status: 400 });
      }
      if (message.includes("ai_media_output_public_url_invalid")) {
        return NextResponse.json({ error: "ai_media_output_public_url_invalid" }, { status: 400 });
      }
      throw new Error("ai_media_approval_failed");
    }

    return NextResponse.json({ ok: true, outputKey, status, publicUrl: promotedPublicUrl });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    if (error instanceof AiMediaError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    if (error instanceof Error && error.message === "ai_media_promotion_failed") {
      return NextResponse.json({ error: "ai_media_promotion_failed" }, { status: 502 });
    }
    return NextResponse.json({ error: "ai_media_approval_failed" }, { status: 400 });
  }
}
