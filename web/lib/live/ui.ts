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
 * Distance LIST-filter semantics (MASTER_LIVE_POLICY §9 amended §12.5,
 * MASTER_LIVE_TECH §9) — the Place LIST below the map keeps its existing
 * proximity contract:
 * - Bounded radii match Places whose canonical lat/lng is within the radius;
 *   "10 km+" is unbounded.
 * - A Place without canonical coordinates stays visible only under the
 *   unbounded filter — bounded radii never hide results by assumption.
 * The MAP camera does not use this mapping — see CAMERA_PRESET_RADIUS_M.
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
 * "Tempat Pilihan" MAP-DATASET coverage (PO, 2026-09-30): on the curated map
 * the normal, NON-curated published Places shown are exactly those within
 * this radius of the real Current Location. This is a DATASET/COVERAGE value,
 * deliberately NOT a filter: it never changes curated membership (canonical
 * `places.is_curated` only), never adds a Place to the curated LIST, and is
 * never used as a Discovery signal. With no real Current Location fix there
 * is no coverage to measure, so the curated map shows every published Place
 * with canonical coordinates (display only — membership is unchanged).
 */
export const CURATED_MAP_COVERAGE_RADIUS_M = 10_000;

/**
 * "Lokasi Saya" CURRENT-LOCATION camera coverage (PO, 2026-09-29; amended by
 * the product decision of 2026-09-30): the EXPLICIT "Lokasi Saya" action
 * centers on the REAL browser fix and frames the SAME 10 km coverage as the
 * "10 km+" tab and "Tempat Pilihan". It is a CAMERA-ONLY value for that ONE
 * action: it never filters the map dataset, never replaces the 1 km / 5 km /
 * 10 km+ LIST filters, never changes the selected distance tab, is not a
 * Discovery or curated signal, and never invents a position.
 */
export const CURRENT_LOCATION_CAMERA_RADIUS_M = 10_000;

/**
 * Distance-tab CAMERA presets (PO, 2026-09-29 — amending the "10 km+ is
 * unbounded" camera behavior; 10 km+ coverage set to exactly 10 km by the
 * product decision of 2026-09-30): EVERY distance tab drives ONE deterministic
 * camera mechanism — the map frame covers this radius around the real Current
 * Location. The distance-tab radii stay strictly ordered
 * 1 km < 5 km < 10 km+, so the derived zoom levels are strictly ordered the
 * opposite way — independent of the current zoom. "Tempat Pilihan" and
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
