import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import {
  AdminPlaceError,
  adminPlaceErrorMessage,
  adminPlaceErrorStatus,
  getAdminPlaceDetail,
  updateAdminPlace,
} from "@/lib/admin/place-workspace";

export const dynamic = "force-dynamic";

/**
 * One Place in the Admin workspace.
 *
 * GET   → the detail workspace payload (Informasi Tempat, Publikasi,
 *         Pengelola + membership, Klaim, counters, Riwayat).
 * PATCH → edit Place information. Ownership (`producer_id`) and claim state
 *         are NOT writable here: the shared Place mutation validator refuses
 *         a `producerId` in the payload, and `claim_status` is never touched.
 *         Ownership changes only through the claim review path.
 *
 * Both verbs re-verify Platform Admin authorization server-side — the same
 * explicit route-level guard the Admin claim-review route uses, repeated
 * inside the data layer for defense in depth.
 */
async function denyUnlessModerator(): Promise<NextResponse | null> {
  try {
    await requirePlatformModerator();
    return null;
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  const denied = await denyUnlessModerator();
  if (denied) return denied;

  try {
    const { placeId } = await params;
    const detail = await getAdminPlaceDetail(placeId);
    if (!detail) return NextResponse.json({ error: adminPlaceErrorMessage("place_not_found") }, { status: 404 });
    return NextResponse.json(detail);
  } catch (error) {
    if (error instanceof AdminPlaceError) {
      return NextResponse.json(
        { error: adminPlaceErrorMessage(error.code), code: error.code },
        { status: adminPlaceErrorStatus(error.code) },
      );
    }
    console.error("[admin/places] detail failed:", error);
    return NextResponse.json({ error: adminPlaceErrorMessage("place_unavailable") }, { status: 503 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  const denied = await denyUnlessModerator();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: adminPlaceErrorMessage("place_input_invalid") }, { status: 400 });
  }

  try {
    const { placeId } = await params;
    return NextResponse.json(await updateAdminPlace(placeId, body));
  } catch (error) {
    if (error instanceof AdminPlaceError) {
      return NextResponse.json(
        { error: adminPlaceErrorMessage(error.code), code: error.code },
        { status: adminPlaceErrorStatus(error.code) },
      );
    }
    console.error("[admin/places] update failed:", error);
    return NextResponse.json({ error: adminPlaceErrorMessage("place_unavailable") }, { status: 503 });
  }
}
