import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import { AI_MEDIA_SOURCE_BUCKET, getSignedAiMediaUrl } from "@/lib/ai-media-storage";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA SOURCES — list the Producer's uploaded source photos for the Place.
 *
 * Source media is PRIVATE. This route returns metadata + a short-lived signed
 * read URL minted server-side for each source. Source media is never exposed as
 * a public Storage URL: the bucket has no client policy and is read only through
 * this Producer-gated endpoint.
 */

type SourceRow = {
  id: string;
  place_id: string;
  producer_id: string;
  source_key: string;
  storage_path: string;
  mime_type: string;
  byte_size: number;
  uploaded_at: string;
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
      .from("ai_media_sources")
      .select("id, place_id, producer_id, source_key, storage_path, mime_type, byte_size, uploaded_at")
      .eq("place_id", placeId)
      .order("uploaded_at", { ascending: false });
    if (error) throw new Error("ai_media_unavailable");

    const rows = (data ?? []) as SourceRow[];
    const sources = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        placeId: row.place_id,
        producerId: row.producer_id,
        sourceKey: row.source_key,
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        uploadedAt: row.uploaded_at,
        signedUrl: await getSignedAiMediaUrl(AI_MEDIA_SOURCE_BUCKET, row.storage_path).catch(() => null),
      })),
    );

    return NextResponse.json({ sources });
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
