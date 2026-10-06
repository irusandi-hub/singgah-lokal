import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import { AI_MEDIA_OUTPUT_BUCKET, getSignedAiMediaUrl } from "@/lib/ai-media-storage";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA OUTPUTS — list the 2 generated outputs for the Place.
 *
 * READ-ONLY. There is deliberately NO POST/PUT here: generated outputs are
 * persisted server-side by the job worker through `save_ai_media_output` after
 * a real provider produced real files. Exposing a client endpoint that stored
 * "generated" media would be a fake generation path, so none exists.
 *
 * Drafts are private: their preview URL is a short-lived signed URL minted
 * server-side. Approved outputs carry their public https asset URL (hook →
 * Place cover; place_story → Home/Discovery story asset).
 */
type OutputRow = {
  id: string;
  place_id: string;
  producer_id: string;
  output_key: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  status: string;
  provider: string | null;
  generated_at: string;
  approved_at: string | null;
  approved_by: string | null;
  approved_public_url: string | null;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await params;
    await requireAuthenticatedActor(request);
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const supabase = createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("ai_media")
      .select("*")
      .eq("place_id", placeId)
      .order("generated_at", { ascending: false });
    if (error) throw new Error("ai_media_unavailable");

    const rows = (data ?? []) as OutputRow[];
    const outputs = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        placeId: row.place_id,
        producerId: row.producer_id,
        outputKey: row.output_key,
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        status: row.status,
        provider: row.provider,
        generatedAt: row.generated_at,
        approvedAt: row.approved_at,
        approvedBy: row.approved_by,
        // Approved → public asset URL; draft/rejected → private signed preview.
        previewUrl:
          row.status === "approved"
            ? row.approved_public_url
            : await getSignedAiMediaUrl(AI_MEDIA_OUTPUT_BUCKET, row.storage_path).catch(() => null),
        publicUrl: row.approved_public_url,
      })),
    );

    return NextResponse.json({ outputs });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    return NextResponse.json({ error: "ai_media_unavailable" }, { status: 400 });
  }
}
