import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { PlaceClaimError, placeClaimErrorMessage } from "@/lib/place-claim";
import { createUserPlaceClaimEvidenceUrl } from "@/lib/producer/place-claim";

export const dynamic = "force-dynamic";

/**
 * GET /api/producer/place-claims/[claimId]/evidence
 *
 * Short-lived signed link to the caller's OWN proof of ownership.
 *
 * The evidence lives in a private bucket with no client access, so this is the
 * only way to read it — and it is scoped to the session: the lookup filters on
 * the authenticated user id, so Producer A asking for Producer B's claim id
 * gets the same "not found" answer as a claim that does not exist. No public
 * URL is ever produced.
 */
export async function GET(request: Request, { params }: { params: Promise<{ claimId: string }> }) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const { claimId } = await params;
    const url = await createUserPlaceClaimEvidenceUrl(actor.userId, claimId);
    if (!url) {
      return NextResponse.json({ error: "place_claim_not_found" }, { status: 404 });
    }
    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof PlaceClaimError) {
      return NextResponse.json(
        { error: placeClaimErrorMessage(error.code), code: error.code },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "place_claim_unavailable" }, { status: 503 });
  }
}
