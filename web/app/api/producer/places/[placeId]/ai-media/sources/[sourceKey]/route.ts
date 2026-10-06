import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import {
  AiMediaError,
  validateAiMediaSourceFile,
  validateAiMediaSourceKey,
  type AiMediaSourceKey,
} from "@/lib/ai-media";
import { removeAiMediaObject, uploadAiMediaSource } from "@/lib/ai-media-storage";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA SOURCE UPLOAD — one of the 4 locked source photos of a Place.
 *
 * POST /api/producer/places/[placeId]/ai-media/sources/[sourceKey]
 *   multipart/form-data: file
 *
 * sourceKey is one of: place, material, process, result.
 *
 * Server-side, fail-closed:
 * - the session must hold an owner/manager/editor membership for the Place;
 * - the file type + size are validated server-side (lib/ai-media limits);
 * - the file goes to the PRIVATE `ai-media-sources` bucket via the service-role
 *   client (clients never receive bucket credentials);
 * - the canonical reference lands in `ai_media_sources` via the server-only
 *   `upload_ai_media_source` RPC, keyed by (place_id, producer_id, source_key),
 *   so a repeated upload REPLACES a slot instead of duplicating it;
 * - if the canonical reference fails, the uploaded object is removed so no
 *   unreferenced object outlives a failed write;
 * - the ORIGINAL 4 photos are what the Producer uploaded — this path never
 *   generates or mutates derived media.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ placeId: string; sourceKey: string }> },
) {
  try {
    const { placeId, sourceKey } = await params;

    if (!validateAiMediaSourceKey(sourceKey)) {
      throw new AiMediaError("ai_media_source_key_invalid");
    }

    // Producer access check BEFORE any storage/DB interaction.
    const actor = await requireAuthenticatedActor(request);
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AiMediaError("ai_media_source_type_invalid");
    validateAiMediaSourceFile({ type: file.type, size: file.size });

    const uploaded = await uploadAiMediaSource({
      placeId,
      sourceKey: sourceKey as AiMediaSourceKey,
      file,
    });

    // Persist the canonical source reference via the server-only RPC.
    const { error } = await createSupabaseServiceClient().rpc("upload_ai_media_source", {
      p_user_id: actor.userId,
      p_place_id: placeId,
      p_producer_id: access.producerId,
      p_source_key: sourceKey,
      p_storage_path: uploaded.storagePath,
      p_mime_type: file.type,
      p_byte_size: file.size,
    });

    if (error) {
      // No DB reference may outlive its object: drop the object we just wrote.
      await removeAiMediaObject(uploaded.bucket, uploaded.storagePath);
      const message = String(error.message);
      if (message.includes("producer_authorization_required")) {
        return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
      }
      if (message.includes("ai_media_source_key_invalid")) {
        return NextResponse.json({ error: "ai_media_source_key_invalid" }, { status: 400 });
      }
      throw new Error("ai_media_source_upload_failed");
    }

    return NextResponse.json({
      ok: true,
      sourceKey,
      mimeType: file.type,
      byteSize: file.size,
    });
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
    if (error instanceof Error && error.message === "ai_media_bucket_missing") {
      return NextResponse.json({ error: "ai_media_bucket_missing" }, { status: 503 });
    }
    return NextResponse.json({ error: "ai_media_source_upload_failed" }, { status: 400 });
  }
}
