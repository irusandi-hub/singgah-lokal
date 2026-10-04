"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import HomeMap, { type HomeMapPlace } from "@/components/home-map";
import PlaceFollowButton from "@/components/place-follow-button";
import SiteNav from "@/components/site-nav";
import VisitedLink from "@/components/visited-link";
import type { Place } from "@/lib/places";
import type { DiscoveryViewModel } from "@/lib/discovery/view-model";
import {
  CAMERA_PRESET_RADIUS_M,
  CURATED_CAMERA_RADIUS_M,
  CURATED_RESULTS_ANCHOR_ID,
  DISCOVERY_RESULTS_ANCHOR_ID,
  DISTANCE_FILTERS,
  acceptSearchResponse,
  activateCuratedFilter,
  buildDirectionsUrl,
  clearCitySearch,
  distanceMeters,
  describeCoverageScope,
  describeNearOrigin,
  formatDistance,
  isSameViewport,
  liveDurationLabel,
  narrowToViewport,
  resolveActiveCenter,
  resolveLocalAreaCoverage,
  resolveResultsAnchorId,
  stopNestedCardAction,
  toggleLiveFilter,
  type DistanceFilter,
  type LiveDiscoveryItem,
  type MapScale,
  type MapViewport,
} from "@/lib/live/ui";

/**
 * CANONICAL CAMERA CANDIDATE — one canonical Place projected to exactly what
 * the camera rules are allowed to read: its id, name, REAL coordinates, and its
 * canonical ISO country/subdivision.
 *
 * It is display geometry only. `null` when the Place has no real coordinates,
 * because a Place without them can never define or anchor a frame (fail-closed,
 * AGENTS.md: never fabricate a position). Nothing here reads eligibility,
 * ranking, or membership.
 */
function toCameraCandidate(place: Place): {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  countryCode: string | null;
  regionName: string | null;
} | null {
  if (place.latitude === null || place.longitude === null) return null;
  return {
    id: place.id,
    name: place.name,
    latitude: place.latitude,
    longitude: place.longitude,
    countryCode: place.countryCode,
    regionName: place.regionName,
  };
}

/** Deduplicated candidate list — a Place can only ever appear once. */
function toCameraCandidates(source: readonly Place[]): NonNullable<ReturnType<typeof toCameraCandidate>>[] {
  const seen = new Set<string>();
  const result: NonNullable<ReturnType<typeof toCameraCandidate>>[] = [];
  for (const place of source) {
    if (seen.has(place.id)) continue;
    seen.add(place.id);
    const candidate = toCameraCandidate(place);
    if (candidate) result.push(candidate);
  }
  return result;
}

/** The geometry-only shape the map consumes. */
function toHomeMapPlaces(
  source: readonly NonNullable<ReturnType<typeof toCameraCandidate>>[],
): HomeMapPlace[] {
  return source.map(({ id, name, latitude, longitude }) => ({ id, name, latitude, longitude }));
}

// Home discovery (Map-first) — rendered by the / route (app/page.tsx,
// force-dynamic server wrapper). It must stay a CLIENT component here so the
// route segment config in the wrapper takes effect: as a top-level "use
// client" page the shell was statically prerendered and served with a
// year-long s-maxage, freezing the signed-out header for logged-in users.
// Performance (PO 2026-09-26): the public discovery data is passed in from
// the server wrapper (sessionless fetch, safe inside the dynamic shell) —
// the client no longer re-fetches /api/places after hydration.
//
// Stage 3: the `discovery` prop carries the server-built view model from the
// canonical Discovery engine (stars + rank only — the numeric score never
// leaves the server). The client NEVER recomputes eligibility, score, stars,
// or ranking; it only joins card data by id and renders the engine order.
export default function HomeDiscovery({
  initialPlaces = [],
  discovery,
}: {
  initialPlaces?: Place[];
  discovery?: DiscoveryViewModel;
}) {
  // Places come from the server wrapper (initialPlaces) and never change
  // client-side — no setter, no post-hydration fetch, no stale client copy.
  const [places] = useState<Place[]>(initialPlaces);
  // Home filter bar — ONE row on mobile (PO 2026-09-26): LIVE leftmost,
  // "Tempat Pilihan" beside it, then the distance tabs. Default = "1 km":
  // the smallest remaining bounded radius anchors on the real Current
  // Location (PO: Current Location is the map center; no invented viewport).
  // "Tempat Pilihan" is ONE curated discovery layer (PO 2026-09-26): it
  // carries NO category tabs/chips — Place categories (Kopi/Teh/Kuliner)
  // stay internal data, never a Home filter UI. It does NOT replace
  // "Tempat di sekitar", which still appears whenever a bounded radius is
  // active.
  const [distanceFilter, setDistanceFilter] = useState<DistanceFilter>("1 km");
  const [curatedOnly, setCuratedOnly] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // LOCATION SEARCH state: the typed text (searchQuery above), the pending
  // flag, the server-parsed center, and a nonce that bumps once the server
  // answered. The search center is the ONLY camera anchor the search flow
  // changes — the radius tabs stay camera-only presets, and a radius tab
  // never cancels an in-flight search. No fallback coordinate is ever
  // invented: without a server answer searchCenter stays null and the map
  // keeps the REAL Leaflet viewport as its coverage source.
  const [searchPending, setSearchPending] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchCenter, setSearchCenter] = useState<{ lat: number; lng: number } | null>(null);
  // The RESOLVED place name the geocoder returned for searchCenter. It is
  // server output, not the raw typed text, so the radius caption can name the
  // city the search actually resolved instead of guessing. Cleared together
  // with the center by every reset path.
  const [searchPlaceName, setSearchPlaceName] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [liveItems, setLiveItems] = useState<LiveDiscoveryItem[]>([]);
  // Viewer position — Current Location. Geolocation is the primary map
  // anchor: when available the Home Map centers on it and shows the user
  // marker. Silently absent when denied; no fallback point is ever invented.
  // Default = "1 km": the tightest camera preset anchors on the real Current
  // Location (PO: Current Location is the map center; no invented viewport).
  const [viewerPosition, setViewerPosition] = useState<{
    lat: number;
    lng: number;
    accuracy?: number;
  } | null>(null);
  // Explicit "Lokasi Saya" requests bump this nonce so the map re-centers on
  // the latest fix on demand.
  const [locateNonce, setLocateNonce] = useState(0);
  // AUTO-FIT REFOCUS TRIGGER (product decision, 2026-10-03): bumped ONLY by
  // the explicit "Tempat Pilihan" tab choice, so the map can re-frame the
  // camera to the Place spread on exactly that action — and on nothing else.
  // No marker refresh, discovery poll, or viewport report carries a nonce, so
  // the camera can never be recentered in a loop.
  const [fitNonce, setFitNonce] = useState(0);
  // EXPLICIT CAMERA REQUEST (product decision, 2026-10-03): bumped ONLY by the
  // three actions a person takes to move the camera by hand — a distance tab,
  // "Tempat Pilihan", "Lokasi Saya". It releases the map's interaction latch,
  // so the frame those actions produce STAYS put: no marker refresh, discovery
  // poll, viewport report, or later geolocation fix can take it back.
  const [cameraRequestNonce, setCameraRequestNonce] = useState(0);
  // WHICH RULE currently owns the camera frame (bug fix, 2026-10-03), used by
  // the coverage caption. "radius" = a distance tab preset really does frame
  // that radius (the caption may name it); "area" = the frame comes from the
  // viewer's LOCAL AREA, so no radius value describes it and the caption must
  // not claim one. Never a guess: it is set by the same handlers that move the
  // camera, never inferred afterwards.
  const [cameraCoverage, setCameraCoverage] = useState<"radius" | "area">("radius");
  // REAL map scale (bug fix, 2026-10-03): reported by the map from its own
  // viewport, so the corner bar always states the scale of what is on screen.
  // null until the first measurement — then no scale is drawn at all.
  const [mapScale, setMapScale] = useState<MapScale | null>(null);
  // Which Place card currently shows the "not Live" notice (pressed state of
  // the permanent LIVE indicator). Live state itself is never invented — the
  // canonical liveByPlaceId feed is the only source.
  const [nonLiveNoticePlaceId, setNonLiveNoticePlaceId] = useState<string | null>(null);
  // Viewport-aware map empty state (PO, 2026-09-30): the MAP decides from the
  // REAL Leaflet viewport whether a Place is currently visible — evaluated on
  // readiness and on every FINISHED move/zoom (moveend/zoomend). Three
  // situations stay distinct:
  //   1. the dataset itself is empty (mapPlaces.length === 0) → overlay on;
  //   2. the dataset has Places but none sits in the current viewport →
  //      overlay on — and it disappears/appears again as the user pans/zooms
  //      between populated and empty areas without any dataset change;
  //   3. a Place sits in the viewport → no overlay.
  // viewportHasPlaces only becomes meaningful once the map has reported
  // (reportedViewportRef), so the first paint before Leaflet is ready never
  // shows a wrong status.
  // MOCKUP §16 (2026-10-01): the 5-slot star row reads ONLY the canonical
  // engine output — the `stars` field of the server view model (stars alone;
  // the numeric score never leaves the server, contract §3). A Place the
  // engine did not rank (e.g. Live cards) renders five EMPTY slots. Never a
  // rating number, never a review count — no such data exists in the product.
  const starsByPlaceId = useMemo(() => {
    const map = new Map<string, number>();
    (discovery?.discovery ?? []).forEach((entry) => {
      if (!map.has(entry.placeId)) map.set(entry.placeId, entry.stars);
    });
    return map;
  }, [discovery]);
  const [viewportHasPlaces, setViewportHasPlaces] = useState(false);
  const [viewportReported, setViewportReported] = useState(false);
  const reportedViewportRef = useRef(false);
  const handleViewportHasPlaces = useCallback((hasPlaces: boolean) => {
    setViewportHasPlaces(hasPlaces);
    if (!reportedViewportRef.current) {
      reportedViewportRef.current = true;
      setViewportReported(true);
    }
  }, []);
  // REAL VISIBLE VIEWPORT (product decision, 2026-10-01): the map is the ONE
  // geographic coverage source. HomeMap reports the Leaflet bounds on
  // readiness, on every finished move/zoom, and on resize; this state is the
  // ONLY input that narrows the markers and the two Place rows to the area the
  // user can actually see. A fixed radius preset no longer decides any Place.
  //
  // `null` = Leaflet has not reported yet: the full canonical result renders
  // (never a premature empty first paint). Reports are deduped by exact
  // bounds equality, so a settled viewport never re-renders the rows.
  const [mapViewport, setMapViewport] = useState<MapViewport | null>(null);
  const lastViewportRef = useRef<MapViewport | null>(null);
  const handleViewportChange = useCallback((viewport: MapViewport) => {
    if (isSameViewport(lastViewportRef.current, viewport)) return;
    lastViewportRef.current = viewport;
    setMapViewport(viewport);
  }, []);

  // REAL map scale (bug fix, 2026-10-03): the map measures its own viewport
  // and reports the round distance its bar stands for, so the corner chip can
  // never print a camera radius as if it were the map's scale. `null` (nothing
  // measurable yet) simply draws no scale.
  const handleScaleChange = useCallback((scale: MapScale | null) => {
    setMapScale(scale);
  }, []);
  const router = useRouter();

  // Stage 3: server-built Discovery view model (engine output) + the
  // Tempat Pilihan flag ids (migration 0035, read through the canonical
  // repository). Both are lookup-only here — no curation or score logic.
  const curatedIdSet = useMemo(
    () => new Set(discovery?.curatedPlaceIds ?? []),
    [discovery],
  );
  const placeById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);



  // LIVE discovery feed (canonical live_sessions, published Places only).
  // Performance rule (PO, 2026-09-25): the 15-second poll runs ONLY while
  // the LIVE tab is actually active — distance/curated modes must not pay
  // for continuous Live polling. Initial load + refresh happen when the tab
  // is opened; the interval is torn down on every mode exit (tab switch off,
  // Tempat Pilihan, unmount/route change), so leaving LIVE mode always
  // stops the polling. LIVE badges (liveByPlaceId) stay correct for a full
  // poll cycle after leaving the tab and never invent Live state.
  useEffect(() => {
    if (!liveOnly) return;

    const load = () =>
      fetch("/api/live/discovery")
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Live discovery unavailable"))))
        .then((payload: { live: LiveDiscoveryItem[] }) => setLiveItems(payload.live ?? []))
        .catch(() => setLiveItems([]));

    load();
    const interval = window.setInterval(load, 15000);
    return () => window.clearInterval(interval);
  }, [liveOnly]);

  // Real viewer position when permission is granted; no fallback point is
  // ever invented — without a position (or Place coordinates) no distance
  // label is shown (PO: no fake positions). The SAME handler serves the
  // initial mount fix and the explicit "Lokasi Saya" presses: a press always
  // asks the browser for a FRESH position (locate-refresh fix, 2026-09-30).
  const requestViewerPosition = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setViewerPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        // Recentre ONLY after the fresh position is committed to state —
        // the locate effect (locateNonce) then flies to the ACTIVE preset
        // radius around this newest fix. Never flies to a stale one.
        setLocateNonce((nonce) => nonce + 1);
      },
      // Denial/failure is silent: the camera stays exactly where it is —
      // no fallback coordinate, no default location, no dataset change.
      () => undefined,
      { timeout: 8000 },
    );
  }, []);

  // Initial mount fix — the same fresh-position request path.
  useEffect(() => {
    requestViewerPosition();
  }, [requestViewerPosition]);

  // LOCATION SEARCH — SUBMIT-ONLY (2026-10-04): the geocode must not run on
  // every keystroke. Typing only updates `searchQuery`; the single geocode runs
  // on Enter/submit (`handleSearchSubmit`) and the last SUBMITTED query is
  // tracked separately from the typed text. EPOCH guard: every intent change
  // (new submit, cleared input, "Lokasi Saya") bumps the epoch, and a response
  // carrying an older epoch is dropped on arrival, so a late answer can never
  // drag the map and the rows back after the user has moved on.
  // Leaflet's own bounds for the search-recentered camera supersede the
  // synthetic ±0.05° bridge box. Releasing the latch on a NEW answer makes
  // coverage follow the real viewport again (so panning after a search works)
  // without a flash of the pre-search area in between.
  const resetViewportLatch = useCallback(() => {
    lastViewportRef.current = null;
    setMapViewport(null);
  }, []);

  const submittedSearchRef = useRef("");
  const searchEpochRef = useRef(0);

  // NOTE (2026-10-04): the debounced auto-search-on-keystroke was removed. The
  // search is SUBMIT-ONLY — typing never geocodes, and `handleSearchSubmit`
  // below is the ONE search path.

  // Clearing the input is the ONE place the search state resets (no effect):
  // an empty query immediately drops the pending flag, the error, and the
  // center, so the map and every row fall back to the REAL Leaflet viewport.
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const handleSearchSubmit = useCallback(async (
    value: string,
  ) => {
      const trimmed = value.trim();
      if (!trimmed) {
        // An empty submit never geocodes. It simply returns the box, the
        // error, and the map to the neutral, device-centred state — the same
        // reset the clear control performs, so every reset path clears the
        // resolved name together with the center.
        searchEpochRef.current += 1;
        submittedSearchRef.current = "";
        const cleared = clearCitySearch();
        setSearchQuery(cleared.query);
        setSearchPending(cleared.pending);
        setSearchError(cleared.error);
        setSearchCenter(cleared.center);
        setSearchPlaceName(cleared.placeName);
        return;
      }

      // Every submit intent invalidates any response still in flight, so a
      // late answer for a previous query can never overwrite a newer one.
      searchEpochRef.current += 1;
      submittedSearchRef.current = trimmed;
      setSearchQuery(trimmed);
      setSearchPending(true);
      setSearchError(null);
      setSearchCenter(null);

      const requestEpoch = searchEpochRef.current;
      const isCurrent = () =>
        acceptSearchResponse({
          requestEpoch,
          currentEpoch: searchEpochRef.current,
          submitted: trimmed,
          activeQuery: submittedSearchRef.current,
        });

      try {
        const response = await fetch(`/api/geocode?q=${encodeURIComponent(trimmed)}`, {
          headers: { Accept: "application/json" },
        });
        if (submittedSearchRef.current !== trimmed) return;
        if (!isCurrent()) return;
        if (response.status === 404) {
          setSearchPending(false);
          setSearchError("Lokasi tidak ditemukan. Cek ejaan atau pilih dari daftar.");
          setSearchCenter(null);
          return;
        }
        if (!response.ok) {
          setSearchPending(false);
          setSearchError("Layanan lokasi sedang tidak tersedia. Coba lagi nanti.");
          setSearchCenter(null);
          return;
        }
        const result = (await response.json()) as {
          latitude?: number;
          longitude?: number;
          displayName?: string;
          name?: string;
        };
        if (submittedSearchRef.current !== trimmed) return;
        if (!isCurrent()) return;
        const latitude = Number(result.latitude);
        const longitude = Number(result.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          setSearchPending(false);
          setSearchError("Lokasi tidak ditemukan. Cek ejaan atau pilih dari daftar.");
          setSearchCenter(null);
          return;
        }
        setSearchPending(false);
        setSearchCenter({ lat: latitude, lng: longitude });
        setSearchPlaceName(
          typeof result.displayName === "string" && result.displayName.trim()
            ? result.displayName.trim()
            : typeof result.name === "string" && result.name.trim()
              ? result.name.trim()
              : null,
        );
        resetViewportLatch();
      } catch {
        if (submittedSearchRef.current !== trimmed) return;
        if (!isCurrent()) return;
        setSearchPending(false);
        setSearchError("Layanan lokasi sedang tidak tersedia. Coba lagi nanti.");
        setSearchCenter(null);
      } finally {
        setSearchNonce((nonce) => nonce + 1);
      }
    },
    [resetViewportLatch],
  );

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleSearchSubmit(event.currentTarget.value);
      }
    },
    [handleSearchSubmit],
  );

  const handleSearchClear = useCallback(() => {
    searchEpochRef.current += 1;
    submittedSearchRef.current = "";
    const cleared = clearCitySearch();
    setSearchQuery(cleared.query);
    setSearchPending(cleared.pending);
    setSearchError(cleared.error);
    setSearchCenter(cleared.center);
    setSearchPlaceName(cleared.placeName);
  }, []);

  // "LOCATION MODE OWNERSHIP (bug fix 2026-10-02): ONE source of truth for
  // "where is the user looking from". The searched city and the device fix are
  // mutually exclusive, and everything that needs a coordinate — the viewport
  // coverage, the distance labels, and the radius camera preset — reads THIS
  // value. Before, the coverage filter used the searched city while both
  // distance labels measured from the device, so a Place the filter had just
  // admitted to the Riyadh area was still labelled with its distance from
  // Dammam. With no city searched the active center IS the device fix, so the
  // default experience is byte-for-byte unchanged.
  const activeSearch = resolveActiveCenter({ searchCenter, viewerPosition });
  const activeCenter = activeSearch.center;

  // "Lokasi Saya" press (locate-refresh regression fix, 2026-09-30; state reset
  // added 2026-10-02): the recenter must NOT depend on the fresh request
  // succeeding. The press bumps the locate nonce IMMEDIATELY — with a valid fix
  // the map recentres to it through the ACTIVE preset right away (a
  // denied/timed-out fresh request can no longer swallow the press); with no fix
  // yet the existing pending latch resolves on the first real one. The fresh
  // request then runs: on success it updates viewerPosition and bumps the nonce
  // again so the camera follows the newest fix; on failure the camera simply
  // stays where the immediate recenter put it. No fallback coordinate is ever
  // invented in any branch.
  //
  // It now also RETURNS SEARCH MODE to the device. Previously the press only
  // moved the camera, leaving the searched city as the coverage source and the
  // city name as a live text filter — so the list, the markers, the distance
  // labels and the "Area pencarian" status kept describing the abandoned city.
  // The city state is dropped as ONE value (never a half-cleared frame) and the
  // epoch is bumped so a still-in-flight geocode for the old city can no
  // longer pull the map and the rows back to it.
  const handleLocatePress = useCallback(() => {
    searchEpochRef.current += 1;
    submittedSearchRef.current = "";
    const cleared = clearCitySearch();
    setSearchQuery(cleared.query);
    setSearchPending(cleared.pending);
    setSearchError(cleared.error);
    setSearchCenter(cleared.center);
    setSearchPlaceName(cleared.placeName);
    // Coverage goes back to the REAL Leaflet bounds; the synthetic bridge box
    // existed only for a city that no longer owns the viewport.
    resetViewportLatch();
    // The frame this press produces is the viewer's LOCAL AREA, not a radius:
    // the caption must stop claiming one, and the map must stop letting a
    // later radius preset take the camera back.
    setCameraCoverage("area");
    setCameraRequestNonce((nonce) => nonce + 1);
    setLocateNonce((nonce) => nonce + 1);
    requestViewerPosition();
  }, [requestViewerPosition, resetViewportLatch]);

  const liveByPlaceId = useMemo(() => {
    const map = new Map<string, LiveDiscoveryItem>();
    liveItems.forEach((item) => {
      if (!map.has(item.placeId)) map.set(item.placeId, item);
    });
    return map;
  }, [liveItems]);

  // CONTENT FILTER (PO, 2026-09-29): search, LIVE, and the curated layer —
  // the filters that decide WHAT content exists. The distance tabs are NOT
  // part of this pipeline anymore: 1 km / 5 km / 10 km+ are CAMERA PRESETS,
  // and the map dataset must never shrink because a radius tab was chosen
  // (zooming out would otherwise never reveal Places that an upstream
  // radius filter had already discarded).
  //
  // Search is extracted as its own step so EVERY layer (existing results,
  // the Tempat Pilihan row, and the Discovery rows) applies the exact same
  // query semantics — one search behavior, no second implementation.
  const searchFiltered = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase("id-ID");
    if (!normalizedQuery) return places;
    return places.filter((place) => {
      const liveProcess = liveByPlaceId.get(place.id)?.processTitle ?? "";
      const haystack = [
        place.name,
        place.shortDescription,
        place.area,
        place.category,
        place.type,
        liveProcess,
      ]
        .join(" ")
        .toLocaleLowerCase("id-ID");
      return haystack.includes(normalizedQuery);
    });
  }, [places, searchQuery, liveByPlaceId]);

  const searchFilteredIds = useMemo(
    () => new Set(searchFiltered.map((place) => place.id)),
    [searchFiltered],
  );

  const visiblePlaces = useMemo(() => {
    // "Tempat Pilihan" is ONE curated discovery layer (PO 2026-09-26), backed
    // by the canonical is_curated flag (PO Stage 3, migration 0035): published
    // + curated only. The flag arrives through the server view model — the
    // client computes no curation and no score.
    //
    // An EMPTY curated set is a real empty state, never a fallback: showing
    // every published Place would silently disguise missing curation data as
    // "Tempat Pilihan" and would blur the two independent layers. There is no
    // category selection inside the layer — the canonical Place category never
    // filters the curated layer.
    if (curatedOnly) {
      return searchFiltered.filter((place) => curatedIdSet.has(place.id));
    }
    // LIVE: a process/status filter — only Places with an active session.
    let result = searchFiltered;
    if (liveOnly) result = result.filter((place) => liveByPlaceId.has(place.id));
    return result;
  }, [searchFiltered, liveOnly, curatedOnly, curatedIdSet, liveByPlaceId]);

  // LOCATION SEARCH VIEWPORT (PO 2026-10-02): when the server geocoder
  // answered, that canonical coordinate pair becomes the coverage source
  // until Leaflet reports its OWN bounds for the recentered camera. The box is
  // a small ±0.05° window (~5.5 km) purely to keep the filter deterministic
  // across that one gap; `narrowToViewport` accepts it because it is the same
  // MapViewport shape. It never changes eligibility, membership, or ordering.
  //
  // The REAL viewport wins once it exists. The bridge box used to win
  // FOREVER, which meant a searched city permanently overrode the user's
  // manual panning — the map moved and the list refused to follow. Releasing
  // the latch on every new answer keeps the Master rule intact (the visible
  // Leaflet viewport is the one coverage source) with no flash of the
  // pre-search area in between.
  const searchViewport = useMemo(
    () =>
      searchCenter
        ? {
            north: searchCenter.lat + 0.05,
            south: searchCenter.lat - 0.05,
            east: searchCenter.lng + 0.05,
            west: searchCenter.lng - 0.05,
          }
        : null,
    [searchCenter],
  );
  const coverageViewport = mapViewport ?? searchViewport;

  // PLACE RESULTS narrowed by the REAL VISIBLE VIEWPORT (product decision,
  // 2026-10-01). The 1 km / 5 km / 10 km+ tabs are CAMERA frames only and can
  // no longer decide which Places are listed: panning or zooming the map is
  // what changes the result. Search, LIVE, and the curated layer remain the
  // content filters above this step, and a Place without canonical
  // coordinates is dropped (it can never be inside a viewport, so listing it
  // would contradict the marker set). Nothing here re-orders or adds a Place.
  const listedPlaces = useMemo(
    () => narrowToViewport(visiblePlaces, coverageViewport),
    [visiblePlaces, coverageViewport],
  );

  const liveCards = useMemo(() => {
    if (liveItems.length === 0) return [];
    const listedIds = new Set(listedPlaces.map((place) => place.id));
    return liveItems.filter((item) => listedIds.has(item.placeId));
  }, [liveItems, listedPlaces]);

  // DISCOVERY PLACE ROW (canonical engine output, narrowed by the REAL
  // VISIBLE VIEWPORT). INTEGRITY (P0): this row is BUILT FROM the canonical
  // `discovery.discovery` result — its ids ARE the eligibility set, produced by
  // the engine from the canonical publication + readiness rules. The row is
  // never rebuilt from the published place list and never re-sorted: ranking
  // rank is presentation, not eligibility, so a published-but-ineligible
  // Place can never enter this row by having its rank appended as a fallback.
  // Search and the viewport only REMOVE entries from that canonical order;
  // neither adds nor re-orders one, and a viewport can never make an
  // ineligible Place eligible. Never deduplicated against the curated row: a
  // Place in both layers appears in both rows (OVERLAP rule).
  const discoveryRowPlaces = useMemo(() => {
    const canonical = (discovery?.discovery ?? []).flatMap((entry) => {
      const place = placeById.get(entry.placeId);
      return place && searchFilteredIds.has(place.id) ? [place] : [];
    });
    return narrowToViewport(canonical, coverageViewport);
  }, [discovery, placeById, searchFilteredIds, coverageViewport]);

  // TEMPAT PILIHAN ROW (Baris 1): published + canonical is_curated only,
  // through the same search gate and the SAME real-viewport narrowing as the
  // Discovery row, server order — curation is Admin-promoted, never
  // engine-ranked. Empty when nothing is curated; the row then renders nothing
  // and Baris 2 stands alone. There is never a fallback to all published
  // Places: an empty curated set is a real empty state.
  const curatedListed = useMemo(
    () => narrowToViewport(visiblePlaces.filter((place) => curatedIdSet.has(place.id)), coverageViewport),
    [visiblePlaces, curatedIdSet, coverageViewport],
  );

  // MAP DATASET — normal modes (PO, 2026-09-29): every content-filtered Place
  // with canonical coordinates, independent of the camera radius. Zooming out
  // after choosing 1 km/5 km now reveals Places that were simply outside
  // the frame — nothing is discarded upstream. Leaflet's viewport decides
  // which markers are visually on screen; a Place without lat/lng is still
  // never invented onto the map (fail-closed).
  //
  // "Tempat Pilihan" MAP COVERAGE (product decision, 2026-10-01): the curated
  // map still shows BOTH layers —
  //   1. every curated published Place (canonical `places.is_curated` only —
  //      the SAME set the curated LIST renders), and
  //   2. the NORMAL, non-curated published Places inside the REAL VISIBLE
  //      VIEWPORT.
  // The 10 km radius around the Current Location that used to define this
  // coverage is RETIRED: the viewport is the coverage source now. The second
  // group is a MAP COVERAGE rule only: those Places keep their ordinary
  // marker treatment, never become curated, never enter the curated LIST, and
  // never touch Discovery. Curated membership is still read only from the
  // canonical curated ids — there is no "empty curated set → show everything"
  // fallback for the list, and Discovery is never used as one.
  const curatedCoverageSource = useMemo(
    () => searchFiltered.filter((place) => !curatedIdSet.has(place.id)),
    [searchFiltered, curatedIdSet],
  );
  const curatedCoveragePlaces = useMemo(() => {
    if (!curatedOnly) return [];
    return narrowToViewport(curatedCoverageSource, coverageViewport);
  }, [curatedOnly, curatedCoverageSource, coverageViewport]);

  // CAMERA BOUNDS DATASET — LOCAL-AREA AUTO-FIT (product decision,
  // 2026-10-03; corrected twice the same day).
  //
  // This is the MAP DATASET with the VIEWPORT GATE REMOVED, and that single
  // difference is what lets the camera cover the whole local spread: the
  // markers are narrowed by the viewport (the 2026-10-01 coverage decision,
  // unchanged), so fitting the camera to THEM would be circular.
  //
  // ROOT CAUSE FIXED HERE: that un-narrowed dataset was the ENTIRE
  // content-filtered Place list, so one focus could fit West Java and Riyadh
  // into a single frame — a world view in which the user's own neighbourhood
  // was a couple of pixels wide. It is now bounded to the viewer's LOCAL AREA
  // (the same active center the coverage and the distance labels use):
  //   · the anchor Place's own canonical ISO country + subdivision when it has
  //     one (trusted geographic data, already validated on every Place write),
  //     so EVERY Place of the viewer's own area is covered;
  //   · otherwise a documented, data-derived separation — no fixed 10 km cap,
  //     no arbitrary replacement radius, and never the whole database;
  //   · with no usable center (geolocation denied and nothing searched) the
  //     set is EMPTY, so the camera keeps its current view instead of framing
  //     every Place on earth.
  //
  // SELECTED PLACES ("Tempat Pilihan", correction 2026-10-03 #2): in that
  // mode the candidates are the SELECTED Places themselves — exactly what
  // `visiblePlaces` already resolves from the canonical `places.is_curated`
  // ids. The ordinary non-curated remainder is a MARKER-layer decision (§15
  // item 2, still untouched in `mapPlaces`); it must not steer the CAMERA,
  // whose job there is to frame the selected distribution. Eligibility,
  // membership, the curated LIST, and the row counts are unchanged.
  //
  // It is display geometry only: membership still comes solely from the
  // canonical curated ids, no Place is added to or removed from any row by
  // this value, and it is never used as a filter. Coordinates are canonical
  // only — a Place without them is simply absent (no invented position).
  const selectedLocalArea = useMemo(
    () =>
      resolveLocalAreaCoverage({
        // The local-area origin is read from the SAME two state values the
        // active center resolves from (searched city first, then the real
        // fix), so the memo depends on stable state identities rather than on
        // a derived object — and a stale fix can never override a live search.
        origin: searchCenter ?? viewerPosition,
        places: toCameraCandidates(visiblePlaces),
      }),
    [visiblePlaces, searchCenter, viewerPosition],
  );

  // THE SELECTED DISTRIBUTION — the local area of the SELECTED Places, i.e.
  // the primary camera focus of the "Tempat Pilihan" choice. Unchanged from
  // the §18 rule: canonical membership only, coordinates only, never the
  // viewport, never a fallback to the whole dataset.
  const selectedFitPlaces = useMemo(() => toHomeMapPlaces(selectedLocalArea.places), [selectedLocalArea]);

  // CURATED CAMERA POOL — SELECTED PLACES + NEARBY CONTEXT (bug fix,
  // 2026-10-03).
  //
  // ROOT CAUSE of the over-tight frame: since §18 the curated camera pool was
  // `visiblePlaces` alone, which in that mode is the curated set — so the fit
  // framed exactly the pins that were already on screen and nothing around
  // them. One curated Place produced a single-point frame at
  // FIT_SINGLE_PLACE_ZOOM with no neighbourhood at all, which reads as a broken
  // zoom rather than as "here is your selection".
  //
  // The fix keeps every approved rule and only adds CONTEXT:
  //   · the SELECTED local area stays the primary focus and is never dropped;
  //   · the context is the ordinary, coordinate-valid Places of the SAME local
  //     area — resolved by re-running `resolveLocalAreaCoverage` ANCHORED ON
  //     THE SELECTED ANCHOR PLACE'S OWN COORDINATE, so the canonical ISO
  //     country/subdivision rule (or the scale-free proximity rule) decides it
  //     exactly as it does everywhere else;
  //   · anchoring on the selected anchor — never on the device fix — is what
  //     keeps the frame LOCAL: the context is drawn from the selection's own
  //     subdivision, so a distant Place (or a user standing on another
  //     continent) can never expand it to a regional or worldwide frame. It is
  //     also why "Tempat Pilihan" is no longer framed by the device alone;
  //   · context is CAMERA geometry only. It never enters the curated list, the
  //     curated count, curated membership, Discovery, or any row — those keep
  //     reading the canonical `places.is_curated` ids alone;
  //   · fail-closed: an empty local area, or a selected anchor without real
  //     coordinates, frames the SELECTED set alone (or nothing at all), and no
  //     coordinate is ever invented or defaulted.
  //
  // It still reads NO viewport state, so camera and viewport filtering remain
  // independent, and it is still keyed on `fitNonce` alone, so marker refreshes,
  // polls, and viewport reports cannot re-frame it.
  const cameraFitPlaces = useMemo<HomeMapPlace[]>(() => {
    const selected = selectedLocalArea.places;
    if (!curatedOnly || selected.length === 0) return toHomeMapPlaces(selected);
    const anchor = visiblePlaces.find((place) => place.id === selectedLocalArea.anchorId);
    if (!anchor || anchor.latitude === null || anchor.longitude === null) {
      return toHomeMapPlaces(selected);
    }
    const context = resolveLocalAreaCoverage({
      origin: { lat: anchor.latitude, lng: anchor.longitude },
      places: toCameraCandidates(curatedCoverageSource),
    }).places;
    const seen = new Set<string>();
    return toHomeMapPlaces(
      [...selected, ...context].filter((place) => {
        if (seen.has(place.id)) return false;
        seen.add(place.id);
        return true;
      }),
    );
  }, [curatedOnly, selectedLocalArea, visiblePlaces, curatedCoverageSource]);

  // "LOKASI SAYA" BOUNDS DATASET — the SAME local-area set, handed to the map
  // under its own prop and its own trigger (correction 2026-10-03).
  //
  // It is one value computed once, not a second resolution rule: the locate
  // press and the curated choice both frame the viewer's local area, they
  // simply fire from two different explicit actions. The origin is the REAL
  // fix (not the searched city): pressing "Lokasi Saya" clears the search first,
  // so `searchCenter` is already null when this recomputes.
  const locateFitPlaces = selectedFitPlaces;

  // CAMERA BOUNDS DATASET — LOCATION SEARCH AUTO-FIT (product decision,
  // 2026-10-03). The relevant Places for a searched region are the canonical
  // Places inside that region's own coverage box (the SAME rule the rows use
  // before Leaflet reports its real bounds) — never the current viewport, which
  // is still centred on the device and would make the fit circular, and never
  // the whole dataset, which would zoom to the country. Empty when the region
  // holds no Place with canonical coordinates, and the camera then keeps the
  // geocoding center instead.
  const searchFitPlaces = useMemo<HomeMapPlace[]>(() => {
    if (!searchViewport) return [];
    return narrowToViewport(visiblePlaces, searchViewport).flatMap((place) =>
      place.latitude === null || place.longitude === null
        ? []
        : [{ id: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude }],
    );
  }, [visiblePlaces, searchViewport]);

  const mapPlaces = useMemo<HomeMapPlace[]>(() => {
    // Curated Places first (they are the point of the layer), then the
    // ordinary Places inside coverage; a Place can only appear once.
    const source = curatedOnly ? [...visiblePlaces, ...curatedCoveragePlaces] : visiblePlaces;
    const seen = new Set<string>();
    return source.flatMap((place) => {
      if (seen.has(place.id)) return [];
      seen.add(place.id);
      if (place.latitude === null || place.longitude === null) return [];
      return [
        {
          id: place.id,
          name: place.name,
          latitude: place.latitude,
          longitude: place.longitude,
          // Per-Place curated flag: the marker treatment follows canonical
          // membership, never the whole mode (the curated map mixes both
          // kinds, so a mode-level flag could not tell them apart). Outside
          // the curated layer every Place keeps the ordinary treatment.
          isCurated: curatedOnly && curatedIdSet.has(place.id),
        },
      ];
    });
  }, [visiblePlaces, curatedCoveragePlaces, curatedOnly, curatedIdSet]);

  // MARKERS = the same canonical candidate set narrowed by the REAL VISIBLE
  // VIEWPORT (product decision, 2026-10-01): markers and the two Place rows
  // can therefore never disagree with the area on screen. Zooming or panning
  // changes only which markers exist — it never moves the camera, never
  // changes eligibility, and never re-orders or invents a Place.
  const visibleMapPlaces = useMemo(
    () => narrowToViewport(mapPlaces, coverageViewport),
    [mapPlaces, coverageViewport],
  );

  // Viewport-aware empty state (PO, 2026-09-30): the two situations stay
  // DISTINCT. (1) The canonical dataset itself is empty
  // (mapPlaces.length === 0 — nothing to show anywhere) → overlay on.
  // (2) The dataset has Places but NONE sits in the real viewport (that
  // report flips live with pan/zoom — see HomeMap's moveend/zoomend
  // evaluation) → overlay on, and it disappears again as soon as the user
  // reaches a populated area. Before the first report (Leaflet not ready yet)
  // only the dataset rule decides — no premature overlay, no stale one.
  const mapEmptyStateVisible =
    mapPlaces.length === 0 || (viewportReported && !viewportHasPlaces);

  // Header link target (bug fix 2026-10-01): a SCROLL to the first visible
  // strip — curated while the Tempat Pilihan mode is active and has results,
  // otherwise the Discovery strip. No all-results route exists in the MVP and
  // none may be created, so this never becomes a page link. null when no strip
  // is rendered, so the label stays a non-navigating label.
  const resultsAnchorId = resolveResultsAnchorId({
    curatedOnly,
    curatedCount: curatedListed.length,
    discoveryCount: discoveryRowPlaces.length,
  });

  // MOCKUP §8/§9: the consolidated information line names the ACTIVE camera
  // scope so the copy stays truthful — the exact preset that owns the camera
  // (1 km / 5 km / 10 km). "Tempat Pilihan" and "Lokasi Saya" frame the local
  // area, so they name no radius. Display only; never an invented state.
  const activeRadiusMeters = curatedOnly
    ? CURATED_CAMERA_RADIUS_M
    : CAMERA_PRESET_RADIUS_M[distanceFilter];
  const activeRadiusLabel =
    activeRadiusMeters >= 1000 ? `${activeRadiusMeters / 1000} km` : `${activeRadiusMeters} m`;
  // Whether there is an ORIGIN to measure from at all: the searched city, else
  // the real device fix, else nothing (geolocation denied and nothing
  // searched). The scope and the results count below both read it, so neither
  // can claim a radius or an origin the camera/rows never used.
  const hasActiveCenter = activeCenter !== null;
  // SCOPE FRAGMENT (bug fix, 2026-10-03): a radius may only be named while a
  // radius preset actually owns the frame. "Tempat Pilihan" and "Lokasi Saya"
  // frame the viewer's LOCAL AREA, so the old fixed "10 km" wording claimed a
  // radius the camera was not using; those modes now state the scope without
  // any distance at all.
  //
  // `hasActiveCenter` is the second half of that rule. With geolocation denied
  // and nothing searched, `activeCenter` is null, so the distance preset has NO
  // anchor at all and the camera never applied it — the map simply kept the
  // neutral world overview. No origin, no radius claim.
  //
  // It is a FRAGMENT, not a sentence: it carries no origin and no count, so
  // the consolidated line states the place name and the number exactly once and
  // cannot contradict itself.
  const coverageScope = describeCoverageScope({
    radiusLabel: activeRadiusLabel,
    coverage: cameraCoverage,
    hasCenter: hasActiveCenter,
  });
  // Results-count origin fragment (bug fix 2026-10-03). It resolves from the
  // SAME active center as the scope above it, so the results panel can
  // no longer say "di sekitar Anda" about a count that actually came from a
  // searched city. The device wording is the Master/MOCKUP §11 copy and is
  // preserved verbatim.
  const nearOrigin = describeNearOrigin({
    mode: activeSearch.mode,
    placeName: searchPlaceName,
    hasCenter: hasActiveCenter,
  });

  // ONE card renderer for every row: the existing card design verbatim; the
  // only addition is the optional "✦ Tempat Pilihan" marker so an overlap
  // Place stays recognizable inside the Discovery row. No numeric score is
  // ever rendered anywhere.
  const renderPlaceCard = (place: Place, isCurated: boolean) => {
    const live = liveByPlaceId.get(place.id);
    // Star slots (MOCKUP §16): canonical engine stars only (1–4). Anything
    // else renders five empty slots — never a fabricated rating.
    const stars = starsByPlaceId.get(place.id) ?? 0;
    // Direction target from the REAL canonical coordinates —
    // null when the Place has none (safe disabled control).
    const directionsUrl = buildDirectionsUrl(place);
    // Distance from the ACTIVE center (the searched city when one is active,
    // otherwise the device fix) — the same coordinate the coverage filter used
    // to admit this Place, so a label can never contradict the list it sits in.
    const distance =
      activeCenter && place.latitude != null && place.longitude != null
        ? formatDistance(
            distanceMeters(activeCenter, {
              lat: place.latitude,
              lng: place.longitude,
            }),
          )
        : null;

    return (
      <VisitedLink
        key={place.id}
        href={live ? `/live/${live.sessionId}` : `/places/${place.id}`}
        className="group flex h-full w-full flex-col overflow-hidden rounded-[16px] border border-black/10 bg-white shadow-sm transition hover:shadow-md"
        visitedClassName={live ? "border-live/60 bg-[#fdf6f2]" : "border-brand-accent/35 bg-[#faf6ee]"}
      >
        {/* CARD IMAGE — MOCKUP §13: every card carries an image area. When
            the Place has no canonical cover yet, a NEUTRAL DUMMY area keeps
            the mockup composition (visual placeholder only — no data change,
            no invented imagery, and the canonical cover still wins when it
            exists). */}
        <div className="relative h-[104px] w-full shrink-0 overflow-hidden bg-[#ece7db] sm:h-[124px]">
          {place.coverImageUrl ? (
            // External producer-supplied image URL; next/image would require
            // host allowlisting that producers cannot configure. Same
            // rationale and pattern as the Place detail hero.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={place.coverImageUrl}
              alt={`Gambar sampul ${place.name}`}
              className="h-full w-full object-cover transition group-hover:scale-[1.03]"
              loading="lazy"
            />
          ) : (
            // MOCKUP §16 (2026-10-01): the card image area must ALWAYS look
            // filled, so a Place without a canonical cover renders the LOCAL
            // neutral craft/production placeholder photo from
            // /public/place-cover-placeholder.svg (no icon block, no broken
            // image, no blank fill). It is PRESENTATION ONLY: a decorative
            // asset shipped with the app, never a Place photo, never stored,
            // never written to the database, and it never replaces the
            // canonical cover above. alt is empty and the element is
            // aria-hidden so it can never be announced as Place imagery.
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src="/place-cover-placeholder.svg"
              alt=""
              aria-hidden
              className="h-full w-full object-cover"
              loading="lazy"
            />
          )}

          {/* CARD OVERLAYS — MOCKUP §14: curated badge top-left, decorative
              heart top-right, REAL distance bottom-right. The distance stays
              fail-closed: it renders ONLY when the real fix and canonical
              Place coordinates both exist — never a fabricated number. */}
          {isCurated && (
            <span
              className="absolute left-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-lg bg-brand-secondary text-[11px] leading-none text-white shadow-sm ring-1 ring-white/50"
              title="Tempat Pilihan"
            >
              <span aria-hidden>✦</span>
              <span className="sr-only">Tempat Pilihan</span>
            </span>
          )}
          {/* No favorite feature exists in the MVP — the heart is DECORATIVE
              (aria-hidden, non-interactive) exactly as drawn in the mockup.
              It must never read as a saved-state control. */}
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-xs leading-none text-brand-ink shadow-sm"
          >
            ♡
          </span>
          {distance && (
            <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-0.5 rounded-full bg-brand-ink/75 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
              <span aria-hidden>➤</span>
              {distance}
            </span>
          )}
        </div>

        {/* CARD TEXT — MOCKUP §15/§17: name, short description, then the
            5-slot star row. Stars come ONLY from the canonical Discovery
            engine output (stars alone — the numeric score never leaves the
            server); a Place outside the engine (e.g. Live cards) shows five
            empty slots. NEVER a rating number, NEVER a review count — no
            such data exists in this product. */}
        <div className="flex flex-1 flex-col p-2.5">
          <h3 className="line-clamp-2 text-[13px] font-bold leading-tight">{place.name}</h3>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-black/55">
            {live?.processTitle ?? place.shortDescription}
          </p>
          {/* MOCKUP §9/§18: five star slots, always. The active slots take the
              gold tone OF THE ACTUAL rating value (1→4 from the canonical
              engine), the empty slots stay light gray, and no rating number
              or review count is ever rendered — neither exists in the data. */}
          <p className="mt-1.5 flex items-center gap-px" aria-hidden>
            {[1, 2, 3, 4, 5].map((slot) => (
              <span
                key={slot}
                className={`singgah-star ${
                  slot <= stars ? `singgah-star-active singgah-star-gold-${stars}` : "singgah-star-empty"
                }`}
              >
                ★
              </span>
            ))}
          </p>

        {/* Card meta row (PO 2026-09-26): real distance (only
            when the real viewer fix exists) + Direction from the
            Place's canonical coordinates. No operating-hours
            status: the Place model has no operating-hours field
            yet (DATA GAP), and no hours are ever invented.
            MOCKUP §8 moved the distance and the curated badge ONTO the cover
            image, so they are no longer repeated here — the same canonical
            values, shown once, and still only when they really exist. */}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {/* Follow control (User → Place follow foundation for
              MASTER 10 notifications): server-derived state only
              — Follow / Following, signed-out → /auth. Sits next
              to Direction; card navigation/design untouched. */}
          {!live && <PlaceFollowButton placeId={place.id} />}
          {directionsUrl ? (
            <button
              type="button"
              onClick={(event) => {
                stopNestedCardAction(event);
                window.open(directionsUrl, "_blank", "noopener,noreferrer");
              }}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-accent/40 px-3 py-1.5 text-[11px] font-bold text-brand-accent transition hover:bg-brand-accent/10"
              aria-label={`Petunjuk arah ke ${place.name} di aplikasi peta`}
            >
              <span aria-hidden>➤</span> Direction
            </button>
          ) : (
            // Fail-closed: no canonical coordinates → no
            // navigation target is ever invented.
            <span
              aria-disabled="true"
              title="Koordinat Tempat belum tersedia"
              className="ml-auto inline-flex shrink-0 cursor-not-allowed items-center gap-1 rounded-full border border-black/10 px-3 py-1.5 text-[11px] font-bold text-black/35"
            >
              <span aria-hidden>➤</span> Direction
            </span>
          )}
        </div>

        {/* Permanent Live identity (PO 2026-09-26): every Place
            card carries its own LIVE affordance in BOTH states.
            With an active session it opens the existing
            /live/[sessionId] flow; without one it shows the
            honest not-live status when pressed. Live state is
            never invented — liveByPlaceId (canonical
            live_sessions feed) is the only source. */}
        <div className="mt-2">
          {live ? (
            <button
              type="button"
              onClick={(event) => {
                stopNestedCardAction(event);
                router.push(`/live/${live.sessionId}`);
              }}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-live px-3 py-2 text-[11px] font-bold text-white transition hover:opacity-90"
              aria-label={`Buka Live di ${place.name}`}
            >
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
              LIVE — Lihat proses sekarang
            </button>
          ) : (
            <>
              <button
                type="button"
                aria-pressed={nonLiveNoticePlaceId === place.id}
                onClick={(event) => {
                  stopNestedCardAction(event);
                  setNonLiveNoticePlaceId((current) => (current === place.id ? null : place.id));
                }}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-live/40 bg-white px-3 py-2 text-[11px] font-bold text-live transition hover:bg-live/10"
                aria-label={`Status Live ${place.name}`}
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-live/60" />
                LIVE — Belum berlangsung
              </button>
              {nonLiveNoticePlaceId === place.id && (
                <p
                  role="status"
                  className="mt-1.5 rounded-lg bg-live/10 px-3 py-1.5 text-[11px] font-semibold text-live"
                >
                  {place.name} sedang tidak Live. Tempat ini dapat memulai Live kapan saja.
                </p>
              )}
            </>
          )}
        </div>
        </div>
      </VisitedLink>
    );
  };

  return (
    <main className="relative min-h-screen bg-brand-cream text-brand-ink">
      {/* MAP-FIRST STAGE (MOCKUP §4/§5/§7, 2026-10-01) — the map is now ONE
          continuous visual field: it starts at the very top of the app and
          runs down to the edge of the Result panel, and the Header, Search
          bar, and Filter bar simply FLOAT on top of it. There is no separate
          background block and no cream gap that would break the composition.

          The stage is a `relative isolate overflow-hidden` stacking context
          that clips the map; the map itself is `absolute inset-0` at the base
          layer (z-0), and every floating element rides on the documented
          OVERLAY_LADDER above Leaflet's ceiling (1000): search + filter +
          map overlays at 1100, the header at 1200. Tiles can therefore never
          paint over the chrome, and the chrome never intercepts the map
          surface itself. Presentation only — camera, markers, filters,
          search, and handlers are untouched. */}
      <section className="relative isolate overflow-hidden bg-[#d9dfd2]">
        {/* Map base layer — full-bleed behind ALL floating chrome. */}
        <div className="absolute inset-0 z-0">
          <HomeMap
            places={visibleMapPlaces}
            liveByPlaceId={liveByPlaceId}
            viewerPosition={viewerPosition}
            locateNonce={locateNonce}
            onRequestLocate={handleLocatePress}
            /* The REAL visible viewport is reported back here: it is the ONE
               geographic coverage source for the markers and for the Discovery
               Place / "Tempat Pilihan" rows. It carries geometry only — it
               never changes eligibility, membership, or the camera. */
            /* ONE deterministic camera preset for every mode (PO,
               2026-09-29; coverage unified by the product decision of
               2026-09-30): distance tabs map to their ordered preset radii
               (1 < 5 < 10 km) and "Tempat Pilihan" frames the SAME 10 km
               coverage. CAMERA-ONLY — the curated membership (canonical
               is_curated) and the curated LIST below stay independent of
               this value. */
            cameraRadiusMeters={
              curatedOnly ? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M[distanceFilter]
            }
            /* The radius preset re-frames the ACTIVE center, not the device
               unconditionally: changing 1 km → 5 km while a city is searched
               must keep that city in the middle instead of yanking the camera
               back to the device fix. Null only when NO center is usable at
               all, in which case the map keeps its current view and no
               coordinate is invented. */
            cameraCenter={activeCenter}
            /* LOCATION SEARCH recenter (PO 2026-10-02): the server-parsed
               canonical center moves the camera once per NEW answer. The
               radius preset above is untouched — the search recenters within
               whatever frame the active preset already owns, so the tab the
               user picked is never silently rewritten. */
            searchCenter={searchCenter}
            searchNonce={searchNonce}
            /* AUTO-FIT CAMERA (product decision, 2026-10-03): the camera frames
               the SPREAD of the relevant Places instead of a fixed 10 km frame
               around one point. `cameraFitPlaces` is the MAP DATASET with the
               viewport gate REMOVED — deliberately NOT the narrowed marker set,
               so viewport, marker filtering, and camera can never form a
               circular dependency. `fitNonce` is bumped ONLY by choosing
               "Tempat Pilihan", so no marker refresh, discovery poll, or
               viewport report can ever recenter the camera in a loop. */
            fitPlaces={cameraFitPlaces}
            fitNonce={fitNonce}
            /* "LOKASI SAYA" BOUNDS (correction, 2026-10-03): the explicit
               "My Location" press frames the viewer's LOCAL AREA — the same
               eligible Places, bounded upstream by their canonical country +
               subdivision (with the documented proximity fallback), plus the
               user's own coordinate inside the map component. No 10 km radius,
               no whole-dataset fit, and a separate prop so the curated
               refocus and the locate refocus can never fire for each other's
               reason. An empty local area focuses the user's coordinate alone;
               no fix at all means no camera move. */
            locateFitPlaces={locateFitPlaces}
            /* The Places relevant to the SEARCHED region (canonical, no
               viewport gate). A new search answer frames their spread instead
               of only the geocoder's city point; an empty set keeps that
               center, and no coordinate is ever invented. */
            searchFitPlaces={searchFitPlaces}
            /* Instant-camera rule (PO, 2026-09-30): the camera itself applies
               with no animation at all, so entering "Tempat Pilihan" is made
               visually obvious by a SHORT one-shot focus pulse on the
               EXISTING Current Location pin — no new marker, no map
               animation. */
            pulsePinOnPresetChange={curatedOnly}
            onViewportHasPlaces={handleViewportHasPlaces}
            onViewportChange={handleViewportChange}
            onScaleChange={handleScaleChange}
            /* EXPLICIT CAMERA REQUEST (product decision, 2026-10-03): the three
               hand-driven camera actions bump this nonce, which releases the
               map's interaction latch so the frame THEY produce stays. Nothing
               else carries a nonce, so no marker refresh, discovery poll,
               viewport report, or fresh geolocation fix can take the camera
               back afterwards. */
            cameraRequestNonce={cameraRequestNonce}
          />
        </div>

        {/* Header + auth entry (Masuk / Sign out) + URL-derived active tabs —
            FLOATING over the map (MOCKUP §1/§5). Presentation only: the
            header keeps its logo, nav, and auth behavior verbatim. */}
        <SiteNav floating />

        {/* Search + Filter — floating chrome above the map surface. They stay
            in the normal flow (no fragile absolute offsets), so the stage
            height is simply chrome + map area and nothing can overlap.
            POINTER EVENTS (root-cause fix, 2026-10-01): this wrapper spans
            the whole map window (it also holds the invisible map-height
            spacer), so it used to sit over the Leaflet surface as an
            invisible pointer target — the zoom controls and every drag/pinch
            on the map area were swallowed by it. The wrapper is therefore
            click-through (pointer-events-none) and only its real controls
            (search bar, filter row) opt back in. Nothing about the map
            surface, its markers, or the layout changes. */}
        <div className="relative z-[1100] pointer-events-none mx-auto w-full max-w-6xl px-4">
          {/* Search — MOCKUP §2: floating white bar, search icon LEFT and the
              right control. The right side is CONDITIONAL (2026-10-04): while
              the box is non-empty it is a real clear button (×, aria-labelled);
              while the box is empty it is the decorative sliders/control icon
              (aria-hidden, non-interactive) — no search-settings feature exists,
              and none is invented. Typing never searches: the ONE search runs on
              Enter/submit only (submit-only, 2026-10-04). */}
          <div className="pointer-events-auto mt-[60px] sm:mt-[64px]">
            <div className="flex items-center gap-2.5 rounded-[20px] border border-black/10 bg-white px-3.5 py-2.5 shadow-[0_2px_10px_rgb(0_0_0/0.10)]">
              <span className="shrink-0 text-base leading-none text-brand-ink" aria-hidden>⌕</span>
              <input
                className="w-full bg-transparent text-sm outline-none placeholder:text-black/40"
                placeholder="Cari tempat, cerita, produksi..."
                value={searchQuery}
                onChange={(event) => handleSearchChange(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                aria-label="Cari tempat, cerita, produksi"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={handleSearchClear}
                  className="shrink-0 rounded-full bg-black/5 p-1 text-black/45 transition hover:bg-black/10"
                  aria-label="Hapus pencarian"
                >
                  <span aria-hidden>×</span>
                </button>
              ) : (
                <span aria-hidden className="shrink-0 leading-none text-black/45">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
                    <circle cx="16" cy="7" r="2.2" />
                    <circle cx="10" cy="12" r="2.2" />
                    <circle cx="18" cy="17" r="2.2" />
                  </svg>
                </span>
              )}
            </div>
            {/* LOCATION SEARCH status (PO 2026-10-02; coordinate readout
                REMOVED 2026-10-04): ONE source of truth for the geocoder
                flow. It only REPORTS server state; it never runs a second
                search, never edits the input, and never decides which Places
                are listed. aria-live="polite" so the outcome is announced
                without interrupting typing.

                THE RESOLVED-CENTER BRANCH IS GONE. `region`/latitude/longitude
                is deliberately NOT surfaced in the Home UI any more: the Home
                screen is a discovery surface, not a survey instrument, and the
                raw readout was a permanent opaque strip that ate vertical
                space the map needs. NOTHING geographic was removed with it —
                `searchCenter` itself, the geocoding call, the ±0.05° search
                box, the camera center, the coverage origin, and every
                geographic calculation all still read the same state, exactly
                as before. Only the human-facing rendering of two numbers is
                gone.

                The banner is now gated on `searchPending || searchError`
                rather than on a non-empty query, so it exists ONLY while a
                search is actually running or actually failed. That is what
                guarantees no empty strip and no reserved gap is left where the
                old coordinate panel used to sit: a resolved search renders
                nothing at all. */}
            {(searchPending || searchError) && (
              /* SEARCH INFO PANEL — FULL WIDTH, SOLID (product decision,
                 2026-10-03). Two real defects are fixed here, presentation
                 only, with no change to the text, the data, or the ARIA
                 status semantics:
                 1. WIDTH — the panel used to sit inside the padded, capped
                    content column, so it stopped short of both screen edges and
                    read as a small floating card. The outer wrapper cancels
                    both the horizontal padding AND the max-width cap:
                    `-mx-4` moves it to the padded column's edge, `w-[100vw]`
                    plus `left-[calc(50%_-_50vw)]` re-centres it on the VIEWPORT
                    (exact at every width, including a desktop wider than the
                    72rem column), so the panel spans left → right. The map
                    stage is `overflow-hidden`, so the full-bleed row can never
                    create page-level horizontal scroll.
                 2. BACKGROUND — the old panel background was a TRANSLUCENT white,
                    so the map tiles
                    showed through the text. It is now an OPAQUE surface
                    (a plain opaque white, and an opaque tint for the
                    error state), with a
                    soft shadow instead of rounded corners, because an
                    edge-to-edge bar with rounded ends would look like a bug.
                 The copy inside is unchanged: pending / error only. */
              <div className="-mx-4 relative left-[calc(50%_-_50vw)] w-[100vw]">
              <p
                role="status"
                aria-live="polite"
                className={`mt-2 flex w-full items-center gap-2 px-4 py-2 text-xs shadow-[0_2px_10px_rgb(0_0_0/0.10)] sm:px-6 ${
                  searchPending ? "bg-white text-black/55" : "bg-[#fcebe7] text-live"
                }`}
              >
                {searchPending ? (
                  <>
                    <span aria-hidden className="h-3.5 w-3.5 animate-pulse rounded-full bg-black/25" />
                    <span>Mencari lokasi…</span>
                  </>
                ) : searchError ? (
                  <>
                    <span aria-hidden className="h-3.5 w-3.5 rounded-full bg-live/60" />
                    <span>{searchError}</span>
                  </>
                ) : null}
              </p>
              </div>
            )}
          </div>

          {/* Home filter bar — ONE row (PO 2026-09-26; MOCKUP §3): LIVE
              leftmost, "Tempat Pilihan" directly beside it, then the
              distance tabs. All controls share the row via grid columns — no
              wrap, no second row, no page-level horizontal overflow at
              360 px. Compact text [11px]/padding/gap keeps everything visible
              on the smallest supported viewport; labels keep the master copy
              ("10 km+" is master-locked). "Tempat Pilihan" opens ONE curated
              discovery layer with no category tabs/chips.

              MOCKUP §3 selected state: the active control is BRAND GREEN
              (bg-brand-primary), the distance tabs keep their white surface,
              and LIVE keeps its red dot. Selection logic, handlers, and
              semantics are completely unchanged — only the colors moved. */}
          <div className="pointer-events-auto mt-2.5 grid grid-cols-[auto_auto_1fr_1fr_1fr] gap-1.5">
            <button
              onClick={() => {
                // Mutually exclusive modes (lib/live/ui.ts): turning LIVE on
                // leaves "Tempat Pilihan"; turning it off changes nothing
                // else (curated layer and distance tab keep their state).
                const next = toggleLiveFilter(liveOnly, curatedOnly);
                setLiveOnly(next.liveOnly);
                setCuratedOnly(next.curatedOnly);
              }}
              aria-pressed={liveOnly}
              className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-[16px] px-2 py-1.5 text-[11px] font-bold tracking-wide shadow-sm transition sm:px-3.5 sm:text-xs ${
                liveOnly
                  ? "bg-live text-white"
                  : "border border-live/40 bg-white text-live"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${liveOnly ? "bg-white" : "bg-live"}`} />
              LIVE
            </button>
            <button
              onClick={() => {
                // Same exclusivity rule from the curated side: LIVE off,
                // whatever was active before.
                const next = activateCuratedFilter();
                setCuratedOnly(next.curatedOnly);
                setLiveOnly(next.liveOnly);
                // Choosing the tab is the EXPLICIT refocus action the camera
                // is allowed to act on (product decision, 2026-10-03): it fits
                // the frame to the spread of the relevant Places. No other
                // state change carries a nonce, so the camera can never be
                // taken back by a later marker or viewport update.
                setFitNonce((nonce) => nonce + 1);
                setCameraCoverage("area");
                setCameraRequestNonce((nonce) => nonce + 1);
              }}
              aria-pressed={curatedOnly}
              className={`whitespace-nowrap rounded-[16px] px-2 py-1.5 text-[11px] font-bold shadow-sm transition sm:px-3.5 sm:text-xs ${
                curatedOnly
                  ? "bg-brand-primary text-white"
                  : "border border-brand-ink/20 bg-white text-brand-ink/70"
              }`}
            >
              Tempat Pilihan
            </button>
            {DISTANCE_FILTERS.map((filter) => (
              <button
                key={filter}
                onClick={() => {
                  setDistanceFilter(filter);
                  setCuratedOnly(false);
                  // A distance tab really does frame this radius, so the
                  // caption may name it again — and the tab is an explicit
                  // camera request, which releases the latch.
                  setCameraCoverage("radius");
                  setCameraRequestNonce((nonce) => nonce + 1);
                }}
                aria-pressed={distanceFilter === filter && !curatedOnly}
                className={`whitespace-nowrap rounded-[16px] px-1 py-1.5 text-center text-[11px] font-bold shadow-sm transition sm:px-3.5 sm:text-xs ${
                  distanceFilter === filter && !curatedOnly
                    ? "bg-brand-primary text-white"
                    : "border border-black/10 bg-white text-black/65"
                }`}
              >
                {filter}
              </button>
            ))}
          </div>

          {/* MAP AREA (MOCKUP §4/§8) — the visible map window under the floating
              chrome. The stage height is chrome + this area, so the Result
              panel always starts inside the initial viewport at every
              supported size (360 / 390 / 430 / 1280) while the map stays the
              dominant field. Sized in vh + clamp: never the old flat 64vh,
              and never so tall that Result is pushed out of sight. The
              container keeps a valid, non-degenerate Leaflet size.
              MOBILE MAP BUDGET (fix, 2026-10-03): the band is
              now sized from the floating control ladder, which is a FIXED
              amount of the stage's height and was simply being clipped:
                · Re-center arrow        top 190px → ends 234px
                · "Lokasi Saya" control  top 240px → ends ~281px
                · Leaflet +/- stack      top 290px → ends ~354px
                · scale chip             bottom 36px → start ~366px
              At the previous min-height of 240px the section ended ABOVE the
              bottom of the zoom control, so on an ordinary phone the +/- stack
              was cut off by the section's own `overflow-hidden` — essential map
              context removed by the layout itself, and the map/results
              relationship made unclear. The floor is now 440px, which fits the
              entire ladder plus the scale chip at every supported height
              (360 / 390 / 430 / 1280), and 42vh / 46vh keeps the map the
              dominant field on taller screens. Nothing was cut, hidden, or
              redesigned: same sections, same chrome, same cards — the map
              simply gets the height its own controls need.

              MAP WINDOW RE-SIZED (product decision, 2026-10-04): the band is
              now `56vh` (`62vh` from `sm:`), floor 460px, ceiling 680px — up
              from 42vh/46vh, 440px, 560px. The reclaimed height comes from the
              two layout changes around it, NOT from the camera:
                · the coordinate strip no longer reserves a row, and
                · the results info block floats ON the map instead of sitting
                  under it in the flow.This is CANVAS ONLY. The geographic rules are untouched —
              the distance-tab presets, the curated camera radius, the
              local-area resolver, the ±0.05° search box, and every
              fit-padding and zoom constant are exactly as before, so nothing is
              zoomed out or widened to make the map look bigger; the same frame
              simply has more pixels to live in. The 460px floor still clears
              the whole floating control ladder (190 / 240 / 290 + 64px) and now
              also carries the floating results card at every supported size. */}
          <div aria-hidden className="h-[56vh] min-h-[460px] max-h-[680px] sm:h-[62vh]" />
        </div>

        {/* Viewport-aware map empty state (PO, 2026-09-30): shown when the
            mode's dataset is empty OR when no Place currently sits in the
            REAL Leaflet viewport — it disappears/appears live as the user
            pans/zooms between populated and empty areas. Markers only ever
            come from canonical coordinates; none are invented, and the
            overlay never pretends a hidden Place is on the map.
            OVERLAY_LADDER: Leaflet's highest documented z-index is 1000
            (zoom control); z-[1100] pins this card strictly above every
            Leaflet pane (tile 200, map pane 400, tooltip 650, control
            1000) in any drag/zoom state. */}
        {mapEmptyStateVisible && (
          /* COMPACT overlay (bug fix 2026-10-03). The copy is unchanged — an
             empty state must stay an honest empty state — but the card no
             longer spans the map: the wrapper is a centered flex line, the
             card itself is content-sized (w-fit) and capped at 20 rem, soit covers the smallest possible area and WRAPS instead of growing
             when the sentence is long or the screen is narrow. Padding, text
             size and shadow are reduced, and it stays clear of the Leaflet
             controls.

             RAISED to `bottom-32` (2026-10-04): the floating results card now
             owns the map's bottom-left corner, and its height is not fixed —
             a long search query wraps the panel title to a second line and
             grows the card by roughly one more row. At `bottom-24` those two
             cards could touch when a search returned nothing (empty state up,
             floating results card down, both centered and overlapping
             horizontally). `bottom-32` clears a two-line title with room to
             spare, and the 460px map floor leaves ample space above it. */
          <div className="pointer-events-none absolute inset-x-0 bottom-32 z-[1100] flex justify-center px-4">
            <div className="w-fit max-w-[min(20rem,100%)] rounded-xl bg-white/95 px-3 py-1.5 text-center shadow-md ring-1 ring-brand-ink/10">
              <p className="text-[11px] font-semibold leading-4 text-brand-ink">
                {curatedOnly
                  ? "Belum ada Tempat Pilihan di sekitar area ini"
                  : "Belum ada Tempat Terdaftar di sekitar area ini"}
              </p>
              <p className="mt-0.5 text-[10px] leading-3.5 text-black/55">
                Geser peta dengan dua jari untuk melihat area lain.
              </p>
            </div>
          </div>
        )}

        {/* CONSOLIDATED INFORMATION AREA (bug fix, 2026-10-03).
            The floating coverage box that used to sit here is GONE. It restated
            the same geographic fact the results panel one screen lower already
            gave — the origin and the scope — in two different shapes, and it
            permanently covered the bottom-left of the map. Both facts now live
            on ONE compact line in the results panel header (count · origin ·
            scope), so the map surface is free, the origin is stated exactly
            once, and the two can never contradict each other.
            The measured SCALE BAR below is deliberately untouched: it is map
            chrome describing the visible map, not Home result context, and it
            stays bottom-right where it never overlapped anything. */}

        {/* MOCKUP §9: scale, bottom-right of the map — a REAL scale bar (bug
            fix, 2026-10-03). It used to print the active camera RADIUS as if
            it were the map's scale, so a fixed "10 km" sat above a bar of an
            unrelated length. The map now measures its own viewport and reports
            the round distance the bar really stands for, drawn at its exact
            pixel length. Nothing measurable yet (unmeasured container) draws no
            scale rather than a made-up number. It sits above the OSM
            attribution so the two never collide. */}
        {mapScale && (
          <div className="pointer-events-none absolute bottom-9 right-4 z-[1100] flex flex-col items-end gap-1">
            <span className="rounded bg-white/80 px-1 text-[11px] font-bold leading-4 text-brand-ink">
              {mapScale.label}
            </span>
            <span
              aria-hidden
              className="block h-0.5 border-x-2 border-b-2 border-brand-ink/70"
              style={{ width: mapScale.barPx }}
            />
          </div>
        )}

        {/* RESULTS INFO — FLOATING OVER THE MAP (product decision,
            2026-10-04).

            WHAT CHANGED: only WHERE this block is painted. The result title,
            the count, the origin/coverage context, and the "Ke hasil" action
            are the same strings, the same numbers, and the same anchor as
            before; it still scrolls to the same strips and still renders as
            plain text when there is nothing to scroll to.

            WHY: it used to sit in the page flow directly UNDER the map, so it
            cost the map a full strip of height and pushed the cards down. It
            now rides ON the map's own bottom edge, so the map keeps that
            height and the panel no longer claims a second, separate band.

            THE GEOMETRY, AND WHY IT COLLIDES WITH NOTHING:
            · `bottom-3` — below the map's own bottom overlays: the scale bar
              (bottom-9, right) and the empty-state card (bottom-24), so both
              stay fully readable above it.
            · `pr-[5.5rem]` — the card stops short of the right edge so the
              REAL scale bar, which is genuinely useful map chrome, is never
              covered by it.
            · `z-[1100]` — the documented overlay ladder, above Leaflet's
              ceiling (1000), same as every other floating Home element. It is
              deliberately NOT on the header's higher tier and NOT a
              viewport-fixed element: it lives inside the `relative isolate
              overflow-hidden` map stage, so it is clipped with the map, moves
              with it, and cannot fight the top navigation or create a second
              scroll layer.
            · `bg-white/95` + `backdrop-blur-sm` — visually distinct from the
              tiles while the map stays visible around it, rather than an
              opaque bar that would read as "the map stops here".
            · `pointer-events-none` on the wrapper, re-enabled on the card, so
              the sliver of map beside the card still pans and zooms. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[1100] mx-auto w-full max-w-6xl px-4 pr-[5.5rem]">
          <div className="pointer-events-auto rounded-2xl bg-white/95 px-3 py-2 shadow-[0_6px_20px_rgb(0_0_0/0.14)] ring-1 ring-black/5 backdrop-blur-sm">
            {/* Panel handle — small centered bar, mockup §10 (visual only). */}
            <span aria-hidden className="mx-auto mb-1 block h-1.5 w-12 rounded-full bg-black/15" />
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 id="place-results-heading" className="text-lg font-bold leading-tight">
                  {searchQuery.trim()
                    ? `Hasil untuk “${searchQuery.trim()}”`
                    : curatedOnly
                      ? "Tempat Pilihan"
                      : "Discovery Place"}
                </h2>
                <p className="mt-1 text-[11px] font-semibold text-black/50">
                  {/* Count semantics (PO, 2026-09-30): each layer counts ONLY
                      its own rows — the Tempat Pilihan header counts the
                      curated selection (Baris 1), never the Discovery Place row
                      beneath it; normal modes keep the Discovery Place count.
                      The numbers are the exact arrays each row renders from, so
                      the count can never disagree with the cards on screen; the
                      ORIGIN fragment follows the active search center (bug fix
                      2026-10-03) instead of always claiming "di sekitar Anda". */}
                  {curatedOnly
                    ? `${curatedListed.length} tempat pilihan ${nearOrigin} · ${coverageScope}`
                    : `${discoveryRowPlaces.length} tempat ${nearOrigin} · ${coverageScope}`}
                </p>
              </div>
              {/* "Ke hasil" (bug fix 2026-10-01) — non-inventive affordance:
                  there is NO separate all-results page in the MVP (only
                  /places/[id] exists), so this only SCROLLS to the first
                  visible strip and never claims to open every Place. The label
                  says exactly that. With no results at all there is no strip to
                  scroll to, so the same label renders as plain text (no dead
                  anchor). */}
              {resultsAnchorId ? (
                <a
                  href={`#${resultsAnchorId}`}
                  className="inline-flex shrink-0 items-center gap-0.5 text-xs font-bold text-brand-ink/80 transition hover:text-brand-ink"
                >
                  Ke hasil <span aria-hidden>›</span>
                </a>
              ) : (
                <span className="shrink-0 text-xs font-bold text-black/35">Ke hasil</span>
              )}
            </div>
          </div>
        </div>

      </section>

      <section className="mx-auto max-w-6xl px-4 pb-8">
        {/* "Tempat Pilihan" is ONE curated discovery layer (PO 2026-09-26):
            no category chips and no secondary category row — Place
            categories stay internal data, never a Home filter UI. */}

        {/* LIVE filter empty state — a clear notice instead of an empty
            screen. Based only on canonical discovery data; no fake Live. */}
        {liveOnly && liveItems.length === 0 && (
          <div className="mt-4 rounded-2xl border border-live/30 bg-white p-6 text-center shadow-sm">
            <p className="text-sm font-bold">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className="mt-1 text-xs text-black/55">
              Ketika sebuah Tempat memulai Live, proses produksinya otomatis muncul di sini.
            </p>
            <button
              type="button"
              onClick={() => setLiveOnly(false)}
              className="mt-4 inline-flex rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white"
            >
              Lihat Semua Tempat
            </button>
          </div>
        )}

        {/* LIVE SEKARANG cards — hidden inside the Tempat Pilihan layer
            (the curated layer is discovery of collections, not Live state). */}
        {!curatedOnly && liveCards.length > 0 && (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {liveCards.map((item) => {
              const place = places.find((candidate) => candidate.id === item.placeId);
              // Distance from the ACTIVE center (searched city, else the device
              // fix) to canonical Place coordinates only (PO item 7). Omitted
              // when either side is unavailable — never computed from an
              // invented reference point.
              const distance =
                activeCenter && place?.latitude != null && place?.longitude != null
                  ? formatDistance(distanceMeters(activeCenter, { lat: place.latitude, lng: place.longitude }))
                  : null;
              return (
                <VisitedLink
                  key={item.sessionId}
                  href={`/live/${item.sessionId}`}
                  className="group rounded-2xl border border-live/30 bg-white p-4 shadow-sm transition hover:shadow-md"
                  visitedClassName="border-live/60 bg-[#fdf6f2]"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-white">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                      Live Sekarang
                    </span>
                    <span className="text-[10px] font-bold text-black/45">
                      {liveDurationLabel(item.startedAt)} • {item.viewerPeak}/100
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-semibold">{item.processTitle ?? "Proses produksi"}</p>
                  <p className="mt-0.5 text-xs text-black/55">
                    {place?.name ?? item.placeName} • {place?.area ?? ""}
                  </p>
                  <p className="mt-2 text-[11px] font-bold text-brand-accent">
                    {distance ? `${distance} • ` : ""}
                    {place?.type === "production" ? "Sedang berproduksi" : "Sedang aktif"}
                  </p>
                </VisitedLink>
              );
            })}
          </div>
        )}

        {/* Place results — the DISCOVERY PLACE row is always built from the
            canonical `discovery.discovery` result (eligible Places only, in
            engine order), narrowed by search and the list radius. Inside the
            Tempat Pilihan layer the results render as TWO ordered rows —
            Baris 1: Tempat Pilihan, Baris 2: Discovery Place — while every
            other mode renders that single canonical row. No layer ever
            deduplicates the other: a Place in both layers appears in both
            rows (OVERLAP rule).

            MOCKUP §10/§11 (2026-10-01): the results are a WHITE PANEL with
            rounded top corners and a small centered handle that VISUALLY
            MERGES with the map above it (a small negative margin tucks it
            under the map frame). It is still a normal section in the page
            flow — the map keeps its full height and clipping boundary, and
            nothing ever covers the map surface (locked by
            tests/map-stacking.test.ts). The count line doubles as the
            mockup's "{n} tempat pilihan di sekitar Anda" subtitle.
            COMPACTED (correction, 2026-10-03): the handle, the header block,
            and both carousel frames each gave up ~8–10 px of vertical padding
            they did not need, so the panel now sizes to its content. The title,
            the count, the "Ke hasil" link, the category labels, and both strips
            are UNCHANGED — nothing was hidden, truncated, or made scrollable. */}
        <section
          className="relative z-10 rounded-t-[24px] bg-brand-cream pb-1 pt-1 shadow-[0_-6px_18px_rgb(0_0_0/0.06)]"
          aria-labelledby="place-results-heading"
        >
          {/* The result TITLE / COUNT / "Ke hasil" block now FLOATS over the
              map (product decision, 2026-10-04) — see the floating panel
              inside the map stage above. It is still this section's accessible
              name (`aria-labelledby` resolves by id across the tree), and the
              "Ke hasil" anchor still scrolls to the strips rendered below, so
              nothing about the panel's content or navigation changed — only
              where the block is painted.

              This section therefore holds ONLY the Place-card strips, and the
              `-mt-5` tuck that pulled it under the map frame is gone: the
              floating card now owns that seam, and the two must not overlap. */}

          {/* Baris 1 (curated layer only): the Admin-promoted selection.
              Renders nothing when no Place is curated — the curated layer
              never substitutes the full published set.
              MOCKUP §12 (2026-10-01): the row is a VERTICAL LIST at every
              viewport — same dataset, same order, same cards; presentation
              only. */}
          {curatedOnly && curatedListed.length > 0 && (
            <>
              <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-brand-ink/70">
                Tempat Pilihan
              </p>
              <div
                id={CURATED_RESULTS_ANCHOR_ID}
                className="-mx-4 flex flex-col gap-2.5 px-4 pb-1"
              >
                {curatedListed.map((place) => (
                  <div key={place.id} className="w-full">
                    {renderPlaceCard(place, place.isCurated)}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Baris 2 (curated layer) / the single row everywhere else: the
              canonical Discovery result — engine order, stars only, no
              numeric score. Source of eligibility is the engine's own
              discovery.discovery ids, never the published place list. */}
          {discoveryRowPlaces.length > 0 ? (
            <>
              {curatedOnly && (
                <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-brand-ink/70">
                  Discovery Place
                </p>
              )}
              {/* MOCKUP §12 (2026-10-01): vertical list at EVERY viewport —
                  the same vertical-list pattern as Baris 1. Same dataset, same
                  order, same cards (presentation only). */}
              <div
                id={DISCOVERY_RESULTS_ANCHOR_ID}
                className="-mx-4 flex flex-col gap-2.5 px-4 pb-1"
              >
                {discoveryRowPlaces.map((place) => (
                  <div key={place.id} className="w-full">
                    {renderPlaceCard(place, curatedIdSet.has(place.id))}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-black/10 bg-white px-4 py-5 text-center">
              {searchQuery.trim() ? (
                <>
                  <p className="text-sm font-bold">Tempat tidak ditemukan</p>
                  <p className="mt-1 text-xs text-black/55">
                    Coba kata kunci atau radius yang berbeda.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold">Belum ada Discovery Place</p>
                  <p className="mt-1 text-xs text-black/55">
                    Tempat yang siap tayang akan muncul di sini secara otomatis.
                  </p>
                </>
              )}
            </div>
          )}
        </section>

        {/* Intro */}
        <section className="px-1 pb-4 pt-8">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand-accent">
            SINGGAH LOKAL
          </p>
          <h1 className="mt-2 max-w-xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Jangan hanya datang.
            <br />
            Kenali ceritanya.
          </h1>
        </section>
      </section>
    </main>
  );
}
