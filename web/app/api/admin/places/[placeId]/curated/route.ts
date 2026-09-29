import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import {
  AdminPlaceError,
  adminPlaceErrorMessage,
  adminPlaceErrorStatus,
  setAdminPlaceCurated,
} from "@/lib/admin/place-workspace";

export const dynamic = "force-dynamic";

/**
 * Admin Tempat Pilihan promotion (Stage 4): PATCH { isCurated: boolean }.
 *
 * "Jadikan Tempat Pilihan" / "Cabut Promosi" — the flag-only Admin action.
 * Deliberately separate from Discovery: this route cannot write a score, a
 * star, or eligibility (no such parameter exists), and it never changes
 * publication, claim, or ownership. Authorization is re-verified server-side
 * on every call (route guard + workspace guard), and every decision is
 * recorded in the append-only place_audit trail with rollback on audit
 * failure.
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

  let body: { isCurated?: unknown } = {};
  try {
    body = (await request.json()) as { isCurated?: unknown };
  } catch {
    return NextResponse.json({ error: adminPlaceErrorMessage("place_curated_flag_invalid") }, { status: 400 });
  }

  try {
    const { placeId } = await params;
    return NextResponse.json(await setAdminPlaceCurated(placeId, body.isCurated));
  } catch (error) {
    if (error instanceof AdminPlaceError) {
      return NextResponse.json(
        { error: adminPlaceErrorMessage(error.code), code: error.code },
        { status: adminPlaceErrorStatus(error.code) },
      );
    }
    console.error("[admin/places] curation failed:", error);
    return NextResponse.json({ error: adminPlaceErrorMessage("place_unavailable") }, { status: 503 });
  }
}
