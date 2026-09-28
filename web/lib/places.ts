export type PlaceCategory = "Kopi" | "Teh" | "Kuliner";

export type PlaceType = "production" | "experience";

/**
 * "Tempat Pilihan" collections (PO, 2026-09-25). Dapur, Kopi, and Teh are
 * the curated collections of the Tempat Pilihan layer on Home — they are
 * NOT categories of the nearby ("Tempat di sekitar") view and NOT a
 * "lokal" grouping. Each collection label comes from the mockup and maps
 * to the canonical Place category it collects; no new Place category is
 * created and the canonical category values stay untouched.
 */
export type CuratedCollection = {
  key: string;
  label: string;
  category: PlaceCategory;
};

export const CURATED_COLLECTIONS: readonly CuratedCollection[] = [
  { key: "kuliner", label: "Dapur", category: "Kuliner" },
  { key: "kopi", label: "Kopi", category: "Kopi" },
  { key: "teh", label: "Teh", category: "Teh" },
] as const;

export type ClaimStatus = "unverified" | "claimed" | "verified";
export type PublicationStatus = "draft" | "published" | "paused" | "archived";

export type ProducerReference = {
  id: string;
  displayName: string;
};

export type Place = {
  id: string;
  name: string;
  shortDescription: string;
  category: PlaceCategory;
  type: PlaceType;
  area: string;
  address: string;
  contactInformation: string;
  timezone: string;
  currency: string;
  latitude: number | null;
  longitude: number | null;
  // Optional public cover image URL (migration 0018). A URL only — never a
  // storage credential or auth-gated object; read with the Place itself.
  coverImageUrl: string | null;
  producer: ProducerReference | null;
  claimStatus: ClaimStatus;
  publicationStatus: PublicationStatus;
};

const placeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const places: Place[] = [
  {
    id: "kopi-dari-kebun",
    name: "Kopi dari Kebun",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Kopi",
    type: "production",
    area: "Bandung",
    address: "",
    contactInformation: "",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    latitude: null,
    longitude: null,
    coverImageUrl: null,
    producer: null,
    claimStatus: "unverified",
    publicationStatus: "published",
  },
  {
    id: "rumah-teh-lokal",
    name: "Rumah Teh Lokal",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Teh",
    type: "experience",
    area: "Lembang",
    address: "",
    contactInformation: "",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    latitude: null,
    longitude: null,
    coverImageUrl: null,
    producer: null,
    claimStatus: "unverified",
    publicationStatus: "published",
  },
  {
    id: "dapur-rasa",
    name: "Dapur Rasa",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Kuliner",
    type: "production",
    area: "Bandung",
    address: "",
    contactInformation: "",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    latitude: null,
    longitude: null,
    coverImageUrl: null,
    producer: null,
    claimStatus: "unverified",
    publicationStatus: "published",
  },
];

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidCurrency(currency: string): boolean {
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(0);
    return /^[A-Z]{3}$/.test(currency);
  } catch {
    return false;
  }
}

export function validatePlace(place: Place): void {
  if (!place.id || !placeIdPattern.test(place.id)) {
    throw new Error(`Invalid Place id: ${place.id}`);
  }

  if (!place.name.trim() || !place.shortDescription.trim() || !place.area.trim()) {
    throw new Error(`Place ${place.id} is missing required identity fields`);
  }

  if (place.latitude !== null && (!Number.isFinite(place.latitude) || place.latitude < -90 || place.latitude > 90)) {
    throw new Error(`Invalid latitude for Place ${place.id}`);
  }

  if (place.longitude !== null && (!Number.isFinite(place.longitude) || place.longitude < -180 || place.longitude > 180)) {
    throw new Error(`Invalid longitude for Place ${place.id}`);
  }

  if (
    place.coverImageUrl !== null &&
    (!/^https:\/\//i.test(place.coverImageUrl) || place.coverImageUrl.length > 2048)
  ) {
    throw new Error(`Invalid cover image URL for Place ${place.id}`);
  }

  if (!isValidTimezone(place.timezone)) {
    throw new Error(`Invalid timezone for Place ${place.id}`);
  }

  if (!isValidCurrency(place.currency)) {
    throw new Error(`Invalid currency for Place ${place.id}`);
  }
}

export function validatePlaceInput(place: Omit<Place, "producer" | "claimStatus" | "publicationStatus">): void {
  validatePlace({ ...place, producer: null, claimStatus: "unverified", publicationStatus: "draft" });
}

export function isPlacePublicationReady(place: Place): boolean {
  return Boolean(
    place.name.trim() &&
      place.shortDescription.trim() &&
      place.area.trim() &&
      place.address.trim() &&
      place.latitude !== null &&
      place.longitude !== null,
  );
}

export function canTransitionPlaceStatus(current: PublicationStatus, next: PublicationStatus): boolean {
  if (current === next) return true;
  if (current === "archived") return false;
  return {
    draft: ["published", "paused", "archived"],
    published: ["paused", "archived"],
    paused: ["published", "archived"],
  }[current].includes(next);
}

/**
 * Platform Admin publication transitions (Authority Master §5: Admin holds
 * operational authority over Place, moderation, and enforcement).
 *
 * The Producer rule above keeps `archived` terminal and stays unchanged. An
 * Admin may additionally restore an archived Place, because moderation
 * decisions must be reversible when appropriate rather than a one-way door
 * (Master 09 §5 "Moderation decisions should be reversible when appropriate,
 * with a new audit event rather than silent overwriting"; §8 "Restoring
 * publication requires the appropriate authorization and revalidation"), and
 * because an archived Place must stay traceable instead of being deleted
 * (Master 09 §15). Revalidation on restore is enforced by the caller through
 * `isPlacePublicationReady` before a Place may go back to `published`.
 *
 * Every other transition is the shared Producer rule — Admin gets no shortcut
 * around the existing status set (draft / published / paused / archived).
 */
export function canAdminTransitionPlaceStatus(
  current: PublicationStatus,
  next: PublicationStatus,
): boolean {
  if (current === next) return true;
  if (current === "archived") {
    return next === "draft" || next === "paused" || next === "published";
  }
  return canTransitionPlaceStatus(current, next);
}

export function validatePlaces(placeList: readonly Place[]): void {
  const ids = new Set<string>();

  for (const place of placeList) {
    validatePlace(place);

    if (ids.has(place.id)) {
      throw new Error(`Duplicate Place id: ${place.id}`);
    }

    ids.add(place.id);
  }
}

validatePlaces(places);

export function getPlaceById(id: string): Place | undefined {
  return places.find((place) => place.id === id);
}