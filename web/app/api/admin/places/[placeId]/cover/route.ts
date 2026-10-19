import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import {
  AdminPlaceCoverError,
  adminPlaceCoverErrorMessage,
  adminPlaceCoverErrorStatus,
  setAdminPlaceProfilePhoto,
} from "@/lib/admin/place-cover";

export const dynamic = "force-dynamic";

/**
 * Admin Place profile photo.
 *
 * POST /api/admin/places/[placeId]/cover
 *   multipart/form-data: file   (add / replace the Place's profile photo)
 *
 * The profile photo IS the canonical `places.cover_image_url` — the one value
 * Home cards, the Place detail hero, and the Producer workspace header render.
 * This route adds no second photo source and no second storage: the file goes
 * to the EXISTING public `place-media` bucket through the existing server-side
 * helper (lib/place-media-storage), and only the canonical column is updated.
 *
 * Authorization is re-verified server-side on EVERY call — the same explicit
 * route-level Platform Admin guard the other Admin Place routes use, repeated
 * inside the service layer for defense in depth. A signed-in user without the
 * Platform Admin role is refused before any Storage or database write, so
 * hiding the control in the UI is never the protection. This route is NOT
 * reachable through the Producer gates: it requires no membership, which is
 * exactly why a Place with no active manager (or an archived one) can still be
 * fixed here — without granting management rights or changing any status.
 */
async function denyUnlessModerator(): Promise<NextResponse | null> {
  try {
    await requirePlatformModerator();
    return null;
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  const denied = await denyUnlessModerator();
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: adminPlaceCoverErrorMessage("place_photo_file_required"), code: "place_photo_file_required" },
      { status: 400 },
    );
  }

  const fileEntry = form.get("file");
  const file = fileEntry instanceof File && fileEntry.size > 0 ? fileEntry : null;
  if (!file) {
    return NextResponse.json(
      { error: adminPlaceCoverErrorMessage("place_photo_file_required"), code: "place_photo_file_required" },
      { status: 400 },
    );
  }

  try {
    const { placeId } = await params;
    return NextResponse.json(await setAdminPlaceProfilePhoto(placeId, file));
  } catch (error) {
    if (error instanceof AdminPlaceCoverError) {
      return NextResponse.json(
        { error: adminPlaceCoverErrorMessage(error.code), code: error.code },
        { status: adminPlaceCoverErrorStatus(error.code) },
      );
    }
    console.error("[admin/places] profile photo update failed:", error);
    return NextResponse.json(
      { error: adminPlaceCoverErrorMessage("place_cover_upload_failed") },
      { status: 503 },
    );
  }
}
