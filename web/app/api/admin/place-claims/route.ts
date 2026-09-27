import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import { PlaceClaimError, placeClaimErrorMessage, placeClaimErrorStatus } from "@/lib/place-claim";
import { listPlaceClaimsForReview, reviewPlaceClaim } from "@/lib/producer/place-claim";

export const dynamic = "force-dynamic";

/**
 * Admin review of Place claims (Platform Moderator only).
 *
 * GET  → the review queue: claimed Place + its canonical category/type, the
 *        claimant, the private evidence reference, submission time, status.
 * POST → { claimId, decision: "approved" | "rejected", reviewNote? }
 *        Approval is the ONLY path that grants ownership, and it grants it
 *        through the existing authorization model. Rejection grants nothing.
 *        Nothing is auto-approved: every decision is an explicit Admin action.
 */
export async function GET() {
  try {
    await requirePlatformModerator();
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }
  try {
    return NextResponse.json({ claims: await listPlaceClaimsForReview() });
  } catch (error) {
    if (error instanceof PlaceClaimError) {
      return NextResponse.json(
        { error: placeClaimErrorMessage(error.code), code: error.code },
        { status: placeClaimErrorStatus(error.code) },
      );
    }
    console.error("[admin/place-claims] list failed:", error);
    return NextResponse.json({ error: "Gagal memuat daftar klaim.", code: "service_unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await requirePlatformModerator();
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const claimId = typeof body.claimId === "string" ? body.claimId.trim() : "";
  const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : null;
  const reviewNote = typeof body.reviewNote === "string" ? body.reviewNote : null;

  if (!claimId || !decision) {
    return NextResponse.json(
      { error: "claimId dan decision wajib diisi.", code: "invalid_input" },
      { status: 400 },
    );
  }

  try {
    await reviewPlaceClaim({ claimId, decision, reviewNote });
    return NextResponse.json({ ok: true, status: decision });
  } catch (error) {
    if (error instanceof PlaceClaimError) {
      return NextResponse.json(
        { error: placeClaimErrorMessage(error.code), code: error.code },
        { status: placeClaimErrorStatus(error.code) },
      );
    }
    console.error("[admin/place-claims] review failed:", error);
    return NextResponse.json({ error: "Review gagal. Coba lagi.", code: "service_unavailable" }, { status: 503 });
  }
}
