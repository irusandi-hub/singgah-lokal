import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import {
  AdminPlaceError,
  adminPlaceErrorMessage,
  adminPlaceErrorStatus,
  createAdminPlace,
} from "@/lib/admin/place-workspace";

export const dynamic = "force-dynamic";

/**
 * Admin Place collection (Authority Master §5 — Platform Admin has
 * operational authority over Place).
 *
 * POST → create a Place WITHOUT a Producer. `producer_id` is written as NULL
 *        and ownership is left entirely to the EXISTING claim flow: a
 *        rightful owner claims the Place later and Platform Admin reviews it
 *        through /api/admin/place-claims. This route is NEVER used by a claim
 *        — reviewing a claim must never mint a second Place.
 *
 * Authorization is verified SERVER-SIDE, with the same explicit route-level
 * guard the Admin claim-review route already uses: a refusal is a clean 403
 * that reveals nothing about the account or the role and is never logged as a
 * service failure. `createAdminPlace` repeats the check (defense in depth) —
 * hiding the button in the UI is not what protects the endpoint. The list
 * stays a server-rendered read in /admin/places.
 */
async function denyUnlessModerator(): Promise<NextResponse | null> {
  try {
    await requirePlatformModerator();
    return null;
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }
}

export async function POST(request: Request) {
  const denied = await denyUnlessModerator();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: adminPlaceErrorMessage("place_input_invalid") }, { status: 400 });
  }

  try {
    const place = await createAdminPlace(body);
    return NextResponse.json(place, { status: 201 });
  } catch (error) {
    if (error instanceof AdminPlaceError) {
      return NextResponse.json(
        { error: adminPlaceErrorMessage(error.code), code: error.code },
        { status: adminPlaceErrorStatus(error.code) },
      );
    }
    console.error("[admin/places] create failed:", error);
    return NextResponse.json({ error: adminPlaceErrorMessage("place_unavailable") }, { status: 503 });
  }
}
