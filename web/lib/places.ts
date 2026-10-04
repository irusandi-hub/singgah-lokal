export type PlaceCategory = "Sumber Daya Alam" | "Industri & Pengolahan" | "Perdagangan & Jasa";

/**
 * The complete category vocabulary (PO, 2026-09-28). The former Kopi / Teh /
 * Kuliner values are retired everywhere — model, forms, server validator, and
 * the database (migration 0033's `places_category_check`). Any category
 * outside this list is refused on every write.
 */
export const PLACE_CATEGORIES: readonly PlaceCategory[] = [
  "Sumber Daya Alam",
  "Industri & Pengolahan",
  "Perdagangan & Jasa",
] as const;

/**
 * THE STORED PLACE CURRENCY VOCABULARY — the exact values a `places.currency`
 * column may hold.
 *
 * This is the ONE list every write path, the read model, and the Admin currency
 * select are checked against, and it mirrors the database exactly:
 * migration 0033's `places_currency_check` (`IDR`, `USD`) as widened by
 * migration 0039 (`+ SAR`).
 *
 * SAR is in this list for ONE reason, recorded in MASTER DEVELOPER AUTHORITY &
 * DUMMY PLACE v1.0 §7: a Place must always be able to carry an honest currency
 * for its own geography (Master 01: "Currency follows Place") instead of
 * claiming a currency its geography does not have. It admits the value for
 * DEV-only test Places (migration 0040's ten Riyadh fixtures); it does NOT open
 * a new market and does NOT make SAR a currency the platform prices, formats,
 * or offers in its own surfaces — see `APPLICATION_CURRENCIES` below.
 */
export const PLACE_CURRENCIES: readonly PlaceCurrency[] = ["IDR", "USD", "SAR"] as const;

export type PlaceCurrency = "IDR" | "USD" | "SAR";

/**
 * THE APPLICATION CURRENCY VOCABULARY — what SINGGAH LOKAL itself supports
 * (PO, 2026-09-28): Indonesian Rupiah and US Dollar.
 *
 * This is a DIFFERENT rule from `PLACE_CURRENCIES`, and keeping the two apart is
 * the point:
 *  · a stored Place may legitimately carry SAR (Master 01: currency follows the
 *    Place's own geography; Master Developer Authority §7), so the read model
 *    and the Admin editor must be able to load, show, and re-save it;
 *  · the APPLICATION never prices, formats, offers, or accepts SAR: a Producer
 *    can only set IDR or USD on a Place, and nothing in the product formats an
 *    amount in SAR.
 * Prices and tickets stay informational either way (AGENTS.md: no payment,
 * checkout, wallet, escrow, or settlement).
 */
export const APPLICATION_CURRENCIES: readonly ApplicationCurrency[] = ["IDR", "USD"] as const;

export type ApplicationCurrency = "IDR" | "USD";

/**
 * Deterministic, locale-independent labels for every stored currency.
 *
 * These are FIXED strings, never `Intl` output: a Place's currency must read
 * identically on every device, in every locale, forever — no symbol, no
 * separator, and no digit shaping is ever derived from the runtime locale, so
 * the UI can never disagree with the stored code.
 */
export const PLACE_CURRENCY_LABELS: Readonly<Record<PlaceCurrency, string>> = {
  IDR: "IDR — Rupiah Indonesia",
  USD: "USD — Dolar Amerika Serikat",
  SAR: "SAR — Riyal Arab Saudi",
} as const;

/**
 * The label for a stored currency, falling back to the bare code for anything
 * outside the canonical vocabulary. It never throws and never invents a name:
 * an unexpected stored value renders as itself, which is honest and stable.
 */
export function placeCurrencyLabel(currency: string): string {
  return PLACE_CURRENCY_LABELS[currency as PlaceCurrency] ?? currency;
}

/**
 * Whether a currency is one the APPLICATION supports. `SAR` — and every other
 * code outside IDR/USD — is refused here even though it is a legal stored
 * Place currency: the platform never works in it.
 */
export function isApplicationCurrency(value: unknown): value is ApplicationCurrency {
  return typeof value === "string" && (APPLICATION_CURRENCIES as readonly string[]).includes(value);
}

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
  { key: "sda", label: "Sumber Daya Alam", category: "Sumber Daya Alam" },
  { key: "industri", label: "Industri & Pengolahan", category: "Industri & Pengolahan" },
  { key: "jasa", label: "Perdagangan & Jasa", category: "Perdagangan & Jasa" },
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
  // Canonical world geography (PO, 2026-09-28, migration 0032): the ISO
  // 3166-1 alpha-2 country code and the ISO 3166-2 subdivision name. `area`
  // stays exactly as it was — free local area, never a country or a province.
  countryCode: string | null;
  regionName: string | null;
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
  /**
   * Tempat Pilihan layer membership (PO, Stage 3, migration 0035).
   * `true` = the Place belongs to the Admin-promoted "Tempat Pilihan" Home
   * layer. This is LAYER metadata — never a category, never a publication
   * state, never a Discovery input: the canonical Discovery engine
   * (lib/discovery/scoring.ts) is curated-blind and never reads it, so one
   * Place may live in both layers and the layers cannot cancel each other.
   */
  isCurated: boolean;
  /**
   * Dummy Place marker (Master Dummy Place v1.0, migration 0039).
   * `true` = development/test fixture, never a real listing. It is a CANONICAL
   * server-side fact written only through the Creator-controlled Developer
   * Authority path — never inferred from a name or description, and never
   * writable by a Producer, a Platform Admin, or any client.
   */
  isDummy: boolean;
};

const placeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const places: Place[] = [
  {
    id: "kopi-dari-kebun",
    name: "Kopi dari Kebun",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Sumber Daya Alam",
    type: "production",
    area: "Bandung",
    countryCode: "ID",
    regionName: "Jawa Barat",
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
    isCurated: false,
    isDummy: false,
  },
  {
    id: "rumah-teh-lokal",
    name: "Rumah Teh Lokal",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Perdagangan & Jasa",
    type: "experience",
    area: "Lembang",
    countryCode: "ID",
    regionName: "Jawa Barat",
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
    isCurated: false,
    isDummy: false,
  },
  {
    id: "dapur-rasa",
    name: "Dapur Rasa",
    shortDescription: "Temukan cerita dan produksi lokal dari tempat ini.",
    category: "Perdagangan & Jasa",
    type: "production",
    area: "Bandung",
    countryCode: "ID",
    regionName: "Jawa Barat",
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
    isCurated: false,
    isDummy: false,
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

/**
 * Whether a raw category string is inside the canonical vocabulary. The ONE
 * category check: the shared mutation parser (lib/place-management) uses it
 * so both the Admin and Producer write paths refuse a retired category
 * before anything reaches the database CHECK.
 */
export function isValidPlaceCategory(value: string): value is PlaceCategory {
  return (PLACE_CATEGORIES as readonly string[]).includes(value);
}

function isValidCurrency(currency: string): boolean {
  // The STORED vocabulary only — the same list migration 0039's widened
  // `places_currency_check` enforces. Whether the platform may also WORK in
  // that currency is a separate rule: `isApplicationCurrency`.
  return (PLACE_CURRENCIES as readonly string[]).includes(currency);
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

export function validatePlaceInput(
  place: Omit<Place, "producer" | "claimStatus" | "publicationStatus" | "isCurated" | "isDummy">,
): void {
  // `isDummy` is defaulted to false on every PRODUCER-submitted input: the Dummy
  // flag is Creator/Developer-Authority only and is never client-supplied.
  validatePlace({ ...place, producer: null, claimStatus: "unverified", publicationStatus: "draft", isCurated: false, isDummy: false });
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