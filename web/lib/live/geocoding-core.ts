/**
 * Geocoding core — the PURE half of the Home location search, kept free of
 * "server-only" so the unit tests can execute it directly. The server-only
 * boundary module (`photon.ts`) wraps this and owns the outbound HTTP call;
 * production callers must import from `photon.ts`, never from here.
 *
 * Everything here is defensive because it handles THIRD-PARTY data: the
 * geocoder response is untrusted input and is validated field by field. The
 * governing rule is that a failure returns `null` — the UI then keeps the map
 * exactly where it was. A coordinate is NEVER invented, defaulted, or rounded
 * into existence in any branch.
 */

/** Longest query we will forward; a longer one is rejected, never truncated. */
export const MAX_GEOCODE_QUERY_LENGTH = 120;

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
 * Input validation happens on the server BEFORE any outbound request
 * (AGENTS.md: validate inputs server-side). An empty, over-long, or
 * non-string query never reaches the provider, and the TRIMMED value is what
 * gets sent.
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

/** Settlement-typed hits are the ones a person means when naming a city. */
function isSettlement(type: unknown): boolean {
  return type === "place" || type === "city";
}

/**
 * Turn a raw provider payload into ONE canonical result, or `null`.
 *
 * `fallbackQuery` is the already-validated query; it is used only when the
 * provider omits a display name, so the UI always has something truthful to
 * show. It is never used to synthesize coordinates.
 *
 * Returns `null` for: a non-array payload, no usable hit, or coordinates that
 * are not finite numbers. The coordinate parse is deliberately strict — a
 * missing or garbage `lat`/`lon` yields `null` rather than a partial answer
 * that would silently recenter the map somewhere invented.
 */
export function parseGeocodeResponse(
  payload: unknown,
  fallbackQuery: string,
): GeocodeResult | null {
  if (!Array.isArray(payload)) return null;

  const hits = payload.filter(
    (hit): hit is NominatimHit => typeof hit === "object" && hit !== null,
  );
  if (hits.length === 0) return null;

  // Prefer a settlement-typed hit; anything else is a lower-confidence
  // fallback so the UI never empties the Place list for a query the provider
  // did resolve.
  //
  // DELIBERATE: this selects the FIRST settlement and does NOT fall through to
  // a later hit when that one turns out to be malformed. Falling through could
  // answer "Bandung" with an unrelated POI that happened to carry usable
  // coordinates — a wrong pin on the map, which the user cannot tell is wrong.
  // A malformed preferred hit therefore yields `null` (map stays put), which
  // is the honest outcome and matches the fail-closed rule used throughout
  // this codebase.
  const preferred = hits.find((hit) => isSettlement(hit.type)) ?? hits[0];

  const latitude = Number.parseFloat(typeof preferred.lat === "string" ? preferred.lat : "");
  const longitude = Number.parseFloat(typeof preferred.lon === "string" ? preferred.lon : "");
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const displayName = readString(preferred.display_name) ?? fallbackQuery;
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
    confidence: isSettlement(preferred.type) ? 0.95 : 0.8,
  };
}
