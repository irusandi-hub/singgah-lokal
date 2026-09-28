import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import {
  AdminPlaceError,
  adminPlaceErrorMessage,
  adminPlaceErrorStatus,
  setAdminPlacePublicationStatus,
} from "@/lib/admin/place-workspace";

export const dynamic = "force-dynamic";

/**
 * Admin Place moderation (Terbitkan / Jeda / Arsipkan / Pulihkan dari arsip).
 *
 * The status set is the existing one — draft / published / paused / archived
 * — and the transition + readiness rules are the existing ones too, with the
 * Admin restore rule derived from Master 09 §8 ("Restoring publication
 * requires the appropriate authorization and revalidation") and checked in
 * `canAdminTransitionPlaceStatus` / `isPlacePublicationReady`.
 *
 * There is NO delete verb: archiving is the removal path, and a Place plus its
 * Experience, Visit Intent, claim, membership, Live, and history are preserved
 * (Master 09 §8/§15). Authorization is re-verified server-side on every call —
 * the explicit route-level guard matches the Admin claim-review route, and the
 * data layer repeats it.
 */
async function denyUnlessModerator(): Promise<NextResponse | null> {
  try {
    await requirePlatformModerator();
    return null;
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  const denied = await denyUnlessModerator();
  if (denied) return denied;

  let body: { publicationStatus?: unknown } = {};
  try {
    body = (await request.json()) as { publicationStatus?: unknown };
  } catch {
    return NextResponse.json({ error: adminPlaceErrorMessage("place_status_invalid") }, { status: 400 });
  }

  try {
    const { placeId } = await params;
    return NextResponse.json(await setAdminPlacePublicationStatus(placeId, body.publicationStatus));
  } catch (error) {
    if (error instanceof AdminPlaceError) {
      return NextResponse.json(
        { error: adminPlaceErrorMessage(error.code), code: error.code },
        { status: adminPlaceErrorStatus(error.code) },
      );
    }
    console.error("[admin/places] moderation failed:", error);
    return NextResponse.json({ error: adminPlaceErrorMessage("place_unavailable") }, { status: 503 });
  }
}
