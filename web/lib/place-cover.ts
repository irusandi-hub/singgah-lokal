import { PLACE_MEDIA_BUCKET } from "@/lib/place-media";

/**
 * PLACE PROFILE PHOTO — the ONE canonical profile photo of a Place.
 *
 * A Place's profile photo is `places.cover_image_url` (migration 0018): the
 * exact value Home cards, the Place detail hero, and the Producer workspace
 * header render, and the exact value the app falls back from to the local
 * `/place-cover-placeholder.svg`. There is no second profile-photo field, no
 * second bucket, and no second table — this module only NAMES that one value
 * and classifies it.
 *
 * It is deliberately pure and client-safe (no `server-only`, no Supabase): the
 * Admin surface needs the same classification the server uses, so the rule
 * lives in exactly one place and can be unit-tested without a database.
 *
 * The `place_photos` media slots (lib/place-media.ts) are a SEPARATE concept:
 * they are the Producer's media library, and only the `hook` slot is wired to
 * synchronise the cover on a Producer upload (`resolvePlaceCoverSync`). The
 * Media library is never the profile photo itself.
 */

/**
 * Storage-folder slot name used for an object the ADMIN stores as a Place
 * profile photo. It reuses the canonical `places/<placeId>/<slot>-<random>`
 * object layout (lib/place-media-storage), so the object sits in the same
 * `place-media` bucket, under the same Place-scoped folder, and is removed by
 * the same Place cleanup path. It is NOT a `place_photos` slot key: no row is
 * written outside the `place_photos` library.
 */
export const PLACE_PROFILE_PHOTO_SLOT_KEY = "cover";

/**
 * What the Place's current profile photo actually is, as far as the canonical
 * data can tell — never a guess from a filename, a colour, or an image hash:
 *
 * - `placeholder` — no saved cover URL at all. Every surface renders the
 *   local `/place-cover-placeholder.svg` for this Place (Home's
 *   `PlaceCardCover` and the detail hero both fall back on a missing value).
 * - `dummy` — a saved cover URL on a row flagged `places.is_dummy = true`.
 *   Per Master Dummy Place v1.0 §2, `is_dummy` means "this row is a
 *   development/testing fixture, not a real listing", so its stored media is
 *   fixture media rather than documentation of a real Place.
 * - `foto` — a saved cover URL on a real listing.
 */
export type PlaceProfilePhotoKind = "foto" | "placeholder" | "dummy";

export function resolvePlaceProfilePhotoKind(params: {
  coverImageUrl: string | null | undefined;
  isDummy?: boolean | null;
}): PlaceProfilePhotoKind {
  const url = typeof params.coverImageUrl === "string" ? params.coverImageUrl.trim() : "";
  if (!url) return "placeholder";
  if (params.isDummy === true) return "dummy";
  return "foto";
}

/** Operator-facing Indonesian label for each determinable state. */
export const PLACE_PROFILE_PHOTO_KIND_LABEL: Record<PlaceProfilePhotoKind, string> = {
  foto: "Foto aktual",
  placeholder: "Placeholder",
  dummy: "Foto dummy",
};

/**
 * CARD COVER LOAD STATE (bug fix, 2026-10-20) — the ONE rule that decides what
 * a cover <img> element reports about itself, independent of React events.
 *
 * WHY: Home's cards are SERVER-rendered, so the cover <img> starts loading
 * during HTML parsing, long before React hydrates and can attach `onLoad`.
 * For a cached or fast image the `load` event has ALREADY fired by then and
 * never fires again, so a component that only listens for the event kept its
 * skeleton forever. Reading the element's own `complete`/`naturalWidth` at
 * mount (and again if the URL changes) closes that window without changing
 * what is displayed: `pending` keeps the skeleton, `loaded` reveals the photo,
 * `failed` (complete but no pixels) shows the local placeholder.
 *
 * Pure and client-safe, so the rule is unit-tested on its own.
 */
export type CoverLoadState = "pending" | "loaded" | "failed";

export function resolveCoverLoadState(
  image: { complete: boolean; naturalWidth: number } | null | undefined,
): CoverLoadState {
  if (!image || image.complete !== true) return "pending";
  return image.naturalWidth > 0 ? "loaded" : "failed";
}

/**
 * The object path inside `place-media` a saved public URL points at, or `null`
 * when the value is not one of our own public objects (an external URL, another
 * bucket, or a malformed value). This is the inverse of the storage module's
 * `publicUrlFor`, and it is the ONLY way the Admin path decides which object a
 * replaced cover used to live in — a value it never trusts for anything else.
 */
export function placeMediaStoragePathFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const marker = `/storage/v1/object/public/${PLACE_MEDIA_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index < 0) return null;
  const path = url.slice(index + marker.length).split("?")[0].split("#")[0];
  if (!path || path.length > 512) return null;
  return path;
}

/**
 * Does a stored object path live in THIS Place's own media folder
 * (`places/<placeId>/...`)? Only such an object may be considered for cleanup
 * after a replacement: anything else (a promoted AI output under
 * `ai-outputs/<placeId>/`, or another Place's object) belongs to a different
 * owner and is never touched by the Admin profile-photo path.
 */
export function isPlaceOwnMediaPath(storagePath: string, placeId: string): boolean {
  if (!storagePath || !placeId) return false;
  return storagePath.startsWith(`places/${placeId}/`);
}
