import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA GENERATION JOBS — read-only job history for the Place.
 *
 * Producer-gated. Generation jobs record "Generate Ulang" attempts with
 * idempotency + status so the platform can track usage without exposing any
 * generation capability to the client. There is no job-creation endpoint here.
 */
type JobRow = {
  id: string;
  place_id: string;
  producer_id: string;
  idempotency_key: string;
  kind: string;
  status: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  detail: Record<string, unknown> | null;
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await params;
    await requireAuthenticatedActor(request);
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const { data, error } = await createSupabaseServiceClient()
      .from("ai_media_generation_jobs")
      .select("id, place_id, producer_id, idempotency_key, kind, status, requested_at, started_at, completed_at, error_code, detail")
      .eq("place_id", placeId)
      .order("requested_at", { ascending: false });
    if (error) throw new Error("ai_media_unavailable");

    return NextResponse.json({
      jobs: ((data ?? []) as JobRow[]).map((row) => ({
        id: String(row.id),
        placeId: String(row.place_id),
        producerId: String(row.producer_id),
        idempotencyKey: String(row.idempotency_key),
        kind: String(row.kind),
        status: String(row.status),
        requestedAt: String(row.requested_at),
        startedAt: row.started_at ? String(row.started_at) : null,
        completedAt: row.completed_at ? String(row.completed_at) : null,
        errorCode: row.error_code ? String(row.error_code) : null,
        detail: row.detail ?? {},
      })),
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
