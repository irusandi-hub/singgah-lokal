import "server-only";

import {
  normalizeGeocodeQuery,
  parseGeocodeResponse,
  type GeocodeResult,
} from "@/lib/live/geocoding-core";

export { MAX_GEOCODE_QUERY_LENGTH, normalizeGeocodeQuery } from "@/lib/live/geocoding-core";
export type { GeocodeResult } from "@/lib/live/geocoding-core";

/**
 * Server-only geocoding for the Home location search.
 *
 * The browser NEVER reaches a geocoder directly: the Home search input calls
 * `/api/geocode`, that route calls `geocodeLocation` here, and only the parsed
 * center travels back to the client. `import "server-only"` makes that boundary
 * enforced by the build — any client import of this module fails to compile, so
 * the provider endpoint can never leak into the browser bundle.
 *
 * This module owns exactly two things: the outbound HTTP call and the decision
 * to answer `null`. All input validation and all parsing of the untrusted
 * response live in the pure `geocoding-core.ts` (mirroring the existing
 * `comment-moderation-core.ts` / `comment-moderation.ts` split), so that logic
 * is unit-testable without weakening this boundary.
 *
 * No geocoding provider was vendored into this repository, so instead of adding
 * a dependency (and re-verifying the whole lockfile) this keeps ONE
 * dependency-free HTTP path on the server.
 */

/** A hung public service must never hold a socket open. */
const GEOCODE_TIMEOUT_MS = 5_000;

const GEOCODER_ENDPOINT = "https://nominatim.openstreetmap.org/search";

/**
 * Resolve ONE canonical place center for a free-text query.
 *
 * Returns `null` — never a guess — when the provider is unreachable, answers
 * non-2xx, returns an unparseable body, or returns no usable hit. A `null`
 * result leaves the map exactly where it was; no fallback coordinate is ever
 * invented in any branch.
 */
export async function geocodeLocation(query: string): Promise<GeocodeResult | null> {
  const trimmed = normalizeGeocodeQuery(query);
  if (!trimmed) return null;

  const url = new URL(GEOCODER_ENDPOINT);
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

  return parseGeocodeResponse(payload, trimmed);
}
