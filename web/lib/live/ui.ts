/**
 * Home filter bar (locked, PO decision 2026-09-20, Policy §12.5 #1):
 * LIVE first/leftmost, then distance radii only. LIVE is a process/status
 * filter (Places with a live session), not a time or category filter.
 * Time filters and the former geolocation-first filter are removed from
 * the Home bar by explicit product decision.
 */
export type DistanceFilter = "500 m" | "1 km" | "5 km" | "10 km+";

export const DISTANCE_FILTERS: DistanceFilter[] = ["500 m", "1 km", "5 km", "10 km+"];

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
 * Distance filter semantics (MASTER_LIVE_POLICY §9 amended §12.5, MASTER_LIVE_TECH §9):
 * - Bounded radii match Places whose canonical lat/lng is within the radius;
 *   "10 km+" is unbounded.
 * - A Place without canonical coordinates stays visible only under the
 *   unbounded filter — bounded radii never hide results by assumption.
 */
export const DISTANCE_FILTER_RADIUS_M: Record<DistanceFilter, number | null> = {
  "500 m": 500,
  "1 km": 1000,
  "5 km": 5000,
  "10 km+": null,
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
