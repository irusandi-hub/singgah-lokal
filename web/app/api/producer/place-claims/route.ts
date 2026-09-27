import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { PlaceClaimError, placeClaimErrorMessage, placeClaimErrorStatus } from "@/lib/place-claim";
import { listUserPlaceClaims, submitPlaceClaim } from "@/lib/producer/place-claim";

export const dynamic = "force-dynamic";

/**
 * Producer place claims (Producer App).
 *
 * GET  → this Producer's own claims (status only, plus their own evidence
 *        file name). Scoped by the session's user id, so no Producer can see
 *        another Producer's claim.
 * POST → file a claim for an EXISTING Place.
 *        multipart/form-data: placeId + file (proof) + optional note
 *
 * Fail-closed and server-side:
 * - the claimant identity is the authenticated session, never request input;
 * - the proof file is mandatory (missing file ⇒ 400 before any upload);
 * - the file goes to the PRIVATE evidence bucket — no public URL, no binary
 *   in the database (only the storage reference is stored);
 * - filing grants NOTHING: the claim is 'pending' and the Place stays
 *   unowned until an Admin approves it. An already-owned Place is refused
 *   here too, so bypassing the list cannot help.
 */
export async function GET(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    return NextResponse.json({ claims: await listUserPlaceClaims(actor.userId) });
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

export async function POST(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);

    const form = await request.formData();
    const placeId = form.get("placeId");
    if (typeof placeId !== "string" || !placeId.trim()) {
      throw new PlaceClaimError("place_not_found");
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      // Proof of ownership is a hard requirement, not a soft warning.
      throw new PlaceClaimError("place_claim_evidence_required");
    }
    const note = form.get("note");

    const claimId = await submitPlaceClaim({
      userId: actor.userId,
      placeId: placeId.trim(),
      file,
      note: typeof note === "string" ? note : null,
    });

    return NextResponse.json({ ok: true, claimId, status: "pending" }, { status: 201 });
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
    console.error("[producer/place-claims] submit failed:", error);
    return NextResponse.json({ error: "place_claim_unavailable" }, { status: 503 });
  }
}
