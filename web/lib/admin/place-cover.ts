import "server-only";

import { recordPlaceAudit, PlaceAuditError } from "@/lib/admin/place-audit";
import { PLACE_AUDIT_ACTIONS, placeAuditSnapshot } from "@/lib/place-audit-format";
import { isPlaceOwnMediaPath, PLACE_PROFILE_PHOTO_SLOT_KEY, placeMediaStoragePathFromUrl } from "@/lib/place-cover";
import { PlaceMediaError, validatePlaceMediaFile } from "@/lib/place-media";
import { removePlacePhotoObject, uploadPlacePhoto } from "@/lib/place-media-storage";
import { SupabasePlaceManagementRepository } from "@/lib/place-experience-repository";
import { requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * ADMIN PLACE PROFILE PHOTO — the administrative authority to add, replace, or
 * update the profile photo of a Place that has no active manager, still uses a
 * placeholder or fixture photo, or is archived (Authority Master §5: Platform
 * Admin has operational authority over Place).
 *
 * WHAT IT WRITES, AND WHAT IT DELIBERATELY DOES NOT
 * - The profile photo IS `places.cover_image_url` — the ONE canonical column
 *   every consumer already renders (Home card, Place detail hero, Producer
 *   workspace header). Nothing here creates a second photo source: no new
 *   column, no new table, no new bucket, no second upload mechanism.
 * - The object is stored through the EXISTING server-side helper
 *   (`uploadPlacePhoto`) into the EXISTING public `place-media` bucket, under
 *   the EXISTING Place-scoped layout `places/<placeId>/<slot>-<random>.<ext>`,
 *   so the Place cleanup path (`removePlacePhotoObjects`) and the bucket's
 *   existing policies apply unchanged.
 * - `place_photos` is NOT written. Those five slots are the Producer's media
 *   library; an administrative photo fix must not rewrite a manager's media
 *   rows, and for a managerless Place there is no library to write. This is the
 *   same cover-only shape the approved AI-media path already uses (migration
 *   0042's `approve_ai_media_output` writes only `places.cover_image_url`).
 * - `publication_status` is NEVER touched: fixing a photo cannot publish,
 *   pause, or archive a Place, and an archived Place stays archived.
 * - `producer_id`, `claim_status`, and `is_dummy` are NEVER touched: the photo
 *   fix grants no management right to any account and forces no replacement
 *   manager, and a membership-less Place is not refused for being
 *   managerless.
 *
 * AUTHORITY AND ACCOUNTABILITY
 * - Every call starts with `requirePlatformModerator()` from the session, and
 *   the actor id is the guard's return value — never client input, never the
 *   service role.
 * - The write runs through the service-role client, i.e. it is not reachable
 *   from any client session: a signed-in user calling this endpoint without the
 *   Platform Admin role is refused by the guard before any Storage or DB write.
 * - Every change lands in the append-only `place_audit` trail (migration 0031)
 *   with the canonical before/after Place snapshot, so the cover change is
 *   readable as a diff in the workspace's Riwayat (`placeAuditChanges` already
 *   renders `cover_image_url`). The existing `admin_place_updated` action is
 *   reused deliberately: an Admin photo fix IS a Place data edit, and reusing
 *   the existing vocabulary needs no migration to widen the database's action
 *   CHECK constraint. `detail.operation` names the specific act.
 * - FAIL CLOSED, NO PARTIAL STATE: if the Storage upload fails, nothing is
 *   written. If the cover write fails, the just-uploaded object is removed. If
 *   the audit entry cannot be written, the cover is reverted to its previous
 *   value and the new object removed — a change with no attributable trail is
 *   exactly what Master 09 §2/§13 forbids, and a failed request must never
 *   leave the surface looking updated.
 */

export class AdminPlaceCoverError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Operator-facing message; never leaks an internal detail. */
export function adminPlaceCoverErrorMessage(code: string): string {
  switch (code) {
    case "place_not_found":
      return "Tempat tidak ditemukan.";
    case "place_photo_file_required":
      return "Pilih file foto terlebih dahulu.";
    case "place_photo_type_invalid":
      return "Format foto tidak didukung. Gunakan JPG, PNG, WebP, atau AVIF.";
    case "place_photo_size_invalid":
      return "Ukuran foto tidak valid (maksimal 5 MB).";
    case "place_media_bucket_missing":
      return "Penyimpanan foto belum siap. Hubungi tim teknis.";
    case "place_audit_unavailable":
      return "Riwayat tindakan tidak dapat dicatat, jadi foto tidak disimpan. Coba lagi.";
    case "place_cover_upload_failed":
      return "Foto tidak dapat diunggah. Coba lagi.";
    default:
      return "Foto profil Tempat tidak dapat diperbarui. Coba lagi.";
  }
}

export function adminPlaceCoverErrorStatus(code: string): number {
  if (code === "place_not_found") return 404;
  if (code === "place_media_bucket_missing") return 503;
  return 400;
}

function adminPlaceRepository() {
  return new SupabasePlaceManagementRepository(createSupabaseServiceClient());
}

export type AdminPlaceCoverResult = {
  placeId: string;
  /** The canonical cover URL now stored on the Place (what the app renders). */
  coverImageUrl: string;
};

/**
 * Store `file` as the profile photo of `placeId` and point the canonical cover
 * at it. Returns the URL the server actually saved — the caller renders THAT
 * value, never the local preview.
 */
export async function setAdminPlaceProfilePhoto(
  placeId: string,
  file: File,
): Promise<AdminPlaceCoverResult> {
  // Server-side authority first: the actor comes from the session guard.
  const actor = await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) throw new AdminPlaceCoverError("place_not_found");

  const repository = adminPlaceRepository();
  const place = await repository.getById(id);
  if (!place) throw new AdminPlaceCoverError("place_not_found");

  // Same fail-closed file gate the Producer upload path uses (type + size),
  // re-run server-side no matter what the browser already checked.
  try {
    validatePlaceMediaFile({ type: file.type, size: file.size });
  } catch (error) {
    if (error instanceof PlaceMediaError) throw new AdminPlaceCoverError(error.code);
    throw error;
  }

  let uploaded: { storagePath: string; url: string };
  try {
    uploaded = await uploadPlacePhoto({ placeId: id, slotKey: PLACE_PROFILE_PHOTO_SLOT_KEY, file });
  } catch (error) {
    if (error instanceof Error && error.message === "place_media_bucket_missing") {
      throw new AdminPlaceCoverError("place_media_bucket_missing");
    }
    throw new AdminPlaceCoverError("place_cover_upload_failed");
  }

  const admin = createSupabaseServiceClient();
  const write = await admin
    .from("places")
    .update({ cover_image_url: uploaded.url, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (write.error) {
    // The object is live but the Place does not reference it: remove it rather
    // than leave an unreferenced public asset behind, and report failure.
    await removePlacePhotoObject(uploaded.storagePath).catch(() => {});
    throw new AdminPlaceCoverError("place_unavailable");
  }

  try {
    await recordPlaceAudit({
      placeId: id,
      actorId: actor.userId,
      action: PLACE_AUDIT_ACTIONS.updated,
      before: placeAuditSnapshot(place),
      after: placeAuditSnapshot({ ...place, coverImageUrl: uploaded.url }),
      detail: { field: "cover_image_url", operation: "profile_photo_uploaded" },
    });
  } catch (error) {
    // No unattributed change survives: restore the previous cover (which may
    // legitimately be "no photo at all") and drop the new object.
    try {
      await admin
        .from("places")
        .update({ cover_image_url: place.coverImageUrl, updated_at: new Date().toISOString() })
        .eq("id", id);
    } catch {
      // Best-effort revert; the original audit failure is surfaced regardless.
    }
    await removePlacePhotoObject(uploaded.storagePath).catch(() => {});
    throw error instanceof PlaceAuditError
      ? new AdminPlaceCoverError("place_audit_unavailable")
      : error;
  }

  // LAST MUTATION, best-effort: the replaced object goes only when it is one of
  // OUR objects in THIS Place's own folder AND no `place_photos` row of this
  // Place still references it — a manager's media library (or a promoted AI
  // output) must never be deleted by a photo fix. A failed check keeps the
  // object: an unused object is harmless, a broken reference is not.
  const previousPath = placeMediaStoragePathFromUrl(place.coverImageUrl);
  if (previousPath && previousPath !== uploaded.storagePath && isPlaceOwnMediaPath(previousPath, id)) {
    const referenced = await admin
      .from("place_photos")
      .select("id")
      .eq("place_id", id)
      .eq("storage_path", previousPath)
      .limit(1);
    if (!referenced.error && !referenced.data?.length) {
      await removePlacePhotoObject(previousPath).catch(() => {});
    }
  }

  return { placeId: id, coverImageUrl: uploaded.url };
}
