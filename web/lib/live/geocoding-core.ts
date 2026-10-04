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
  /**
   * The CANONICAL BOUNDING BOX the provider published for the chosen hit, in
   * the same `{ north, south, east, west }` shape the map viewport uses, or
   * `null` when the provider returned no usable area for it.
   *
   * This is the searched AREA, straight from the geocoder that resolved the
   * name — it is never a radius this application guessed, and it is never
   * fabricated. A city therefore covers its whole published extent instead of
   * a few kilometres around its centre point.
   */
  bounds: GeocodeBounds | null;
};

/** A canonical geographic box: the shape every coverage filter already reads. */
export type GeocodeBounds = { north: number; south: number; east: number; west: number };

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

/**
 * Identity this application presents to the public Nominatim endpoint.
 *
 * Nominatim's usage policy REQUIRES a descriptive `User-Agent` that identifies
 * the calling application. It is not decoration: a request sent without one is
 * answered with `403 Access denied`, so a server-runtime fetch (which ships no
 * identifying User-Agent of its own) is refused outright. Omitting this is what
 * made the Home location search unreachable, not a rate limit or an IP ban.
 */
export const NOMINATIM_APP_ID = "SinggahLokal/0.1";

/** Public project home, used as the contact when no override is configured. */
export const NOMINATIM_DEFAULT_CONTACT = "https://github.com/irusandi-hub/singgah-lokal";

/**
 * Build the `User-Agent` value identifying this app to the geocoder.
 *
 * A configured contact (URL or email the operators can reach) is preferred;
 * otherwise the public project home is used, so the header is ALWAYS populated
 * and the geocoder works with no configuration at all. A blank/whitespace-only
 * contact falls back rather than producing an unidentifying header.
 *
 * Control characters are stripped from the contact so it can never terminate
 * the header line and append extra headers to the outbound geocode request.
 */
export function buildGeocoderUserAgent(contact?: string | null): string {
  const configured =
    typeof contact === "string" ? contact.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
  return `${NOMINATIM_APP_ID} (+${configured || NOMINATIM_DEFAULT_CONTACT})`;
}

type NominatimHit = {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  address?: Record<string, unknown> | undefined;
  type?: unknown;
  /**
   * The provider's own administrative bounding box for the hit, as the string
   * quad `[south, north, west, east]`. It is the canonical searched AREA and
   * is validated by `parseGeocodeBounds`; an unusable one yields `null`, never
   * a substitute.
   */
  boundingbox?: unknown;
};

/**
 * Read the provider's canonical bounding box for a hit, or `null`.
 *
 * This is what makes a city search cover the city. The alternative — a small
 * window around the centre coordinate — is a guess about how big a place is,
 * and it silently excluded every Place on the far side of a large city; there
 * is no fixed radius that is correct for both a district and Riyadh, so none is
 * invented here.
 *
 * Fail-closed, like every other parse in this file: a missing quad, a
 * non-numeric entry, a zero-area or inverted box, or a value outside the legal
 * coordinate range all yield `null`, and the caller then keeps its documented
 * narrower behaviour rather than inventing an area. A reversed pair is
 * repaired rather than rejected — the provider's own ordering is data, not a
 * semantic — but a genuinely empty box is not usable as an area.
 */
export function parseGeocodeBounds(boundingBox: unknown): GeocodeBounds | null {
  if (!Array.isArray(boundingBox) || boundingBox.length !== 4) return null;
  const values = boundingBox.map((value) =>
    Number.parseFloat(typeof value === "string" ? value : ""),
  );
  if (!values.every((value) => Number.isFinite(value))) return null;
  let [south, north, west, east] = values;
  if (south > north) [south, north] = [north, south];
  if (west > east) [west, east] = [east, west];
  if (north <= south || east <= west) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { north, south, east, west };
}

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
    // The searched AREA, from the provider. The coordinate pair above is only
    // the centre of it: it is what the camera falls back to when this is null.
    bounds: parseGeocodeBounds(preferred.boundingbox),
  };
}
