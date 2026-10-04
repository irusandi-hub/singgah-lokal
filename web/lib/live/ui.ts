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

// ---------------------------------------------------------------------------
// HOME TAB EXCLUSIVITY
// ---------------------------------------------------------------------------
/*
 * The "Semua Tempat" all-Places tab (and its `allPlacesOnly` flag, its
 * activation helper, and the all-Places pin-label layout below) was REMOVED
 * on 2026-10-04: the approved Home/Map mockup has no such tab, and the
 * approved product flow defines no other entry point for it. Removing the tab
 * therefore removed the whole mode with it — one unreachable state flag, not a
 * second way to reach an existing dataset. The other two place-set rules are
 * untouched: LIVE and "Tempat Pilihan" stay mutually exclusive exactly as
 * `toggleLiveFilter` / `activateCuratedFilter` define them, and a distance
 * preset still leaves the curated layer.
 */

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
 *
 * SUPERSEDED as the "Tempat Pilihan" camera FRAME (product decision,
 * 2026-10-03): choosing the curated tab now fits the camera to the SPREAD of
 * the relevant Places' canonical coordinates, so an outlying Place can never
 * be missed just because it sat outside a fixed 10 km frame. The value stays
 * as the curated DISPLAY radius (the coverage caption + scale that mirror the
 * active mode) and as the radius prop Home hands the map; it is no longer the
 * curated camera's frame. See AUTO-FIT CAMERA COVERAGE below.
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
/**
 * Normalize the searched AREA a geocode answer carried, or `null`.
 *
 * The server already validated the provider's bounding box; this is the
 * client-side half of the same rule, so an untrusted JSON body can never hand
 * the coverage filter a reversed, empty, non-finite, or out-of-range box — the
 * failure modes that would either exclude everything or include everything.
 *
 * Fail-closed by design: anything unusable yields `null`, and the caller then
 * uses its documented narrower fallback rather than inventing an area. No
 * radius is ever guessed from the centre coordinate here — a fixed window is
 * wrong for a district and wrong for Riyadh alike, which is exactly the bug
 * this replaces.
 */
export function normalizeSearchArea(bounds: unknown): MapViewport | null {
  if (typeof bounds !== "object" || bounds === null) return null;
  const candidate = bounds as Partial<MapViewport>;
  const values = [candidate.north, candidate.south, candidate.east, candidate.west].map((value) =>
    Number(value),
  );
  if (!values.every((value) => Number.isFinite(value))) return null;
  const [north, south, east, west] = values;
  if (north <= south || east <= west) return null;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { north, south, east, west };
}

/**
 * The fallback searched area when a geocode answer published no usable box:
 * the same small ±0.05° window around the resolved centre the search has
 * always used before Leaflet reports its own bounds.
 *
 * This is a LAST RESORT for a provider answer that carries no boundary, not a
 * model of how large a place is — the canonical box is used whenever the
 * geocoder publishes one. It exists to keep one gap deterministic, exactly as
 * it did before, and it is released as soon as the real viewport is reported.
 */
export const SEARCH_AREA_FALLBACK_DEGREES = 0.05;

export function fallbackSearchArea(center: { lat: number; lng: number }): MapViewport {
  return {
    north: center.lat + SEARCH_AREA_FALLBACK_DEGREES,
    south: center.lat - SEARCH_AREA_FALLBACK_DEGREES,
    east: center.lng + SEARCH_AREA_FALLBACK_DEGREES,
    west: center.lng - SEARCH_AREA_FALLBACK_DEGREES,
  };
}

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

// ---------------------------------------------------------------------------
// AUTO-FIT CAMERA COVERAGE (product decision, 2026-10-03)
// ---------------------------------------------------------------------------

/**
 * THE CAMERA FITS THE PLACE SPREAD — superseding the fixed curated 10 km frame.
 *
 * Root cause this replaces: "Tempat Pilihan" and a city search both framed the
 * camera from a RADIUS around one point (the 10 km `CURATED_CAMERA_RADIUS_M`
 * preset, or the geocoder's city center), so Places on the edge of the region
 * were never on screen — the list was narrowed by the viewport and the
 * outlying Places were simply missing until the user zoomed out by hand.
 *
 * The camera now derives its coverage from the SPREAD of the relevant Places'
 * canonical coordinates. Every value below stays a pure function over canonical
 * data so the rule is unit-testable in plain Node, exactly like the viewport
 * rules above:
 * - `collectGeoPoints` keeps only finite canonical coordinates — a Place
 *   without real coordinates can never pull the camera (fail-closed, no
 *   invented position, AGENTS.md);
 * - `boundsOfPoints` returns `null` for ZERO Points, so an empty dataset can
 *   never be turned into a coordinate;
 * - `resolveCameraFitPadding` reserves the floating chrome (header, search
 *   bar, filter row) and the map controls (re-center, "Lokasi Saya", +/−,
 *   coverage box, scale) so a fitted frame is never hidden underneath them.
 *
 * The padding is expressed as a SHARE of the real container size as well as an
 * absolute cap: on a short mobile map the reserved chrome must never eat the
 * whole viewport, which is what makes the same numbers safe at 360 px and at
 * 1280 px without a second, hard-coded mobile table.
 */

/** A canonical Place coordinate — only ever a real, finite lat/lng pair. */
export type GeoPoint = { lat: number; lng: number };

/** Canonical Place coordinates for the camera, fail-closed on non-finite values. */
export function collectGeoPoints<T extends { latitude: number | null; longitude: number | null }>(
  places: readonly T[],
): GeoPoint[] {
  const points: GeoPoint[] = [];
  for (const place of places) {
    if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
    points.push({ lat: place.latitude as number, lng: place.longitude as number });
  }
  return points;
}

/**
 * The bounding box of a point set, or `null` when there is NO point.
 *
 * `null` is the whole point: "no Place has valid coordinates" must leave the
 * camera exactly where it is (or on the search center), never zoom to a
 * fabricated or default box. One Point yields a degenerate (single-coordinate)
 * box, which the camera handles as a plain focus rather than a fit.
 */
export function boundsOfPoints(points: readonly GeoPoint[]): MapViewport | null {
  if (points.length === 0) return null;
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
    if (point.lat > north) north = point.lat;
    if (point.lat < south) south = point.lat;
    if (point.lng > east) east = point.lng;
    if (point.lng < west) west = point.lng;
  }
  // Every input was non-finite: treated exactly like an empty set.
  if (north < south || east < west) return null;
  return { north, south, east, west };
}

/**
 * Reserved camera padding in CSS pixels, matching the Home layout ladder:
 * header + search bar + filter row at the top, the right-hand control column
 * (re-center, "Lokasi Saya", and the +/− stack below it) on the right, and
 * the coverage box + scale at the bottom. Left is only the natural map inset.
 */
export const CAMERA_FIT_PADDING = {
  top: 190,
  right: 76,
  bottom: 84,
  left: 24,
} as const;

/**
 * Clamp the reserved padding to the REAL container size.
 *
 * An absolute padding is only safe while the map is big enough to hold it:
 * a 42 vh map on a short phone must not reserve more chrome than it has
 * pixels, or the fitted frame would collapse. Every side is therefore capped
 * at a share of the measured size, and the two vertical reserves together can
 * never exceed 70% of the height.
 */
export function resolveCameraFitPadding(size: { x: number; y: number }): {
  paddingTopLeft: [number, number];
  paddingBottomRight: [number, number];
} {
  const width = Number.isFinite(size.x) && size.x > 0 ? size.x : 0;
  const height = Number.isFinite(size.y) && size.y > 0 ? size.y : 0;
  // An unmeasured container reserves nothing — Leaflet's own fit then has the
  // full box, and the real size arrives with the next resize report.
  if (width === 0 || height === 0) {
    return { paddingTopLeft: [0, 0], paddingBottomRight: [0, 0] };
  }
  let top = Math.min(CAMERA_FIT_PADDING.top, Math.floor(height * 0.45));
  let bottom = Math.min(CAMERA_FIT_PADDING.bottom, Math.floor(height * 0.3));
  if (top + bottom > height * 0.7) {
    const scale = (height * 0.7) / (top + bottom);
    top = Math.floor(top * scale);
    bottom = Math.floor(bottom * scale);
  }
  return {
    paddingTopLeft: [Math.min(CAMERA_FIT_PADDING.left, Math.floor(width * 0.1)), top],
    paddingBottomRight: [Math.min(CAMERA_FIT_PADDING.right, Math.floor(width * 0.25)), bottom],
  };
}

/**
 * FOCUS ZOOM FOR A SINGLE PLACE (product decision, 2026-10-03).
 *
 * One Place has no spread to fit, and `fitBounds` on a degenerate box would
 * jump to the map's maximum zoom. It is therefore focused directly on the
 * canonical coordinate at the same close floor "Lokasi Saya" uses.
 */
export const FIT_SINGLE_PLACE_ZOOM = 15;

/**
 * THE INITIAL EXPLORATION SET FOR "LOKASI SAYA" (2026-10-05).
 *
 * ROOT CAUSE this fixes: `resolveLocalAreaCoverage` resolves the viewer's own
 * trusted geography, and when that geography holds a SINGLE canonical Place it
 * legitimately returns just that one. The locate fit then had two points — that
 * one Place and the user's own coordinate — which are usually metres apart, so
 * `fitBounds` produced a frame a few hundred metres across at the close zoom
 * floor. The result was exactly what the product does not want: "Lokasi Saya"
 * framed a single nearest pin while other relevant Places sat just outside the
 * screen, and no amount of panning recovered the intended exploration area.
 *
 * THE CORRECTION reuses the rule that was ALREADY approved and is already on
 * screen — the ACTIVE distance preset (`CAMERA_PRESET_RADIUS_M`, 1 km by
 * default). That radius is the user's own stated exploration scope, so widening
 * to it introduces NO new radius, NO fixed zoom, and NO new geographic rule; it
 * only stops the frame from being tighter than the exploration area the user
 * already selected.
 *
 * Rules:
 *  · the local-area selection is ALWAYS kept, and is never replaced;
 *  · it is only WIDENED when it holds fewer than two Places, i.e. exactly when
 *    it cannot show more than one Place at all;
 *  · the widening set is the eligible Places inside the passed radius, and a
 *    Place without canonical coordinates is never admitted (fail-closed);
 *  · canonical input order is preserved, so ranking and eligibility are
 *    untouched — this value is camera geometry only.
 */
export function resolveExploreFitPlaces<T extends LocalAreaPlace>(input: {
  origin: ActiveCenter | null;
  /** The already-resolved local-area Places (canonical membership). */
  localPlaces: readonly T[];
  /** Every eligible Place the current content filters allow. */
  candidatePlaces: readonly T[];
  /**
   * The ACTIVE distance preset radius, in metres. Passed in by the caller so
   * this helper never defines a radius of its own.
   */
  radiusMeters: number;
}): T[] {
  const hasCoordinates = (place: LocalAreaPlace): boolean =>
    Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
  if (!isUsableCenter(input.origin)) return [];
  if (input.localPlaces.length >= 2) return input.localPlaces.filter(hasCoordinates);

  const origin = input.origin;
  const alreadyPresent = new Set(input.localPlaces.map((place) => place.id));
  const keep = new Set(
    input.candidatePlaces
      .filter(
        (place) =>
          hasCoordinates(place) &&
          (alreadyPresent.has(place.id) ||
            distanceMeters(origin, { lat: place.latitude as number, lng: place.longitude as number }) <=
              input.radiusMeters),
      )
      .map((place) => place.id),
  );
  return input.candidatePlaces.filter((place) => hasCoordinates(place) && keep.has(place.id));
}

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

// ---------------------------------------------------------------------------
// LOCAL AREA COVERAGE — which Places the camera is allowed to frame (2026-10-03)
// ---------------------------------------------------------------------------

/**
 * THE DECISIVE SEPARATION of the adaptive local-area rule (below).
 *
 * A Places dataset has no boundary geometry: `country-region-data` carries ISO
 * codes and subdivision NAMES only (no polygons), and the geocoder returns a
 * centre point with a resolved name (no geometry either). There is therefore no
 * trusted polygon to fit a "city" against, and inventing one — or replacing the
 * retired 10 km cap with another fixed number in metres — is exactly what the
 * correction forbids.
 *
 * So the fallback area is derived from the DATA itself: walking the candidates
 * outward from the real fix, the local area ends at the first Place that sits
 * at least this many times farther away than the Place before it. That is a
 * statement about the SHAPE of the dataset (a cluster, then a jump), never
 * about a distance in metres: it is scale-free, so it behaves identically for a
 * neighbourhood of coffee shops and for a country-sized Place set, and it can
 * never be satisfied by "the whole database" unless the whole database really
 * is one continuous cluster around the user.
 */
export const LOCAL_AREA_SEPARATION_RATIO = 3;

/** The Place facts the local-area rule is allowed to read. All optional. */
import { canonicalPlaceSubdivisionKey } from "@/lib/geo/countries";

export type LocalAreaPlace = {
  id: string;
  latitude: number | null;
  longitude: number | null;
  /** Canonical ISO 3166-1 country code (`places.country_code`) — trusted. */
  countryCode?: string | null;
  /** Canonical ISO 3166-2 subdivision name (`places.region_name`) — trusted. */
  regionName?: string | null;
};

/**
 * How the local area was determined.
 * - `region`   — a TRUSTED geographic boundary: the anchor Place's own
 *                canonical subdivision, resolved to its ISO code through the
 *                vocabulary the server already validates every Place write
 *                against (`lib/geo/countries.ts`). Every Place of that
 *                subdivision is included, so coverage is as complete as the
 *                data allows. A nearby Place whose own subdivision cannot be
 *                verified is added on proximity evidence alone (see
 *                `resolveLocalAreaCoverage`).
 * - `proximity`— no trusted subdivision on the anchor, so the adaptive
 *                separation rule above decided the area.
 * - `none`     — nothing to frame: no usable origin, or no Place with
 *                canonical coordinates. The camera MUST then stay where it is
 *                (never fall back to the whole dataset).
 */
export type LocalAreaBasis = "region" | "proximity" | "none";

export type LocalAreaCoverage<T extends LocalAreaPlace> = {
  /** The selected Places, in the INPUT order — canonical order is preserved. */
  places: T[];
  basis: LocalAreaBasis;
  /** The Place the area was grown from: the nearest one to the origin. */
  anchorId: string | null;
  /** How many Places with canonical coordinates were considered. */
  consideredCount: number;
};

/**
 * The Place's canonical ISO 3166-1/3166-2 subdivision identity ("SA-01"), or
 * `null` when the row names no subdivision this product can TRUST.
 *
 * Corrected 2026-10-03. This used to be `${country}|${region.toLowerCase()}`,
 * which quietly treated any string in `places.region_name` as a geographic
 * boundary. `region_name` is free text in the database, so two spellings of one
 * real region became two different localities: the live dataset carries
 * "Riyadh" on 25 Places and "Ar Riyad" on 10 more, all in the same city, and
 * only the first spelling is the ISO subdivision (the dataset spells the
 * Riyadh Region "Ar Riyad"; "Riyadh" is the city).
 *
 * The key now comes from `canonicalPlaceSubdivisionKey`, an EXACT lookup in the
 * trusted `country-region-data` vocabulary that `lib/geo/countries.ts` already
 * validates every Place write against — so two Places of one subdivision always
 * share a key, an unverifiable value yields `null` instead of a fake boundary,
 * and no alias or fuzzy matching is introduced.
 */
function localityKey(place: LocalAreaPlace): string | null {
  return canonicalPlaceSubdivisionKey(place.countryCode, place.regionName);
}

/**
 * Grow a compact cluster outward from the anchor, stopping at the first
 * decisive separation (see `LOCAL_AREA_SEPARATION_RATIO`). `ordered` must be
 * sorted by distance from the origin; the distances are non-decreasing, so one
 * pass is enough and the result is a genuine prefix of that ordering.
 */
function compactCluster<T extends LocalAreaPlace>(
  origin: ActiveCenter,
  ordered: readonly { place: T; lat: number; lng: number }[],
): T[] {
  const cluster: T[] = ordered.length > 0 ? [ordered[0].place] : [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = distanceMeters(origin, { lat: ordered[index - 1].lat, lng: ordered[index - 1].lng });
    const current = distanceMeters(origin, { lat: ordered[index].lat, lng: ordered[index].lng });
    // A Place AT the origin (previous === 0) is not a separation on its own:
    // only a genuinely farther Place ends the cluster there.
    if (previous === 0 ? current > 0 : current >= previous * LOCAL_AREA_SEPARATION_RATIO) break;
    cluster.push(ordered[index].place);
  }
  return cluster;
}

/**
 * THE LOCAL AREA around a real origin (product decision, 2026-10-03).
 *
 * Root cause this closes: the auto-fit dataset used to be the whole
 * content-filtered Place list, so one "Lokasi Saya" / "Tempat Pilihan" focus
 * could frame West Java and Riyadh in a single fit — a world view where the
 * user's own neighbourhood was one pixel wide. There is no fixed radius cap
 * here and no fallback to the whole dataset: the area is bounded by geography.
 *
 * Order of preference:
 *  1. a trusted boundary — the anchor Place's own canonical subdivision
 *     (ISO 3166-1 / 3166-2, resolved through `canonicalPlaceSubdivisionKey`).
 *     Every Place of that subdivision is in the area, which is what "cover the
 *     local area as completely as possible" means for the real data;
 *  2. the adaptive separation rule, for an anchor that carries no subdivision
 *     (an older row, or a Place whose geography was never filled in).
 *
 * A THIRD CASE, added 2026-10-03: a candidate whose own `region_name` is not a
 * subdivision of its country (a bare city name such as "Riyadh") makes no
 * geographic claim the product can verify, so it must not be excluded from an
 * area anchored inside a real subdivision — that is exactly what silently
 * emptied the "Tempat Pilihan" context in Riyadh. Such a candidate is admitted
 * only through rule 2, the same adaptive proximity rule that has always applied
 * to an anchor without geography, so it can still never widen the area beyond a
 * genuinely compact cluster around the origin. It also never grants a boundary:
 * a candidate WITH a verified subdivision is governed by rule 1 alone.
 *
 * Fail-closed everywhere: a non-finite origin, a Place without canonical
 * coordinates, or an empty candidate list yields `basis: "none"` and an EMPTY
 * selection, so the caller keeps its safe fallback instead of framing every
 * Place on earth. No coordinate is ever invented, defaulted, or rounded into
 * existence, and no Place is re-ordered, re-scored, or added to any row.
 */
export function resolveLocalAreaCoverage<T extends LocalAreaPlace>(input: {
  origin: ActiveCenter | null;
  places: readonly T[];
}): LocalAreaCoverage<T> {
  const empty: LocalAreaCoverage<T> = { places: [], basis: "none", anchorId: null, consideredCount: 0 };
  if (!isUsableCenter(input.origin)) return empty;

  // Fail-closed: a Place without real coordinates can never define an area.
  const candidates = input.places.flatMap((place) =>
    Number.isFinite(place.latitude) && Number.isFinite(place.longitude)
      ? [{ place, lat: place.latitude as number, lng: place.longitude as number }]
      : [],
  );
  if (candidates.length === 0) return { ...empty, consideredCount: 0 };

  const origin = input.origin;
  const ordered = [...candidates].sort(
    (a, b) => distanceMeters(origin, a) - distanceMeters(origin, b),
  );
  const anchor = ordered[0].place;
  const key = localityKey(anchor);

  // `ordered` is already sorted by distance, and `filter` preserves that order,
  // so both branches below hand `compactCluster` a correctly ordered list.
  let selected: T[];
  if (!key) {
    selected = compactCluster(origin, ordered);
  } else {
    const subdivision = candidates.filter((candidate) => localityKey(candidate.place) === key);
    const unverified = ordered.filter((candidate) => localityKey(candidate.place) === null);

    // THE REACH OF THE VERIFIED SUBDIVISION — the furthest the anchor's own
    // trusted boundary actually extends, measured from the ORIGIN. This is the
    // bound that keeps the branch above honest, and it is derived entirely from
    // real Places; no kilometre figure is invented here.
    //
    // It is needed because `compactCluster` decides on a RATIO between
    // successive distances, which is scale-free: a set of Places 380 km away
    // but all roughly the same distance apart never trips the 3x separation, so
    // admitting unverifiable Places by that rule alone pulled the whole Eastern
    // Province curated set into a Riyadh frame. With the reach, the real Riyadh
    // Places (2.8-13.7 km) are admitted and the far outliers are not, while a
    // Place carrying a genuine OTHER subdivision is still refused outright by
    // the filter above — a verified boundary always wins.
    //
    // A subdivision with a single Place has NO measurable spread, so there is
    // nothing to bound against; that case keeps the pre-existing proximity rule
    // alone (exactly the branch above), rather than shrinking the area to the
    // anchor and silently discarding every nearby Place.
    const reach =
      subdivision.length >= 2
        ? Math.max(...subdivision.map((candidate) => distanceMeters(origin, candidate)))
        : Number.POSITIVE_INFINITY;

    const reached = new Map(
      ordered.map((candidate) => [
        candidate.place.id,
        distanceMeters(origin, { lat: candidate.lat, lng: candidate.lng }),
      ]),
    );

    selected = [
      ...subdivision.map((candidate) => candidate.place),
      // Unverifiable geography (see the note above): reachable only by
      // proximity within that reach, never by a boundary we cannot substantiate.
      ...compactCluster(origin, unverified).filter((place) => (reached.get(place.id) ?? Infinity) <= reach),
    ];
  }
  const selectedIds = new Set(selected.map((place) => place.id));

  // The answer keeps the INPUT order, so canonical Place order is untouched no
  // matter how the area was determined.
  return {
    places: input.places.filter((place) => selectedIds.has(place.id)),
    basis: key ? "region" : "proximity",
    anchorId: anchor.id,
    consideredCount: candidates.length,
  };
}

// ---------------------------------------------------------------------------
// CONTEXTUAL CAMERA DATASET — "Tempat Pilihan" frames the SELECTION IN THE
// ACTIVE CONTEXT, never the whole curated layer worldwide.
// ---------------------------------------------------------------------------

/** The candidate facts this rule is allowed to read (coordinates + geography). */
export type ContextualCuratedPlace = LocalAreaPlace;

/** The outcome, and WHY the frame is what it is (testable, no UI involved). */
export type ContextualCuratedBasis = "search" | "area" | "none";

export type ContextualCuratedCoverage<T extends LocalAreaPlace> = {
  /** The curated Places of the active context, in the INPUT order. */
  places: T[];
  basis: ContextualCuratedBasis;
  /** The curated Places considered (canonical coordinates only). */
  consideredCount: number;
};

/**
 * The SAME contextual rule, named for what it actually does.
 *
 * It was written for the curated layer, but nothing in it is curated-specific:
 * it takes a candidate list and answers "which of these belong to the viewer's
 * CURRENT context". The curated tab (`resolveContextualCuratedCoverage`, kept
 * unchanged for its callers) and the "Semua Tempat" tab both frame through this
 * one implementation, so the two tabs can never disagree about what "the user's
 * context" means — and the 2026-10-05 world-frame defect cannot be re-introduced
 * for one of them only.
 */
export function resolveContextualPlaceCoverage<T extends ContextualCuratedPlace>(input: {
  places: readonly T[];
  origin: ActiveCenter | null;
  searchViewport: MapViewport | null;
}): ContextualCuratedCoverage<T> {
  const candidates = input.places.flatMap((place) =>
    Number.isFinite(place.latitude) && Number.isFinite(place.longitude) ? [place] : [],
  );
  if (candidates.length === 0) return { places: [], basis: "none", consideredCount: 0 };

  // 1. The searched region: the Places INSIDE its own coverage box. A box that
  // holds none must NOT widen into another region — it falls through to the
  // local-area rule, which is anchored on the same searched city.
  if (input.searchViewport) {
    const searched = narrowToViewport(candidates, input.searchViewport);
    if (searched.length > 0) {
      return { places: searched, basis: "search", consideredCount: candidates.length };
    }
  }

  // 2. The viewer's local area of the SELECTION (trusted canonical geography,
  // or the scale-free separation rule when the anchor has none).
  const area = resolveLocalAreaCoverage({ origin: input.origin, places: candidates });
  if (area.places.length === 0) return { places: [], basis: "none", consideredCount: candidates.length };
  return { places: area.places, basis: "area", consideredCount: candidates.length };
}

/**
 * THE CURATED CAMERA POOL, RESOLVED AGAINST THE ACTIVE CONTEXT.
 *
 * ROOT CAUSE this closes: the "Tempat Pilihan" focus used to frame EVERY
 * curated Place in the whole published set at once. On the canonical dataset
 * that set spans two continents ~13 000 km apart, so one fit produced a WORLD
 * view in which the viewer's own neighbourhood was a couple of pixels wide —
 * and `CURATED_FIT_MAX_ZOOM` (13) could not prevent it, because that ceiling
 * can only widen a frame that is already too TIGHT, never one that is too wide.
 *
 * The frame is now the SELECTION IN THE USER'S CURRENT CONTEXT, resolved with
 * the helpers this module already owns — no new geographic rule, no invented
 * coordinate, no hard-coded place:
 *  1. `search` — a city search is active: the curated Places inside the
 *     searched region's own coverage box (the SAME box, and therefore the same
 *     Places, the rows already use before Leaflet reports real bounds);
 *  2. `area`   — otherwise the curated Places of the viewer's LOCAL AREA
 *     (`resolveLocalAreaCoverage`, anchored on the searched city first and the
 *     real fix second), which is bounded by trusted canonical geography;
 *  3. `none`   — with no usable origin the pool is EMPTY, so the camera keeps
 *     the frame it has. There is no world fallback, ever (AGENTS.md: never
 *     fabricate; §19: no origin → no invented camera move).
 *
 * It is CAMERA GEOMETRY ONLY: curated membership still comes solely from the
 * canonical `places.is_curated` ids, the curated LIST, both rows, every count,
 * and Discovery are untouched, and a Place is never added, dropped, or
 * re-ordered by this value in any result.
 */
export function resolveContextualCuratedCoverage<T extends ContextualCuratedPlace>(input: {
  curatedPlaces: readonly T[];
  origin: ActiveCenter | null;
  searchViewport: MapViewport | null;
}): ContextualCuratedCoverage<T> {
  return resolveContextualPlaceCoverage<T>({
    places: input.curatedPlaces,
    origin: input.origin,
    searchViewport: input.searchViewport,
  });
}

// ---------------------------------------------------------------------------
// PIN LABEL DENSITY — a deterministic, non-hiding declutter (this change)
// ---------------------------------------------------------------------------

/**
 * How many Place name chips stay permanently painted at once.
 *
 * The chip itself is unchanged (compact, 11px/700, truncated at 132px, with
 * the full name on hover/focus). This budget only decides WHICH chips are
 * painted when a whole dense cluster is on screen at once, where chips used to
 * pile up on top of each other and none of them was readable.
 *
 * It is a presentation budget, never a filter: every pin keeps its marker, its
 * click target, its keyboard target, its tooltip with the full name, and its
 * chip in the DOM.
 */
export const PIN_LABEL_ALWAYS_ON_LIMIT = 12;

export type PinLabelCandidate = {
  id: string;
  /** Canonical curated membership (`places.is_curated`) — the first tier. */
  isCurated?: boolean | null;
  /** An active Live session — the second tier. */
  isLive?: boolean | null;
};

/**
 * WHICH pins keep their always-on label when the map is dense.
 *
 * Deliberately the SIMPLEST strategy that is compatible with the existing
 * architecture, because the alternatives are all worse here:
 *  · it needs NO measurement — no `getBoundingClientRect`, no `offsetWidth`,
 *    no per-frame or per-render layout pass. It runs once per marker rebuild
 *    (already keyed on the stable marker signature), so panning and zooming
 *    cost nothing extra;
 *  · it is DETERMINISTIC and STABLE: the same marker set always yields the
 *    same label set, in the same canonical order, so a label can never flicker
 *    between rebuilds;
 *  · it HIDES NOTHING PERMANENTLY: past the budget the chip stays in the DOM
 *    and is revealed by the existing hover/keyboard-focus state (pure CSS),
 *    and the full name is always available through the pin's tooltip;
 *  · it never hides ALL labels: the budget is always at least one, so a single
 *    pin, a normally spaced set, and a dense cluster all keep their names
 *    readable.
 *
 * Priority is the existing per-Place marker ladder — curated first, then
 * Live, then canonical order — so the labels that survive a dense frame are
 * the same Places the marker ladder already promotes to the top of the stack.
 */
export function selectAlwaysLabelledPlaceIds(
  candidates: readonly PinLabelCandidate[],
  limit: number = PIN_LABEL_ALWAYS_ON_LIMIT,
): Set<string> {
  const budget = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : PIN_LABEL_ALWAYS_ON_LIMIT;
  const chosen = new Set<string>();
  if (budget === 0) return chosen;
  const consumed = new Set<string>();
  const tiers: readonly ((candidate: PinLabelCandidate) => boolean)[] = [
    (candidate) => candidate.isCurated === true,
    (candidate) => candidate.isLive === true,
    () => true,
  ];
  for (const tier of tiers) {
    for (const candidate of candidates) {
      if (chosen.size >= budget) return chosen;
      if (consumed.has(candidate.id) || !tier(candidate)) continue;
      consumed.add(candidate.id);
      chosen.add(candidate.id);
    }
  }
  return chosen;
}



/*
 * The map SCALE BAR (`resolveMapScale` / `MapScale` / `MAP_SCALE_MAX_BAR_PX`,
 * added 2026-10-03) was REMOVED on 2026-10-04 together with the indicator
 * itself: the approved Home/Map mockup shows no distance scale, and nothing
 * replaces it. Zoom controls, the OSM attribution, and every geographic rule
 * below are untouched — the scale was display-only chrome, and the camera,
 * coverage, and radius rules never read it.
 */

/**
 * Neutral, always-true coverage caption for a camera that is NOT framed by a
 * radius (bug fix 2026-10-03).
 *
 * "Tempat Pilihan" and an explicit "Lokasi Saya" focus the camera on the local
 * area's Place spread, so no radius value describes them any more. The retired
 * 10 km copy claimed a radius the camera was not using; this says what is
 * actually true, and it names no distance, no city, and no radius at all.
 */
export const AREA_COVERAGE_CAPTION = "Menampilkan tempat di area peta";

/**
 * The origin fragment used when there is NO origin at all (bug fix, 2026-10-03).
 *
 * Geolocation denied and nothing searched means the results were not measured
 * from anywhere near the user, so neither "di sekitar Anda" nor a radius may be
 * printed. This is the SAME approved wording as AREA_COVERAGE_CAPTION — the
 * visible map area — reduced to the "di …" fragment the results count needs, so
 * the count and the coverage box speak about the same thing. No new product
 * term is introduced.
 */
export const NO_ORIGIN_AREA_LABEL = "di area peta";

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
 * THE ORIGIN PHRASE — one resolver shared by every element that tells the user
 * WHERE results are being measured from (bug fix 2026-10-03).
 *
 * Two separate UI elements used to hardcode their own wording: the map
 * coverage caption and the results-section count. Fixing only one of them left
 * the screen contradicting itself — the caption said "dari pusat pencarian
 * Riyadh" directly above a count that still read "di sekitar Anda", which is
 * the Dammam origin. They now derive from this single function, so the two can
 * never name different places.
 *
 * `placeName` is the geocoder's RESOLVED name. When it is absent the phrase
 * falls back to a neutral one rather than echoing typed text or inventing a
 * location name, so it can never claim a city the search did not resolve.
 */
export function resolveSearchOrigin(input: { mode: SearchMode; placeName: string | null }): string {
  if (input.mode === "city_search") {
    const name = typeof input.placeName === "string" ? input.placeName.trim() : "";
    return name ? `pusat pencarian ${name}` : NEUTRAL_SEARCH_AREA_LABEL;
  }
  return "lokasi Anda";
}

/**
 * Radius caption for the map coverage box (bug fix 2026-10-03).
 *
 * The caption used to be a fixed "dari lokasi Anda" while the map and the
 * results were centered on a SEARCHED city — so a Riyadh result set was
 * labelled as if it were measured from the device. The caption now names the
 * origin that is actually doing the measuring, which is the same active center
 * the coverage filter and the distance labels use.
 */
export function describeRadiusOrigin(input: {
  radiusLabel: string;
  mode: SearchMode;
  placeName: string | null;
}): string {
  return `Menampilkan tempat dalam radius ${input.radiusLabel} dari ${resolveSearchOrigin(input)}`;
}

/**
 * THE coverage caption the map box actually renders (bug fix, 2026-10-03).
 *
 * A radius may be named only while BOTH facts are true: a distance-tab preset
 * really owns the frame (`coverage === "radius"`), and there IS an origin to
 * measure it from (`hasCenter`). The second condition is the one that was
 * missing. `resolveActiveCenter` answers `center: null` when geolocation was
 * denied and nothing was searched — and in that state the radius preset has no
 * anchor at all, so the camera never applied it and simply stayed on the
 * neutral world overview. A caption that went on naming "dari lokasi Anda"
 * would describe a world-scale frame as a local one.
 *
 * RETIRED as a rendered element on 2026-10-03: it lived in a floating box of
 * its own, beside a results panel that already stated the origin and the
 * count. The two are now ONE consolidated line in the results panel — see
 * `describeCoverageScope`, which carries the same two conditions but only the
 * scope fragment, so the origin is stated exactly once. The function is kept
 * as the documented sentence contract for the neutral wording.
 */
export function describeCoverageCaption(input: {
  radiusLabel: string;
  mode: SearchMode;
  placeName: string | null;
  coverage: "radius" | "area";
  hasCenter: boolean;
}): string {
  if (input.coverage !== "radius" || !input.hasCenter) return AREA_COVERAGE_CAPTION;
  return describeRadiusOrigin({
    radiusLabel: input.radiusLabel,
    mode: input.mode,
    placeName: input.placeName,
  });
}

/**
 * THE SCOPE FRAGMENT — what the camera frame covers (bug fix, 2026-10-03).
 *
 * The map used to carry this in a floating box of its own, while the results
 * panel carried the origin and the count directly below it, so one screen
 * stated the same geographic fact twice in two different shapes. The two are
 * now ONE consolidated line: the count and the origin stay in the results
 * panel (Master/MOCKUP §11 copy, verbatim) and only the SCOPE is added here.
 *
 * It deliberately carries NO origin and NO count, so the consolidated line can
 * never repeat the place name the count already names, never print a second
 * count, and never contradict it. `AREA_SCOPE_LABEL` is the same approved
 * "area peta" wording as AREA_COVERAGE_CAPTION, reduced to the fragment the
 * line needs; a radius is named only while a preset owns the frame AND an
 * origin exists — the same two conditions as `describeCoverageCaption`.
 */
export const AREA_SCOPE_LABEL = "di area peta";

export function describeCoverageScope(input: {
  radiusLabel: string;
  coverage: "radius" | "area";
  hasCenter: boolean;
}): string {
  if (input.coverage !== "radius" || !input.hasCenter) return AREA_SCOPE_LABEL;
  return `dalam radius ${input.radiusLabel}`;
}

/**
 * "di sekitar …" fragment for the results-section count (bug fix 2026-10-03).
 *
 * This is the Master/MOCKUP §11 count subtitle ("{n} tempat pilihan di sekitar
 * Anda"), so the DEVICE wording is preserved VERBATIM — that string is quoted
 * by the mockup and is the default case. Only the searched-city case changed:
 * it used to keep claiming "di sekitar Anda" while the count itself came from
 * the city's own coverage, which is exactly the inconsistency this fixes.
 *
 * `hasCenter` (bug fix, 2026-10-03) closes the DEVICE half of the same lie:
 * with geolocation denied and nothing searched there is no origin at all, so
 * "di sekitar Anda" described a count measured from nowhere. It then names the
 * visible map area instead — the same "area peta" wording the coverage caption
 * uses, so the count and the caption can never contradict each other.
 *
 * It defaults to `true`: with a usable center the Master/MOCKUP §11 wording is
 * returned VERBATIM and nothing about the existing copy changes.
 */
export function describeNearOrigin(input: {
  mode: SearchMode;
  placeName: string | null;
  hasCenter?: boolean;
}): string {
  if (input.hasCenter === false) return NO_ORIGIN_AREA_LABEL;
  if (input.mode === "city_search") return `di sekitar ${resolveSearchOrigin(input)}`;
  return "di sekitar Anda";
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
