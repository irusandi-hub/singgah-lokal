import "server-only";

/**
 * Server-only geocoding for the Home location search.
 *
 * The browser NEVER reaches a geocoder directly: the Home search input calls
 * `/api/geocode`, that route calls `geocodeLocation` here, and only the parsed
 * center travels back to the client. `import "server-only"` makes that boundary
 * enforced by the build — any client import of this module fails to compile,
 * so the provider endpoint can never leak into the browser bundle.
 *
 * No geocoding provider was vendored into this repository, so instead of
 * adding a dependency (and re-verifying the whole lockfile) this keeps ONE
 * dependency-free HTTP path on the server. The only third-party data in play
 * is the public geocoder response, which is treated as untrusted input and
 * validated field by field below.
 *
 * Returned shape (the canonical answer the UI recenters on):
 *   - latitude, longitude   canonical coordinates
 *   - name                  canonical entity name
 *   - displayName           formatted display name
 *   - country, state        optional administrative labels
 *   - confidence            0.0-1.0 quality signal for UI copy
 *
 * This module never touches the locked `web/lib/live/ui.ts` contract
 * (`MapViewport` / `narrowToViewport` / radius presets / curated membership) and
 * never reads or writes Place, Discovery, or Visit Intent data — it resolves a
 * typed string to coordinates and nothing else.
 */

/** Longest query we will forward; a longer one is rejected, never truncated. */
export const MAX_GEOCODE_QUERY_LENGTH = 120;

/** Geocoders are public services: never let a hung request hold a socket open. */
const GEOCODE_TIMEOUT_MS = 5_000;

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  name: string;
  displayName: string;
  country?: string;
  state?: string;
  confidence: number;
};

/**
 * Input validation happens HERE, on the server, before any outbound request
 * (AGENTS.md: validate inputs server-side). An empty or over-long query never
 * reaches the provider, and the trimmed value is what gets sent.
 */
export function normalizeGeocodeQuery(query: unknown): string | null {
  if (typeof query !== "string") return null;
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_GEOCODE_QUERY_LENGTH) return null;
  return trimmed;
}

type NominatimHit = {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  address?: Record<string, unknown> | undefined;
  type?: unknown;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Resolve ONE canonical place center for a free-text query.
 *
 * Returns `null` — never a guess — when the provider is unreachable, answers
 * non-2xx, returns no usable hit, or returns coordinates that are not finite.
 * A `null` result leaves the map exactly where it was; no fallback coordinate
 * is ever invented in any branch.
 */
export async function geocodeLocation(query: string): Promise<GeocodeResult | null> {
  const trimmed = normalizeGeocodeQuery(query);
  if (!trimmed) return null;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", "3");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      // The geocoder must never serve a STALE or cached center for a place the
      // user just searched for.
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
  } catch {
    // Network failure / timeout: no center, no invented coordinate.
    return null;
  }

  if (!response.ok) return null;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(payload)) return null;

  const hits = payload.filter(
    (hit): hit is NominatimHit => typeof hit === "object" && hit !== null,
  );
  if (hits.length === 0) return null;

  // Prefer a settlement-typed hit; anything else is a lower-confidence
  // fallback so the UI never silently empties the Place list for a query the
  // provider did resolve.
  const preferred =
    hits.find((hit) => hit.type === "place" || hit.type === "city") ?? hits[0];

  const latitude = Number.parseFloat(typeof preferred.lat === "string" ? preferred.lat : "");
  const longitude = Number.parseFloat(typeof preferred.lon === "string" ? preferred.lon : "");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const displayName = readString(preferred.display_name) ?? trimmed;
  const [firstSegment] = displayName.split(",");
  const address = preferred.address ?? {};
  const country = readString(address.country);
  const state =
    readString(address.state) ?? readString(address.state_code) ?? readString(address.county);

  return {
    latitude,
    longitude,
    name: displayName,
    displayName: firstSegment?.trim() || displayName,
    ...(country ? { country } : {}),
    ...(state ? { state } : {}),
    confidence: preferred.type === "place" || preferred.type === "city" ? 0.95 : 0.8,
  };
}