import "server-only";

import { PLACE_MEDIA_BUCKET, type PlacePhoto } from "@/lib/place-media";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * PLACE MEDIA STORAGE — Supabase Storage access for Place photo slots.
 *
 * The bucket (`place-media`) serves objects publicly (saved references are
 * read together with the Place, mirroring 0018's cover-image visibility);
 * ALL writes happen here, server-side, with the service-role client — after
 * the API layer has verified the session's Producer access to the Place.
 * Clients never receive bucket credentials or direct write access.
 *
 * Object layout: places/<placeId>/<slotKey>-<random>.<ext> — the Place id in
 * the path keeps references addressable per Place and makes cleanup of
 * replaced objects deterministic.
 */

const PLACE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUFFIX_BYTES = 12;

function fileExtension(fileName: string, mimeType: string): string {
  const guess = fileName.includes(".") ? fileName.split(".").pop() : "";
  const ext = (guess ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ext === "jpg") return "jpg";
  if (ext) return ext;
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/avif") return "avif";
  throw new Error("place_photo_type_invalid");
}

function assertPlaceId(placeId: string): string {
  if (!PLACE_ID_PATTERN.test(placeId)) throw new Error("place_input_invalid");
  return placeId;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicUrlFor(storagePath: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return `${base}/storage/v1/object/public/${PLACE_MEDIA_BUCKET}/${storagePath}`;
}

/**
 * Upload one photo for a slot and return its stable public URL + path.
 * The public URL is deterministic from the canonical project URL — the
 * storage object and the saved reference can never diverge.
 */
export async function uploadPlacePhoto(params: {
  placeId: string;
  slotKey: string;
  file: File;
}): Promise<{ storagePath: string; url: string }> {
  const placeId = assertPlaceId(params.placeId);
  const ext = fileExtension(params.file.name ?? "", params.file.type);
  const storagePath = `places/${placeId}/${params.slotKey}-${randomSuffix()}.${ext}`;
  const { error } = await createSupabaseServiceClient()
    .storage.from(PLACE_MEDIA_BUCKET)
    .upload(storagePath, params.file, {
      contentType: params.file.type,
      cacheControl: "31536000",
      upsert: false,
    });
  if (error) {
    if (error.message === "Bucket not found") throw new Error("place_media_bucket_missing");
    throw new Error("place_media_upload_failed");
  }
  return { storagePath, url: publicUrlFor(storagePath) };
}

/** Best-effort delete of a replaced/removed object (server-side only). */
export async function removePlacePhotoObject(storagePath: string): Promise<void> {
  await createSupabaseServiceClient().storage.from(PLACE_MEDIA_BUCKET).remove([storagePath]);
}

/** Remove every stored object for a Place (Place deletion cleanup path). */
export async function removePlacePhotoObjects(placeId: string): Promise<void> {
  const placeIdSafe = assertPlaceId(placeId);
  const { data, error } = await createSupabaseServiceClient()
    .storage.from(PLACE_MEDIA_BUCKET)
    .list(`places/${placeIdSafe}`, { limit: 1000 });
  if (error || !data?.length) return;
  await createSupabaseServiceClient()
    .storage.from(PLACE_MEDIA_BUCKET)
    .remove(data.map((object) => `places/${placeIdSafe}/${object.name}`));
}

export type PlacePhotoRow = {
  id: string;
  place_id: string;
  slot_key: string;
  storage_path: string;
  title: string;
  description: string;
  sort_order: number;
};

/** DB row → canonical PlacePhoto reference. */
export function mapPlacePhotoRow(row: PlacePhotoRow): PlacePhoto {
  return {
    id: String(row.id),
    placeId: String(row.place_id),
    slotKey: String(row.slot_key),
    storagePath: String(row.storage_path),
    url: publicUrlFor(String(row.storage_path)),
    title: String(row.title),
    description: String(row.description),
    sortOrder: Number(row.sort_order),
  };
}
