import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { PlaceClaimError, placeClaimErrorMessage, placeClaimErrorStatus } from "@/lib/place-claim";
import { listClaimablePlaces } from "@/lib/producer/place-claim";

export const dynamic = "force-dynamic";

/**
 * GET /api/producer/place-claims/claimable-places
 *
 * The Places a Producer may claim. The "unowned only" rule is enforced in the
 * DATABASE (migration 0028, `list_claimable_places`), not here and not in the
 * browser: an owned Place cannot be listed, searched for, or picked by calling
 * this endpoint directly. The response carries canonical Place data only —
 * there is no category field to set, and choosing a Place never changes it.
 */
export async function GET(request: Request) {
  try {
    await requireAuthenticatedActor(request);
    return NextResponse.json({ places: await listClaimablePlaces() });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof PlaceClaimError) {
      return NextResponse.json(
        { error: placeClaimErrorMessage(error.code), code: error.code },
        { status: placeClaimErrorStatus(error.code) },
      );
    }
    return NextResponse.json({ error: "place_claim_unavailable" }, { status: 503 });
  }
}
