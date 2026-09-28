import { type PlaceCategory, type PlaceType, validatePlaceInput } from "@/lib/places";
import { isValidPlaceCountry, isValidPlaceRegion } from "@/lib/geo/countries";
import type { PlaceMutation } from "@/lib/place-experience-repository";

const categories: PlaceCategory[] = ["Kopi", "Teh", "Kuliner"];
const types: PlaceType[] = ["production", "experience"];

export class PlaceInputError extends Error {}

function parseCoverImageUrl(value: unknown): string | null {
  // Optional URL; empty/absent clears it. Server-validated (https, bounded).
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new PlaceInputError("place_cover_image_invalid");
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed) || trimmed.length > 2048) {
    throw new PlaceInputError("place_cover_image_invalid");
  }
  return trimmed;
}

export function parsePlaceMutation(raw: unknown, id?: string): PlaceMutation {
  if (!raw || typeof raw !== "object") throw new PlaceInputError("place_input_invalid");
  const body = raw as Record<string, unknown>;
  if ("producerId" in body) throw new PlaceInputError("producer_id_not_allowed");
  const text = (key: string): string => {
    const value = body[key];
    if (typeof value !== "string" || !value.trim()) throw new PlaceInputError("place_required_field_invalid");
    return value.trim();
  };
  const nullableNumber = (key: string, min: number, max: number): number | null => {
    const value = body[key];
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new PlaceInputError("place_coordinates_invalid");
    }
    return value;
  };
  const category = text("category") as PlaceCategory;
  const type = text("type") as PlaceType;
  if (!categories.includes(category) || !types.includes(type)) throw new PlaceInputError("place_type_or_category_invalid");
  // Geography is validated HERE, on the server, for the same reason every
  // other field is: the two dropdowns are a convenience, not the authority.
  // A request that bypasses the form still cannot invent a country, and
  // cannot pair a subdivision with a country that does not contain it.
  const countryCode = text("countryCode").toUpperCase();
  if (!isValidPlaceCountry(countryCode)) throw new PlaceInputError("place_country_invalid");
  const regionName = text("regionName");
  if (!isValidPlaceRegion(countryCode, regionName)) throw new PlaceInputError("place_region_invalid");
  const mutation: PlaceMutation = {
    // An empty/absent id means "the system generates it" (PO, 2026-09-26):
    // the Producer never types a technical ID in the UI. The POST route
    // derives the id from the name and checks uniqueness.
    id: id ?? (typeof body.id === "string" ? body.id.trim() : ""),
    name: text("name"),
    shortDescription: text("shortDescription"),
    category,
    type,
    area: text("area"),
    countryCode,
    regionName,
    address: text("address"),
    contactInformation: typeof body.contactInformation === "string" ? body.contactInformation.trim() : "",
    timezone: text("timezone"),
    currency: text("currency").toUpperCase(),
    latitude: nullableNumber("latitude", -90, 90),
    longitude: nullableNumber("longitude", -180, 180),
    coverImageUrl: parseCoverImageUrl(body.coverImageUrl),
  };
  try {
    // With a system-generated id pending, validate the rest of the payload
    // against a stand-in id (the real id is derived + re-validated in POST).
    validatePlaceInput({ ...mutation, id: mutation.id || "system-generated" });
  } catch {
    throw new PlaceInputError("place_input_invalid");
  }
  return mutation;
}

/**
 * Coordinate → IANA timezone resolution, server-side (PO, 2026-09-28):
 * the Producer no longer chooses a timezone. Coordinates are the source of
 * truth, so the zone is looked up from latitude + longitude where the client
 * cannot reach it, accepted only when the result is a real IANA zone the
 * runtime knows. A failed lookup throws — it never silently keeps or guesses
 * a zone.
 */
const TIMEZONE_LOOKUP_URL = "https://timeapi.io/api/timezone/coordinate";
const IANA_ZONE_PATTERN = /^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+$/;

function isKnownIanaZone(timeZone: string): boolean {
  if (timeZone !== "UTC" && !IANA_ZONE_PATTERN.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export async function resolveTimezoneFromCoordinates(latitude: number, longitude: number): Promise<string> {
  let timeZone = "";
  try {
    const response = await fetch(`${TIMEZONE_LOOKUP_URL}?latitude=${latitude}&longitude=${longitude}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const payload: unknown = await response.json();
      if (payload && typeof payload === "object" && "timeZone" in payload) {
        timeZone = String((payload as { timeZone?: unknown }).timeZone ?? "").trim();
      }
    }
  } catch {
    // Network/timeout failure: fall through to the explicit error below.
  }
  if (!timeZone || !isKnownIanaZone(timeZone)) {
    throw new PlaceInputError("place_timezone_unavailable");
  }
  return timeZone;
}

/**
 * The Producer save path: the shared Place validator, plus the server-owned
 * timezone rule. With coordinates present the IANA zone is resolved from them
 * and any client-sent value is discarded (the client cannot manipulate it).
 * Without coordinates, an existing Place keeps its stored zone (legacy data
 * is never damaged) and a NEW Place fails clearly — there is nothing to
 * resolve from and a default would be a silent lie. The Admin path keeps
 * using parsePlaceMutation directly and is unchanged.
 */
export async function resolvePlaceMutation(
  raw: unknown,
  id?: string,
  options?: { fallbackTimezone?: string | null },
): Promise<PlaceMutation> {
  if (!raw || typeof raw !== "object") throw new PlaceInputError("place_input_invalid");
  const body = raw as Record<string, unknown>;
  // The Producer form sends no timezone at all; tolerate its absence here and
  // let the resolution below decide. An explicit value is still validated by
  // the shared parser before it can ever be stored.
  const normalized = body.timezone === undefined || body.timezone === null || body.timezone === "" ? { ...body, timezone: "UTC" } : body;
  const mutation = parsePlaceMutation(normalized, id);

  if (mutation.latitude !== null && mutation.longitude !== null) {
    mutation.timezone = await resolveTimezoneFromCoordinates(mutation.latitude, mutation.longitude);
    return mutation;
  }

  const fallback = options?.fallbackTimezone?.trim();
  if (fallback && isKnownIanaZone(fallback)) {
    mutation.timezone = fallback;
    return mutation;
  }
  throw new PlaceInputError("place_timezone_unresolved");
}

/**
 * Derives the technical Place id from the Place name (PO, 2026-09-26):
 * latin slug of the name — "Kopi dari Kebun" → "kopi-dari-kebun" — matching
 * the existing id format. A name without latin/digit characters yields ""
 * and the caller falls back to a random id. Uniqueness is checked by the
 * caller against the canonical repository.
 */
export function derivePlaceIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}