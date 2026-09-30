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
 * "Tempat Pilihan" camera coverage (PO, 2026-09-29): when the curated layer
 * is active the map zooms so its frame ideally covers a 50 km radius around
 * the real Current Location. This is a CAMERA value only — the curated layer
 * still shows ALL published Places and never filters by this radius.
 */
export const CURATED_CAMERA_RADIUS_M = 50_000;

/**
 * "Lokasi Saya" CURRENT-LOCATION camera coverage (PO, 2026-09-30): the
 * EXPLICIT "Lokasi Saya" action centers on the REAL browser fix and zooms
 * the frame out to this deterministic 15 km radius — one level wider than
 * the widest distance tab (10 km+ = 12 km) so the user sees their area at a
 * glance. It is a CAMERA-ONLY value for that ONE action: it never filters the
 * map dataset, never replaces the 1 km / 5 km / 10 km+ LIST filters, never
 * changes the selected distance tab, is not a Discovery or curated signal,
 * and never invents a position. Choosing a tab (including "Tempat Pilihan")
 * still applies that tab's own preset through CAMERA_PRESET_RADIUS_M /
 * CURATED_CAMERA_RADIUS_M.
 */
export const CURRENT_LOCATION_CAMERA_RADIUS_M = 15_000;

/**
 * Distance-tab CAMERA presets (PO, 2026-09-29 — amending the "10 km+ is
 * unbounded" camera behavior): EVERY distance tab drives ONE deterministic
 * camera mechanism — the map frame covers this radius around the real
 * Current Location. The coverage radii are strictly ordered
 * 1 km < 5 km < 10 km+ (< curated 50 km), so the derived zoom levels are
 * strictly ordered the opposite way — independent of the current zoom.
 * CAMERA-ONLY values: they never filter the map dataset (the Place-list
 * proximity gate keeps its own mapping in DISTANCE_FILTER_RADIUS_M).
 */
export const CAMERA_PRESET_RADIUS_M: Record<DistanceFilter, number> = {
  "1 km": 1_000,
  "5 km": 5_000,
  "10 km+": 12_000,
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
