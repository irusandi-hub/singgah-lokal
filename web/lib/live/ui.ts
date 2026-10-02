/**
 * Home filter bar (PO 2026-09-26, amending the 2026-09-20 locked set):
 * ONE row — LIVE first/leftmost, "Tempat Pilihan", then the distance radii.
 * The smallest legacy radius (500 m, unquoted here by test contract) was
 * removed by explicit PO decision (UI, state, default, and filter logic):
 * the smallest bounded radius is now 1 km. LIVE remains a
 * process/status filter (Places with a live session), not a time or category
 * filter. Time filters and the former geolocation-first filter stay removed.
 */
export type DistanceFilter = "1 km" | "5 km" | "10 km+";

export const DISTANCE_FILTERS: DistanceFilter[] = ["1 km", "5 km", "10 km+"];

export const LIVE_FILTER_LABEL = "LIVE";

export type LiveDiscoveryItem = {
  sessionId: string;
  placeId: string;
  stageId: string;
  startedAt: string;
  viewerPeak: number;
  processTitle?: string;
  placeName?: string;
};

/**
 * HOME FILTER MODES — mutual exclusivity (bug fix 2026-10-01).
 *
 * LIVE and "Tempat Pilihan" are two DIFFERENT result modes over the same
 * dataset, so they may never be active at the same time: the rendered rows,
 * the `aria-pressed` state, and the header badge would otherwise describe a
 * combination that no mode owns. The transition is a pure function so the
 * rule is provable without rendering:
 * - turning LIVE ON always leaves "Tempat Pilihan" (mutual exclusion);
 * - turning LIVE OFF touches NOTHING else — the curated layer and the
 *   distance tab keep whatever they had (no accidental filter change);
 * - activating "Tempat Pilihan" always leaves LIVE. Untoggling it is not
 *   offered: the curated layer is left by choosing a distance tab, exactly
 *   as before.
 * Filter SEMANTICS (which Places each mode shows) are untouched.
 */
export function toggleLiveFilter(
  liveOnly: boolean,
  curatedOnly: boolean,
): { liveOnly: boolean; curatedOnly: boolean } {
  const nextLiveOnly = !liveOnly;
  return {
    liveOnly: nextLiveOnly,
    curatedOnly: nextLiveOnly ? false : curatedOnly,
  };
}

/**
 * Curated-mode activation: LIVE is always switched off. It takes no argument
 * on purpose — activating "Tempat Pilihan" can only ever produce ONE state,
 * whatever was active before, which is what makes the exclusivity total.
 */
export function activateCuratedFilter(): { liveOnly: boolean; curatedOnly: boolean } {
  return { liveOnly: false, curatedOnly: true };
}

/**
 * Anchor ids of the two visible result strips (bug fix 2026-10-01). The
 * header affordance is a SCROLL to the first visible strip, never a route:
 * the MVP has no all-results page (only /places/[id] exists), so inventing
 * one is forbidden. Ids are unique per strip so the target always exists.
 */
export const CURATED_RESULTS_ANCHOR_ID = "home-curated-results";
export const DISCOVERY_RESULTS_ANCHOR_ID = "home-discovery-results";

/**
 * Which strip the header link may scroll to, in priority order: the curated
 * strip while the Tempat Pilihan mode is active AND has results, otherwise
 * the Discovery strip when it has results. Returns null when NO strip is
 * rendered, so the caller can render a non-navigating label instead of a
 * dead anchor that would jump nowhere.
 */
export function resolveResultsAnchorId(input: {
  curatedOnly: boolean;
  curatedCount: number;
  discoveryCount: number;
}): string | null {
  if (input.curatedOnly && input.curatedCount > 0) return CURATED_RESULTS_ANCHOR_ID;
  if (input.discoveryCount > 0) return DISCOVERY_RESULTS_ANCHOR_ID;
  return null;
}

/**
 * VIEWPORT STATUS REPORTING (bug fix 2026-10-01).
 *
 * `last` is the last REPORTED status, and `null` means "nothing reported
 * yet". The first evaluation must always report — including an empty
 * viewport — so the Home overlay can appear on map readiness without the
 * user moving the map first. Previously the ref started at `false`, which
 * silently swallowed the first report whenever the viewport really was
 * empty. After the first report the comparison is a plain change check, so
 * repeated moveend/zoomend/resize/marker events stay deduped.
 */
export function shouldReportViewportStatus(last: boolean | null, hasPlaces: boolean): boolean {
  return last === null || hasPlaces !== last;
}

/**
 * Distance radius mapping (MASTER_LIVE_POLICY §12.5, MASTER_LIVE_TECH §9) —
 * the locked radius VALUES behind the Home distance tabs.
 *
 * SUPERSEDED as a Home list gate (product decision, 2026-10-01): the Home
 * Place rows and the map markers are now narrowed by the REAL Leaflet
 * viewport (see MapViewport / narrowToViewport), so 1 km / 5 km / 10 km+ no
 * longer decide which Places are listed. The tab radii remain locked as the
 * CAMERA presets (CAMERA_PRESET_RADIUS_M) and this mapping stays the single
 * declaration of those radius values:
 * - Bounded radii match Places whose canonical lat/lng is within the radius;
 *   "10 km+" is unbounded.
 * - A Place without canonical coordinates stays visible only under the
 *   unbounded filter — bounded radii never hide results by assumption.
 */
export const DISTANCE_FILTER_RADIUS_M: Record<DistanceFilter, number | null> = {
  "1 km": 1000,
  "5 km": 5000,
  "10 km+": null,
};

/**
 * "Tempat Pilihan" camera coverage (PO, 2026-09-29; amended by the product
 * decision of 2026-09-30): the curated layer frames the SAME 10 km coverage
 * as the "10 km+" tab around the real Current Location — the old 50 km frame
 * is retired. This is a CAMERA value ONLY: it never decides curated
 * membership and never filters the Place list.
 */
export const CURATED_CAMERA_RADIUS_M = 10_000;

/**
 * VIEWPORT AS THE GEOGRAPHIC COVERAGE SOURCE (product decision, 2026-10-01).
 *
 * The Leaflet viewport — the area the user can actually SEE — is the ONE
 * geographic coverage source for the Home map markers and for the Discovery
 * Place row + the "Tempat Pilihan" row. A fixed radius preset (1 km / 5 km /
 * 10 km+) is a CAMERA frame only; it can no longer decide which Places are
 * listed. Viewport narrowing can only REMOVE an entry from the canonical
 * result: it never adds a Place, never re-orders one, and never makes an
 * ineligible Place eligible.
 *
 * `MapViewport` is the plain, serializable shape the map reports (Leaflet's
 * LatLngBounds, flattened — no Leaflet type crosses this boundary, so the
 * rule stays unit-testable in plain Node).
 */
export type MapViewport = { north: number; south: number; east: number; west: number };

/**
 * Bounds equality — the report dedup. Panning inside one degree changes
 * nothing visible in the list, and a fresh object identity on every
 * moveend would re-render the Home rows for no reason. Equality is exact on
 * purpose: Leaflet reports stable values for a settled viewport, and any real
 * change must propagate.
 */
export function isSameViewport(a: MapViewport | null, b: MapViewport | null): boolean {
  if (a === null || b === null) return a === b;
  return a.north === b.north && a.south === b.south && a.east === b.east && a.west === b.west;
}

/**
 * Is a canonical coordinate inside the reported viewport?
 *
 * - Fail-closed on non-finite coordinates: a Place without real coordinates
 *   is never inside a viewport, never gets a marker, and never gets a
 *   position invented for it.
 * - Antimeridian-safe: when the viewport wraps (west > east — panning across
 *   the ±180 line, which Leaflet can report), longitude membership becomes
 *   ">= west OR <= east" instead of a broken empty range.
 */
export function isWithinViewport(viewport: MapViewport, latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude < viewport.south || latitude > viewport.north) return false;
  return viewport.west <= viewport.east
    ? longitude >= viewport.west && longitude <= viewport.east
    : longitude >= viewport.west || longitude <= viewport.east;
}

/**
 * Narrow a canonical, ordered result to the visible viewport. The input
 * order is preserved exactly (canonical ranking order is never re-sorted),
 * and a Place is only ever removed, never added.
 *
 * A viewport that has not been reported yet (`null`) narrows NOTHING: before
 * Leaflet is ready the full canonical result still renders, so the first
 * paint can never show an empty list. A Place without canonical coordinates
 * is dropped regardless — it has no position to be visible at.
 */
export function narrowToViewport<T extends { latitude: number | null; longitude: number | null }>(
  places: readonly T[],
  viewport: MapViewport | null,
): T[] {
  if (viewport === null) return places.filter((place) => place.latitude !== null && place.longitude !== null);
  return places.filter(
    (place) =>
      place.latitude !== null &&
      place.longitude !== null &&
      isWithinViewport(viewport, place.latitude, place.longitude),
  );
}

/**
 * Distance-tab CAMERA presets (PO, 2026-09-29 — amending the "10 km+ is
 * unbounded" camera behavior; 10 km+ coverage set to exactly 10 km by the
 * product decision of 2026-09-30): EVERY distance tab drives ONE deterministic
 * camera mechanism — the map frame covers this radius around the real Current
 * Location. The distance-tab radii stay strictly ordered
 * 1 km < 5 km < 10 km+, so the derived zoom levels are strictly ordered the
 * opposite way — independent of the current zoom. Choosing a tab moves the
 * CAMERA only: it never filters the map dataset or the Place rows, which
 * follow the viewport (product decision, 2026-10-01). "Tempat Pilihan" and
 * "Lokasi Saya" deliberately share the widest 10 km coverage, so their zoom
 * matches the "10 km+" tab by construction. CAMERA-ONLY values: they never
 * filter the map dataset (the Place-list proximity gate keeps its own mapping
 * in DISTANCE_FILTER_RADIUS_M).
 */
export const CAMERA_PRESET_RADIUS_M: Record<DistanceFilter, number> = {
  "1 km": 1_000,
  "5 km": 5_000,
  "10 km+": 10_000,
};

export function distanceMeters(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const R = 6371000;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export function matchesDistance(
  filter: DistanceFilter,
  viewerPosition: { lat: number; lng: number } | null,
  placePosition: { lat: number; lng: number } | null,
): boolean {
  const radius = DISTANCE_FILTER_RADIUS_M[filter];
  if (radius === null) return true;
  if (!viewerPosition || !placePosition) return false;
  return distanceMeters(viewerPosition, placePosition) <= radius;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1).replace(".", ",")} km`;
}

// ---------------------------------------------------------------------------
// ACTIVE SEARCH CENTER — the single source of truth (bug fix 2026-10-02)
// ---------------------------------------------------------------------------

/**
 * Home has TWO mutually exclusive ways to know "where am I looking from": a
 * city the user searched for, and the device's own fix. This is the ONE place
 * that decides which of the two is active, so the camera, the viewport
 * coverage, the distance labels, and the radius presets can no longer each
 * read a different coordinate and disagree with the user.
 *
 * Before this existed, the coverage filter used the searched city while BOTH
 * distance labels measured from the device fix — so searching "Riyadh" from
 * Dammam admitted Places into the list and then labelled them "399 km", which
 * is exactly the self-contradiction users reported.
 *
 * Fail-closed: a non-finite coordinate is treated as absent, and when NEITHER
 * source is usable the active center is `null`. No fallback point is ever
 * invented, and the caller renders no distance at all rather than a guess.
 */
export type SearchMode = "device_location" | "city_search";

export type ActiveCenter = { lat: number; lng: number };

export function isUsableCenter(value: ActiveCenter | null | undefined): value is ActiveCenter {
  return (
    !!value && Number.isFinite(value.lat) && Number.isFinite(value.lng)
  );
}

export function resolveActiveCenter(input: {
  searchCenter: ActiveCenter | null;
  viewerPosition: ActiveCenter | null;
}): { mode: SearchMode; center: ActiveCenter | null } {
  if (isUsableCenter(input.searchCenter)) {
    return { mode: "city_search", center: input.searchCenter };
  }
  if (isUsableCenter(input.viewerPosition)) {
    return { mode: "device_location", center: input.viewerPosition };
  }
  return { mode: "device_location", center: null };
}

/**
 * The whole city-search state, so "Lokasi Saya" can drop it ATOMICALLY.
 *
 * Returning one value (rather than four separate setters) is what guarantees
 * the UI can never render a half-cleared state — a frame where the camera is
 * back on the device but the rows are still narrowed to the old city, or where
 * the query text is gone but its center still owns the viewport.
 */
export type CitySearchState = {
  query: string;
  pending: boolean;
  error: string | null;
  center: ActiveCenter | null;
  /**
   * The RESOLVED place name the server geocoder returned for the center.
   *
   * It is carried here (not left behind in a separate piece of state) so the
   * reset can never leave a stale city name describing a center that is gone —
   * the radius caption would keep saying "Riyadh" while the map and the
   * results had already moved to the device. It is the server's answer, never
   * the raw text the user typed, so the caption never shows a guessed name.
   */
  placeName: string | null;
};

/**
 * Drop the city search entirely and hand the active center back to the device.
 *
 * Clearing the TYPED query is deliberate: leaving "Riyadh" in the box would
 * keep it as a live text filter over Place names, so the Home list would stay
 * filtered to Riyadh even after the center returned to the device. It also
 * removes the "Area pencarian: …" status line, which must stop describing the
 * abandoned city.
 */
export function clearCitySearch(): CitySearchState {
  return { query: "", pending: false, error: null, center: null, placeName: null };
}

/** Neutral, always-accurate fallback when no resolved city name is known. */
export const NEUTRAL_SEARCH_AREA_LABEL = "pusat area pencarian";

/**
 * Radius caption for the map coverage box (bug fix 2026-10-03).
 *
 * The caption used to be a fixed "dari lokasi Anda" while the map and the
 * results were centered on a SEARCHED city — so a Riyadh result set was
 * labelled as if it were measured from the device. The caption now names the
 * origin that is actually doing the measuring, which is the same active center
 * the coverage filter and the distance labels use.
 *
 * `placeName` is the geocoder's RESOLVED name. When it is absent the caption
 * falls back to a neutral phrase rather than echoing typed text or inventing a
 * location name, so it can never claim a city the search did not resolve.
 */
export function describeRadiusOrigin(input: {
  radiusLabel: string;
  mode: SearchMode;
  placeName: string | null;
}): string {
  if (input.mode === "city_search") {
    const name = typeof input.placeName === "string" ? input.placeName.trim() : "";
    // The neutral label is a COMPLETE phrase on its own — it must not be
    // appended after "dari pusat pencarian", which would read as
    // "dari pusat pencarian pusat area pencarian".
    const origin = name ? `pusat pencarian ${name}` : NEUTRAL_SEARCH_AREA_LABEL;
    return `Menampilkan tempat dalam radius ${input.radiusLabel} dari ${origin}`;
  }
  return `Menampilkan tempat dalam radius ${input.radiusLabel} dari lokasi Anda`;
}

/**
 * May this response still be applied? (bug fix 2026-10-02)
 *
 * Two independent guards, because they catch different races:
 * - the EPOCH guard rejects a response that was superseded by a LATER intent
 *   (the user pressed "Lokasi Saya" after this request went out), which the
 *   query-string guard alone cannot see — the text is still "Riyadh" in both
 *   cases;
 * - the QUERY guard rejects a slow earlier response for a query the user has
 *   since replaced.
 *
 * Either failure means the answer is stale and must never reach state.
 */
export function acceptSearchResponse(input: {
  requestEpoch: number;
  currentEpoch: number;
  submitted: string;
  activeQuery: string;
}): boolean {
  if (input.requestEpoch !== input.currentEpoch) return false;
  return input.submitted === input.activeQuery;
}

export function liveDurationLabel(startedAt: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60000));
  if (minutes < 60) return `${minutes} menit`;
  return "60 menit";
}

/**
 * Direction (PO 2026-09-26): the maps-navigation target for a Place card,
 * built ONLY from the Place's real canonical coordinates — never a fallback
 * point, never an edited database value. A Place without finite coordinates
 * returns null and the card renders a safe disabled control instead
 * (fail-closed, AGENTS.md: no invented data). Universal Google Maps
 * directions URL: no dependency, works on Android/iOS/desktop (HP-first).
 */
export function buildDirectionsUrl(place: { latitude: number | null; longitude: number | null }): string | null {
  if (place.latitude === null || place.longitude === null) return null;
  if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${place.latitude},${place.longitude}`;
}

/**
 * Nested-action guard (PO 2026-09-26): the Direction and LIVE controls live
 * INSIDE the card link (VisitedLink anchor). They must never trigger the
 * parent card's navigation — the synthetic event is stopped before it can
 * reach the anchor's Next Link handler. Structural event type keeps this
 * module dependency-free and unit-testable in plain Node.
 */
export function stopNestedCardAction(event: { preventDefault(): void; stopPropagation(): void }): void {
  event.preventDefault();
  event.stopPropagation();
}
