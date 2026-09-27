import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import { PlaceClaimError, placeClaimErrorMessage } from "@/lib/place-claim";
import { createReviewedPlaceClaimEvidenceUrl } from "@/lib/producer/place-claim";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/place-claims/[claimId]/evidence
 *
 * Short-lived signed link to a claim's proof of ownership, for a Platform
 * Moderator assessing the claim. The evidence bucket is private, so this
 * moderator-guarded mint is the only way to open the document — it is never
 * turned into a public or shareable URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  try {
    await requirePlatformModerator();
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }
  try {
    const { claimId } = await params;
    const url = await createReviewedPlaceClaimEvidenceUrl(claimId);
    if (!url) {
      return NextResponse.json({ error: "place_claim_not_found" }, { status: 404 });
    }
    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof PlaceClaimError) {
      return NextResponse.json({ error: placeClaimErrorMessage(error.code), code: error.code }, { status: 400 });
    }
    return NextResponse.json({ error: "place_claim_unavailable" }, { status: 503 });
  }
}
