import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA QUOTA — Producer self-read of quota/cost posture.
 *
 * The platform must control Producer AI cost. This route exposes the calling
 * Producer's own quota posture; quotas are set server/admin-side and are never
 * writable from a client. No provider is invoked here.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await params;
    await requireAuthenticatedActor(request);
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const { data, error } = await createSupabaseServiceClient()
      .from("ai_media_quota")
      .select("producer_id, quota_tokens, used_tokens, last_used_at, updated_at")
      .eq("producer_id", access.producerId)
      .maybeSingle();
    if (error) throw new Error("ai_media_unavailable");

    return NextResponse.json({
      quota: data
        ? {
            producerId: String(data.producer_id),
            quotaTokens: Number(data.quota_tokens),
            usedTokens: Number(data.used_tokens),
            lastUsedAt: data.last_used_at ? String(data.last_used_at) : null,
            updatedAt: String(data.updated_at),
          }
        : null,
    });
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
