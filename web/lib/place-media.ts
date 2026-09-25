/**
 * PLACE MEDIA — standard photo slots per Place (PO request, 2026-09-25).
 *
 * Files are stored in Supabase Storage (bucket `place-media`); this module
 * owns the canonical slot contract:
 * - 5 standard slots per Place (minimum required by the PO);
 * - every slot carries a title + description following the existing
 *   Production Story content structure (hook → content sections) — no new
 *   content structure;
 * - the slot KEY is fixed by the slot definition, so the reference saved in
 *   `place_photos` (migration 0021) always lands on the correct record;
 * - validation (type + size + count) runs SERVER-SIDE on every write and the
 *   same rules are mirrored client-side for instant feedback.
 * The HTTP-URL input is NOT a media mechanism: remote URLs are never accepted
 * for slot photos (fail-closed against invented/unverifiable media).
 */

export const PLACE_MEDIA_BUCKET = "place-media";

/** Server-side upload limits (fail-closed; mirrored in the client UI). */
export const PLACE_MEDIA_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per photo

export const PLACE_MEDIA_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

export type PlacePhotoSlotKey = "hook" | "process" | "place" | "people" | "product";

export type PlacePhotoSlot = {
  key: PlacePhotoSlotKey;
  /** Locked slot label shown in the Producer form. */
  label: string;
  /** Locked title prompt (Production Story content structure). */
  titlePrompt: string;
  /** Locked description prompt (hook → next content sections). */
  descriptionPrompt: string;
  sortOrder: number;
};

/** The ≥5 standard photo slots, in display order. */
export const PLACE_PHOTO_SLOTS: readonly PlacePhotoSlot[] = [
  {
    key: "hook",
    label: "Hook",
    titlePrompt: "Judul pembuka yang menarik perhatian",
    descriptionPrompt: "Hook: satu kalimat yang membuat orang ingin mengenal tempat ini.",
    sortOrder: 0,
  },
  {
    key: "process",
    label: "Proses Produksi",
    titlePrompt: "Judul bagian proses produksi",
    descriptionPrompt: "Ceritakan bagaimana sesuatu dibuat di tempat ini.",
    sortOrder: 1,
  },
  {
    key: "place",
    label: "Suasana Tempat",
    titlePrompt: "Judul bagian suasana tempat",
    descriptionPrompt: "Tunjukkan suasana dan area utama tempat ini.",
    sortOrder: 2,
  },
  {
    key: "people",
    label: "Orang di Baliknya",
    titlePrompt: "Judul bagian orang di baliknya",
    descriptionPrompt: "Perkenalkan tukang masak / pengrajin / tim di balik produksi.",
    sortOrder: 3,
  },
  {
    key: "product",
    label: "Hasil / Produk",
    titlePrompt: "Judul bagian hasil atau produk",
    descriptionPrompt: "Tampilkan hasil produksi yang bisa dilihat pengunjung.",
    sortOrder: 4,
  },
] as const;

export const PLACE_MEDIA_MIN_SLOTS = 5;

export type PlacePhoto = {
  id: string;
  placeId: string;
  slotKey: string;
  /** Public Storage URL of the saved object — rendered with the Place. */
  url: string;
  storagePath: string;
  title: string;
  description: string;
  sortOrder: number;
};

export class PlaceMediaError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function slotByKey(key: unknown): PlacePhotoSlot {
  const found = PLACE_PHOTO_SLOTS.find((slot) => slot.key === key);
  if (!found) throw new PlaceMediaError("place_photo_slot_invalid");
  return found;
}

/** File-type + size gate (server-side; the UI mirrors it for feedback). */
export function validatePlaceMediaFile(file: { type?: unknown; size?: unknown }): void {
  if (typeof file.type !== "string" || !(PLACE_MEDIA_ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    throw new PlaceMediaError("place_photo_type_invalid");
  }
  if (typeof file.size !== "number" || !Number.isFinite(file.size) || file.size <= 0 || file.size > PLACE_MEDIA_MAX_BYTES) {
    throw new PlaceMediaError("place_photo_size_invalid");
  }
}

/** Title/description gate for one slot (Producer-editable metadata). */
export function validatePlacePhotoMeta(title: unknown, description: unknown): { title: string; description: string } {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 120) {
    throw new PlaceMediaError("place_photo_title_invalid");
  }
  if (typeof description !== "string" || !description.trim() || description.trim().length > 1000) {
    throw new PlaceMediaError("place_photo_description_invalid");
  }
  return { title: title.trim(), description: description.trim() };
}

export function isPlacePhotoSlotKey(key: string): key is PlacePhotoSlotKey {
  return PLACE_PHOTO_SLOTS.some((slot) => slot.key === key);
}

export { slotByKey as getPlacePhotoSlot };
