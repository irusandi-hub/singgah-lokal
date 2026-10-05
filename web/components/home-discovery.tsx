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
  fallbackSearchArea,
  formatDistance,
  isSameViewport,
  liveDurationLabel,
  narrowToViewport,
  normalizeSearchArea,
  resolveActiveCenter,
  resolveExploreFitPlaces,
  resolveLocalAreaCoverage,
  resolveResultsAnchorId,
  stopNestedCardAction,
  toggleLiveFilter,
  type DistanceFilter,
  type LiveDiscoveryItem,
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
  // The "Semua Tempat" tab and its `allPlacesOnly` mode were REMOVED on
  // 2026-10-04 (approved mockup): the Home content modes are LIVE,
  // "Tempat Pilihan", and the three distance presets, exactly as before.
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
  // SUBMITTED PLACE-TEXT FILTER (2026-10-04). `searchQuery` below is the DRAFT
  // the user is typing; this is the query that was actually submitted and is
  // therefore the only text filter the Place rows may apply. Typing alone can
  // no longer change what is listed, marked, or counted — only Enter or the
  // "Cari" button commits a query, through the ONE submit path.
  const [submittedQuery, setSubmittedQuery] = useState("");
  // THE SEARCHED AREA (2026-10-04): the canonical bounding box the geocoder
  // published for the resolved place, in the same `{ north, south, east, west }`
  // shape the viewport uses. It is what a search actually covers, so a city
  // search spans the city instead of a few kilometres around its centre point.
  // `null` means "no canonical area was published", in which case the narrower
  // documented fallback below applies. It is never a radius we guessed.
  const [searchArea, setSearchArea] = useState<MapViewport | null>(null);
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
  // The query whose geocode is IN FLIGHT right now. Enter, the "Cari" button,
  // and a held-down Enter key all reach the same submit path, and a key press
  // can be followed by the same tap in the same tick — so an identical submit
  // while one is already running is ignored instead of firing a second
  // request that could race its own answer.
  const inFlightSearchRef = useRef<string | null>(null);

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
        inFlightSearchRef.current = null;
        const cleared = clearCitySearch();
        setSearchQuery(cleared.query);
        setSubmittedQuery(cleared.query);
        setSearchPending(cleared.pending);
        setSearchError(cleared.error);
        setSearchCenter(cleared.center);
        setSearchArea(null);
        setSearchPlaceName(cleared.placeName);
        return;
      }

      // ONE submit, ONE request (2026-10-04): Enter, the "Cari" button, and a
      // repeated Enter key press all arrive here, and an identical query that
      // is already running is ignored rather than issued twice.
      if (inFlightSearchRef.current === trimmed) return;
      inFlightSearchRef.current = trimmed;

      // Every submit intent invalidates any response still in flight, so a
      // late answer for a previous query can never overwrite a newer one.
      searchEpochRef.current += 1;
      submittedSearchRef.current = trimmed;
      setSearchQuery(trimmed);
      setSubmittedQuery(trimmed);
      setSearchPending(true);
      setSearchError(null);
      setSearchCenter(null);
      // The previous area goes with the previous answer: rows and markers fall
      // back to the real viewport while this one resolves, so no stale frame
      // is ever shown under a new query.
      setSearchArea(null);

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
          setSearchArea(null);
          return;
        }
        if (!response.ok) {
          setSearchPending(false);
          setSearchError("Layanan lokasi sedang tidak tersedia. Coba lagi nanti.");
          setSearchCenter(null);
          setSearchArea(null);
          return;
        }
        const result = (await response.json()) as {
          latitude?: number;
          longitude?: number;
          displayName?: string;
          name?: string;
          bounds?: { north?: number; south?: number; east?: number; west?: number } | null;
        };
        if (submittedSearchRef.current !== trimmed) return;
        if (!isCurrent()) return;
        const latitude = Number(result.latitude);
        const longitude = Number(result.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          setSearchPending(false);
          setSearchError("Lokasi tidak ditemukan. Cek ejaan atau pilih dari daftar.");
          setSearchCenter(null);
          setSearchArea(null);
          return;
        }
        setSearchPending(false);
        setSearchCenter({ lat: latitude, lng: longitude });
        // THE SEARCHED AREA (2026-10-04): the provider's own bounding box, so
        // markers and rows cover the resolved place instead of a fixed window
        // around its centre point. A hit that publishes no usable box yields
        // `null` and the documented fallback box is used instead — never a
        // radius this app invented, and never a fabricated boundary.
        setSearchArea(normalizeSearchArea(result.bounds));
        setSearchPlaceName(
          typeof result.displayName === "string" && result.displayName.trim()
            ? result.displayName.trim()
            : typeof result.name === "string" && result.name.trim()
              ? result.name.trim()
              : null,
        );
        resetViewportLatch();
        // The searched area now owns the frame, so the caption must stop
        // claiming the distance preset that used to bound it: a search covers
        // the resolved place, not "N km from its centre". A distance tab the
        // user picks afterwards sets its own radius caption again.
        setCameraCoverage("area");
      } catch {
        if (submittedSearchRef.current !== trimmed) return;
        if (!isCurrent()) return;
        setSearchPending(false);
        setSearchError("Layanan lokasi sedang tidak tersedia. Coba lagi nanti.");
        setSearchCenter(null);
        setSearchArea(null);
      } finally {
        // The query is only free again once THIS request settled, so an
        // identical submit issued while it was in flight stays a no-op.
        if (inFlightSearchRef.current === trimmed) inFlightSearchRef.current = null;
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

  // "CARI" (2026-10-04): the visible submit control INSIDE the search field.
  // It is a plain button calling the ONE submit path above — the same function
  // Enter calls — so the two can never drift apart, and the in-flight guard in
  // that function absorbs an Enter followed immediately by a tap. It reads the
  // CURRENT draft rather than the input's DOM value, so the submit is exactly
  // what the user last typed.
  const handleSearchSubmitClick = useCallback(() => {
    handleSearchSubmit(searchQuery);
  }, [handleSearchSubmit, searchQuery]);

  // "X" — the existing clear affordance, now also the one control that drops
  // BOTH halves of the query state: the draft the user is typing AND the
  // submitted filter the rows are actually showing. It bumps the epoch, so a
  // geocode still in flight for the old query can no longer apply its center
  // or its area, and with both gone `coverageViewport` falls back to the REAL
  // Leaflet bounds — normal viewport-driven browsing resumes.
  //
  // It deliberately does NOT release the viewport latch: the map did not move,
  // so the last reported bounds ARE still the browsing context, and nulling
  // them would leave the rows unnarrowed until the next pan or zoom.
  const handleSearchClear = useCallback(() => {
    searchEpochRef.current += 1;
    submittedSearchRef.current = "";
    inFlightSearchRef.current = null;
    const cleared = clearCitySearch();
    setSearchQuery(cleared.query);
    setSubmittedQuery(cleared.query);
    setSearchPending(cleared.pending);
    setSearchError(cleared.error);
    setSearchCenter(cleared.center);
    setSearchArea(null);
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
    inFlightSearchRef.current = null;
    const cleared = clearCitySearch();
    setSearchQuery(cleared.query);
    setSubmittedQuery(cleared.query);
    setSearchPending(cleared.pending);
    setSearchError(cleared.error);
    setSearchCenter(cleared.center);
    setSearchArea(null);
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
  //
  // THE SUBMITTED QUERY IS THE ONLY TEXT FILTER (2026-10-04). `searchQuery` is
  // the draft in the input; `submittedQuery` is what Enter or "Cari" committed.
  // Typing therefore cannot change what is listed, marked, or counted — it only
  // edits the box — which is what makes "type, then submit" the single, honest
  // search interaction.
  const searchFiltered = useMemo(() => {
    const normalizedQuery = submittedQuery.trim().toLocaleLowerCase("id-ID");
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
  }, [places, submittedQuery, liveByPlaceId]);

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

  // THE SEARCHED AREA (2026-10-04). TWO SOURCES, ONE RULE.
  //
  // ROOT CAUSE this replaces: coverage for a searched city was a fixed ±0.05°
  // window (~5.5 km) around the geocoder's CENTRE POINT. The search camera
  // then framed only the Places inside that same window, Leaflet reported that
  // small frame as the real viewport, and every eligible Place elsewhere in
  // the city stayed out of the markers and the rows — searching "Riyadh"
  // showed the handful of Places near one coordinate, not the city. There is
  // no fixed window that is right for a district and right for a capital, so
  // none is used as the model.
  //
  // NOW: the primary source is the CANONICAL BOUNDING BOX the geocoder
  // published for the hit it resolved (`searchArea`) — provider data, not a
  // guess, so a city covers its whole published extent. The old ±0.05° box
  // survives ONLY as the documented last resort for an answer that carries no
  // usable boundary (`fallbackSearchArea`), which keeps that single gap
  // deterministic exactly as before.
  //
  // The REAL Leaflet viewport still wins once it exists, and it is released on
  // every new answer (see `resetViewportLatch`), so the search area is never a
  // permanent latch that would refuse to follow the user's own panning. It
  // never changes eligibility, membership, or ordering.
  const searchViewport = useMemo<MapViewport | null>(
    () => (searchArea ? searchArea : searchCenter ? fallbackSearchArea(searchCenter) : null),
    [searchArea, searchCenter],
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
  // CAMERA CANDIDATE SET (correction 2026-10-05) — the ONE mode-independent
  // Place pool every camera dataset below reads.
  //
  // ROOT CAUSE it closes: the camera datasets used to be projected from
  // `visiblePlaces`, the CONTENT-MODE set. `visiblePlaces` collapses to the
  // curated subset the moment "Tempat Pilihan" is active, so a geocode answer
  // that landed while the tab was on resolved `searchFitPlaces` from the
  // curated Places instead of the full searched region — the renewed search
  // then framed only the curated pins and the expected full search-area
  // framing was gone. The same narrowing reached the "Lokasi Saya" datasets.
  //
  // The pool is therefore the SEARCH-FILTERED eligible set (`searchFiltered`)
  // with NO content-mode gate: curated / LIVE can no longer narrow, re-frame,
  // or re-centre the camera. It is CAMERA GEOMETRY ONLY — it never filters,
  // re-orders, or admits a Place in any row; membership still comes solely
  // from the canonical sets the rows render.
  const cameraEligiblePlaces = searchFiltered;

  // SELECTED PLACES ("Tempat Pilihan"): the local area of the eligible Places,
  // always resolved from the MODE-INDEPENDENT pool above (correction
  // 2026-10-05), so a content-mode tab can never change what the camera is
  // allowed to frame. The ordinary non-curated remainder is a MARKER-layer
  // decision (§15 item 2, still untouched in `mapPlaces`); it must not steer
  // the CAMERA. Eligibility, membership, the curated LIST, and the row counts
  // are unchanged.
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
        places: toCameraCandidates(cameraEligiblePlaces),
      }),
    [cameraEligiblePlaces, searchCenter, viewerPosition],
  );

  // "Tempat Pilihan" IS NOT A CONTEXT-FRAMED TAB ANY MORE (2026-10-05).
  //
  // ROOT CAUSE this replaces: selecting the curated tab was ALSO a camera
  // action. The press bumped `fitNonce` (a `fitBounds` over the curated Places
  // of the active context), bumped `cameraRequestNonce` (which RELEASED the
  // manual-interaction latch), and switched the camera radius to
  // `CURATED_CAMERA_RADIUS_M`. So choosing a tab that is only a PRESENTATION
  // layer silently threw away the frame the user was looking at — a Riyadh
  // search framed the city, then the curated press re-fit it to the curated
  // subset; a "Lokasi Saya" frame was re-fit to the curated neighbourhood —
  // and it did so even after the user had panned or zoomed by hand.
  //
  // THE RULE NOW: "Tempat Pilihan" changes WHICH Places are specially marked
  // and which rows are shown. It never moves, re-frames, narrows, or
  // re-centres the camera. Every camera dataset below is therefore mode-
  // independent, so an active search area or the user's current frame survives
  // the tab choice untouched. Eligibility, membership, pin styling, both rows,
  // and every count are unchanged — only the camera coupling is gone.

  // CAMERA BOUNDS DATASET — the ONE pool every Home camera path reads
  // (`fitPlaces` / `searchFitPlaces` / `locateFitPlaces`, all handed to
  // `HomeMap` under their own prop and their own explicit trigger).
  //
  // It is display geometry only. Membership still comes solely from the
  // canonical curated ids, no Place is added to or removed from any row by
  // this value, and it is never used as a filter. It reads NO viewport state,
  // so camera and viewport filtering stay independent, and it is keyed on
  // `fitNonce` / `locateNonce` / `searchNonce` alone, so marker refreshes,
  // polls, and viewport reports cannot re-frame it.
  //
  // "Tempat Pilihan" no longer frames anything (2026-10-05): every mode keeps
  // the local area of the MODE-INDEPENDENT eligible Places — canonical
  // coordinates only, never the viewport, never a fallback to the whole
  // dataset, and empty (so the camera does not move at all) when there is no
  // usable origin. Because the pool no longer reads `visiblePlaces`, switching
  // the content mode cannot change what the camera may frame.
  // "LOKASI SAYA" BOUNDS DATASET — the SAME local-area set, handed to the map
  // under its own prop and its own trigger (correction 2026-10-03).
  //
  // It is one value computed once, not a second resolution rule. The origin is
  // the REAL fix (not the searched city): pressing "Lokasi Saya" clears the
  // search first, so `searchCenter` is already null when this recomputes.
  //
  // NOT UNNECESSARILY TIGHT (2026-10-05): when the viewer's own trusted
  // geography resolves to a SINGLE Place, framing it plus the user's own
  // coordinate produced a box metres across — a street-level view in which the
  // nearest pin filled the screen and other relevant Places did not exist as
  // far as the user could tell. The set is therefore widened to the Places
  // inside the ACTIVE DISTANCE PRESET — the exploration scope the user has
  // already chosen, not a new radius — and only in that too-tight case.
  const locateFitPlaces = useMemo<HomeMapPlace[]>(
    () =>
      toHomeMapPlaces(
        resolveExploreFitPlaces({
          origin: viewerPosition,
          localPlaces: selectedLocalArea.places,
          // The MODE-INDEPENDENT pool (correction 2026-10-05): a content-mode
          // tab can never narrow the "Lokasi Saya" widening candidates.
          candidatePlaces: toCameraCandidates(cameraEligiblePlaces),
          radiusMeters: CAMERA_PRESET_RADIUS_M[distanceFilter],
        }),
      ),
    [selectedLocalArea, cameraEligiblePlaces, viewerPosition, distanceFilter],
  );

  // CAMERA BOUNDS DATASET — LOCATION SEARCH AUTO-FIT (product decision,
  // 2026-10-03). The relevant Places for a searched region are the canonical
  // Places inside that region's own coverage box (the SAME rule the rows use
  // before Leaflet reports its real bounds) — never the current viewport, which
  // is still centred on the device and would make the fit circular, and never
  // the whole dataset, which would zoom to the country. Empty when the region
  // holds no Place with canonical coordinates, and the camera then keeps the
  // geocoding center instead.
  const searchFitPlaces = useMemo<HomeMapPlace[]>(() => {
    // A search frames the eligible Places of the SEARCHED REGION. It reads the
    // MODE-INDEPENDENT pool (correction 2026-10-05), so the tab cannot swap,
    // narrow, or re-frame this dataset: an answer that lands while "Tempat
    // Pilihan" is active still frames the FULL searched area, never just the
    // curated pins.
    if (!searchViewport) return [];
    return narrowToViewport(cameraEligiblePlaces, searchViewport).flatMap((place) =>
      place.latitude === null || place.longitude === null
        ? []
        : [{ id: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude }],
    );
  }, [cameraEligiblePlaces, searchViewport]);

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
  // (1 km / 5 km / 10 km). Display only; never an invented state.
  //
  // The radius is the ACTIVE DISTANCE PRESET in every mode (2026-10-05): the
  // curated tab no longer switches the camera to `CURATED_CAMERA_RADIUS_M`, so
  // naming that radius here would claim a frame the camera is not using. A
  // resolved search keeps its own "area" caption through `cameraCoverage`.
  const activeRadiusMeters = CAMERA_PRESET_RADIUS_M[distanceFilter];
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
        className="group flex h-full w-full flex-col overflow-hidden rounded-[16px] border border-black/5 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition hover:shadow-[0_8px_20px_rgb(0_0_0/0.08)]"
        visitedClassName={live ? "border-live/50 bg-[#fdf6f2]" : "border-brand-accent/30 bg-[#faf6ee]"}
      >
        {/* CARD IMAGE — MOCKUP §13: every card carries an image area. When
            the Place has no canonical cover yet, a NEUTRAL DUMMY area keeps
            the mockup composition (visual placeholder only — no data change,
            no invented imagery, and the canonical cover still wins when it
            exists). */}
        <div className="relative h-[92px] w-full shrink-0 overflow-hidden bg-[#ece7db] sm:h-[108px]">
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
              className="absolute left-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-[10px] bg-brand-secondary text-[10px] leading-none text-white shadow-[0_1px_3px_rgb(0_0_0/0.18)] ring-1 ring-white/60"
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
            className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-[10px] leading-none text-brand-ink/70 shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
          >
            ♡
          </span>
          {distance && (
            <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-0.5 rounded-full bg-brand-ink/70 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow-[0_1px_3px_rgb(0_0_0/0.16)]">
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
        <div className="flex flex-1 flex-col p-3">
          <h3 className="line-clamp-2 text-sm font-bold leading-snug text-brand-ink">{place.name}</h3>
          <p className="mt-1 line-clamp-2 text-xs leading-[18px] text-brand-ink/60">
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
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
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
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-accent/30 px-2.5 py-1 text-[11px] font-bold text-brand-accent transition hover:bg-brand-accent/10"
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
              className="ml-auto inline-flex shrink-0 cursor-not-allowed items-center gap-1 rounded-full border border-black/5 px-2.5 py-1 text-[11px] font-bold text-brand-ink/30"
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
        <div className="mt-1.5">
          {live ? (
            <button
              type="button"
              onClick={(event) => {
                stopNestedCardAction(event);
                router.push(`/live/${live.sessionId}`);
              }}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-[14px] bg-live px-3 py-1.5 text-[11px] font-bold text-white shadow-[0_2px_8px_rgb(0_0_0/0.10)] transition hover:opacity-90"
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
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-[14px] border border-live/25 bg-white px-3 py-1.5 text-[11px] font-bold text-live transition hover:bg-live/[0.06]"
                aria-label={`Status Live ${place.name}`}
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-live/60" />
                LIVE — Belum berlangsung
              </button>
              {nonLiveNoticePlaceId === place.id && (
                <p
                  role="status"
                  className="mt-1.5 rounded-[10px] bg-live/[0.08] px-3 py-1.5 text-[11px] font-semibold text-live"
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
            cameraRadiusMeters={CAMERA_PRESET_RADIUS_M[distanceFilter]}
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
            /* AUTO-FIT CAMERA (product decision, 2026-10-03; refined 2026-10-05): the
               camera frames the SPREAD of the relevant Places instead of a
               fixed 10 km frame around one point. Each dataset is the MAP
               DATASET with the viewport gate REMOVED — deliberately NOT the
               narrowed marker set, so viewport, marker filtering, and camera
               can never form a circular dependency. Each fires ONLY on its own
               explicit request (a new search answer, or the "Lokasi Saya"
               press), so no marker refresh, discovery poll, viewport report, or
               TAB CHOICE can ever recenter the camera in a loop. */
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
          {/* Search — MOCKUP §2: floating white bar, search icon LEFT, and
              NOTHING on the right end (approved mockup, 2026-10-04). The
              decorative sliders/settings graphic that used to sit there is
              REMOVED and is not replaced by any decorative icon standing in for a
              feature: what sits at the right end now is the REAL "Cari" submit
              control, below.

              ONE SUBMIT PATH: Enter and "Cari" both call `handleSearchSubmit`,
              which is also what invalidates any in-flight answer. The button
              reads the current draft (`searchQuery`), never the DOM value, and
              an identical submit while a request is already running is ignored
              inside that function — so Enter-then-tap cannot fire two geocodes.

              DIMENSIONS ARE STABLE: "Cari" is a FIXED-height, shrink-0 control
              and the clear "×" keeps its fixed 18×18 box, so the bar's outer
              width, height, padding, radius, and position are identical empty,
              typed, pending, and submitted — the input is the only part that
              changes size, and `min-w-0` keeps a long query from forcing
              horizontal overflow on a narrow phone.

              Typing never searches: it only edits the draft the ONE submit
              path reads (submit-only, 2026-10-04). */}
          <div className="pointer-events-auto mt-[60px] sm:mt-[64px]">
            <div className="flex items-center gap-2 rounded-[18px] border border-black/5 bg-white py-2 pl-3.5 pr-1.5 shadow-[0_4px_16px_rgb(0_0_0/0.08)] ring-1 ring-black/[0.02]">
              <span className="shrink-0 text-[15px] leading-none text-brand-ink/70" aria-hidden>⌕</span>
              <input
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-black/35"
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
                  className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-black/5 text-[15px] leading-none text-black/40 transition hover:bg-black/10"
                  aria-label="Hapus pencarian"
                >
                  <span aria-hidden>×</span>
                </button>
              ) : null}
              {/* "CARI" — the visible submit control inside the field. `type`
                  is explicit so it can never submit a surrounding form, and
                  while a geocode is in flight it is disabled so the button
                  cannot be spammed; the in-flight guard is the real rule. */}
              <button
                type="button"
                onClick={handleSearchSubmitClick}
                disabled={searchPending}
                className="relative inline-flex h-[26px] shrink-0 items-center justify-center rounded-full bg-brand-primary px-3 text-[11px] font-bold uppercase tracking-wide text-white shadow-[0_2px_6px_rgb(0_0_0/0.12)] ring-offset-2 transition hover:bg-brand-primary-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/45 disabled:opacity-60 disabled:hover:opacity-60"
                aria-label="Cari lokasi"
              >
                {/* The visible pill is 26px tall, which is comfortable on
                    desktop but small for a thumb. This absolutely positioned,
                    out-of-flow span extends the TOUCH/HIT area DOWNWARD into
                    the bar's own bottom padding and the open map below it,
                    which brings the target to ~34px without changing the
                    bar's height, padding, radius, or position at all.

                    DOWNWARD ONLY, deliberately: the floating header is
                    `absolute top-0` and already overlaps the pill's top edge,
                    so growing the target upward would swallow taps meant for
                    the header controls. Growing it down can only ever land on
                    the bar's own padding or the map surface. */}
                <span
                  aria-hidden
                  className="pointer-events-auto absolute -inset-x-1 -bottom-2 top-0"
                />
                Cari
              </button>
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
              semantics are completely unchanged — only the colors moved.

              THE ROW IS NOW COMPLETE AND FINAL (approved mockup, 2026-10-04):
              the extra "Semua Tempat" row that used to sit below it is gone, and
              no control replaces it. This row therefore still holds exactly
              five controls in the same order, on the same `grid-cols-` split,
              with the same 11px type, ~16px radii, brand-green selected state,
              and no-scroller guarantee at 360px. */}
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
              className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-[14px] px-2 py-1.5 text-[11px] font-bold tracking-wide shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition sm:px-3 sm:text-xs ${
                liveOnly
                  ? "bg-live text-white"
                  : "border border-live/25 bg-white text-live"
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
                // NOTHING ELSE HAPPENS HERE (2026-10-05). This press used to
                // bump `fitNonce` (a `fitBounds` over the curated Places),
                // bump `cameraRequestNonce` (releasing the manual-interaction
                // latch), and switch the camera to `CURATED_CAMERA_RADIUS_M`.
                // All three are gone: a curated tab is a PRESENTATION choice,
                // so it must not move, re-frame, or re-centre the camera and
                // must not discard a frame the user set by hand. The explored
                // area, the camera centre, and the zoom are all preserved
                // exactly as they were — a Riyadh search keeps its searched
                // area, and "Lokasi Saya" keeps the frame it established.
              }}
              aria-pressed={curatedOnly}
              className={`whitespace-nowrap rounded-[14px] px-2 py-1.5 text-[11px] font-bold shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition sm:px-3 sm:text-xs ${
                curatedOnly
                  ? "bg-brand-primary text-white"
                  : "border border-black/5 bg-white text-brand-ink/70"
              }`}
            >
              Tempat Pilihan
            </button>
            {DISTANCE_FILTERS.map((filter) => (
              <button
                key={filter}
                onClick={() => {
                  setDistanceFilter(filter);
                  // A radius preset owns the map on its own, so it leaves the
                  // curated place-set tab — the rule it has always had.
                  setCuratedOnly(false);
                  // A distance tab really does frame this radius, so the
                  // caption may name it again — and the tab is an explicit
                  // camera request, which releases the latch.
                  setCameraCoverage("radius");
                  setCameraRequestNonce((nonce) => nonce + 1);
                }}
                aria-pressed={distanceFilter === filter && !curatedOnly}
                className={`whitespace-nowrap rounded-[14px] px-1 py-1.5 text-center text-[11px] font-bold shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition sm:px-3 sm:text-xs ${
                  distanceFilter === filter && !curatedOnly
                    ? "bg-brand-primary text-white"
                    : "border border-black/5 bg-white text-brand-ink/70"
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
                · compass                top 190px → ends 234px
                · "Lokasi Saya" control  top 240px → ends ~281px
                · Leaflet +/- stack      top 290px → ends ~354px
              At the previous min-height of 240px the section ended ABOVE the
              bottom of the zoom control, so on an ordinary phone the +/- stack
              was cut off by the section's own `overflow-hidden` — essential map
              context removed by the layout itself, and the map/results
              relationship made unclear. The floor is now 440px, which fits the
              entire ladder at every supported height (360 / 390 / 430 / 1280),
              and 42vh / 46vh keeps the map the dominant field on taller
              screens. (The bottom-right scale chip left this ladder with the
              indicator on 2026-10-04; no offset here changed.)

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
          <div aria-hidden className="h-[60vh] min-h-[470px] max-h-[700px] sm:h-[66vh]" />
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
            <div className="w-fit max-w-[min(20rem,100%)] rounded-[14px] bg-white/95 px-3 py-1.5 text-center shadow-[0_4px_14px_rgb(0_0_0/0.10)] ring-1 ring-black/5">
              <p className="text-[11px] font-semibold leading-4 text-brand-ink/85">
                {curatedOnly
                  ? "Belum ada Tempat Pilihan di sekitar area ini"
                  : "Belum ada Tempat Terdaftar di sekitar area ini"}
              </p>
              <p className="mt-0.5 text-[10px] leading-3.5 text-brand-ink/55">
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

        {/* MAP DISTANCE SCALE: REMOVED (approved mockup, 2026-10-04). The measured
            scale bar — its distance text and its rule — is gone together with
            the space it reserved: nothing is rendered in its place and no other
            distance indicator, measurement label, or decorative graphic replaces
            it. The Leaflet +/- zoom control, the OSM attribution, and every
            camera, coverage, and radius rule are untouched: the scale was
            display-only chrome that no geographic rule ever read. */}

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
            · `bottom-3` — below the map's own bottom overlay, the empty-state
              card (bottom-32), so that card stays fully readable above it.
            · `max-w-6xl px-4`, `mx-auto` — THE SAME horizontal geometry as the
              floating search bar, which lives in a `mx-auto w-full max-w-6xl
              px-4` column directly above it. The panel's old reserved
              right-hand strip for the scale bar is GONE, so the card's
              left and right edges now line up exactly with the search field's at
              every supported width (360 / 390 / 430 / 1280): it can be neither
              narrower nor wider than the bar above it. The right-hand control
              column sits far above this panel, so widening it never covers a
              map control or a Place marker.
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
        <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[1100] mx-auto w-full max-w-6xl px-4">
          <div className="pointer-events-auto rounded-[18px] bg-white/95 px-3.5 py-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.10)] ring-1 ring-black/5 backdrop-blur-sm">
            {/* Panel handle — small centered bar, mockup §10 (visual only). */}
            <span aria-hidden className="mx-auto mb-0.5 block h-1 w-10 rounded-full bg-black/10" />
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 id="place-results-heading" className="text-base font-bold leading-tight tracking-tight">
                  {searchQuery.trim()
                    ? `Hasil untuk “${searchQuery.trim()}”`
                    : curatedOnly
                      ? "Tempat Pilihan"
                      : "Discovery Place"}
                </h2>
                <p className="mt-0.5 text-[11px] font-semibold leading-4 text-brand-ink/55">
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
                  className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-bold text-brand-ink/75 transition hover:text-brand-ink"
                >
                  Ke hasil <span aria-hidden>›</span>
                </a>
              ) : (
                <span className="shrink-0 text-[11px] font-bold text-brand-ink/35">Ke hasil</span>
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
          <div className="mt-4 rounded-[18px] border border-live/20 bg-white p-6 text-center shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
            <p className="text-sm font-bold text-brand-ink">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className="mt-1 text-xs text-brand-ink/60">
              Ketika sebuah Tempat memulai Live, proses produksinya otomatis muncul di sini.
            </p>
            <button
              type="button"
              onClick={() => setLiveOnly(false)}
              className="mt-4 inline-flex rounded-[14px] bg-brand-primary px-4 py-2 text-[13px] font-bold text-white shadow-[0_2px_8px_rgb(0_0_0/0.10)] transition hover:bg-brand-primary-deep"
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
                  className="group rounded-[16px] border border-live/20 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition hover:shadow-[0_8px_20px_rgb(0_0_0/0.08)]"
                  visitedClassName="border-live/60 bg-[#fdf6f2]"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-white shadow-[0_2px_6px_rgb(0_0_0/0.10)]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                      Live Sekarang
                    </span>
                    <span className="text-[10px] font-bold text-brand-ink/50">
                      {liveDurationLabel(item.startedAt)} • {item.viewerPeak}/100
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-semibold text-brand-ink">{item.processTitle ?? "Proses produksi"}</p>
                  <p className="mt-0.5 text-xs text-brand-ink/60">
                    {place?.name ?? item.placeName} • {place?.area ?? ""}
                  </p>
                  <p className="mt-2 text-[11px] font-bold text-brand-accent/90">
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
          className="relative z-10 rounded-t-[24px] bg-brand-cream pb-1 pt-1 shadow-[0_-8px_24px_rgb(0_0_0/0.05)]"
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
              <p className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-brand-ink/55">
                Tempat Pilihan
              </p>
              <div
                id={CURATED_RESULTS_ANCHOR_ID}
                className="-mx-4 flex flex-col gap-2 px-4 pb-1"
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
                <p className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-brand-ink/55">
                  Discovery Place
                </p>
              )}
              {/* MOCKUP §12 (2026-10-01): vertical list at EVERY viewport —
                  the same vertical-list pattern as Baris 1. Same dataset, same
                  order, same cards (presentation only). */}
              <div
                id={DISCOVERY_RESULTS_ANCHOR_ID}
                className="-mx-4 flex flex-col gap-2 px-4 pb-1"
              >
                {discoveryRowPlaces.map((place) => (
                  <div key={place.id} className="w-full">
                    {renderPlaceCard(place, curatedIdSet.has(place.id))}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-[18px] border border-black/5 bg-white px-4 py-5 text-center shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
              {searchQuery.trim() ? (
                <>
                  <p className="text-sm font-bold text-brand-ink">Tempat tidak ditemukan</p>
                  <p className="mt-1 text-xs text-brand-ink/60">
                    Coba kata kunci atau radius yang berbeda.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold text-brand-ink">Belum ada Discovery Place</p>
                  <p className="mt-1 text-xs text-brand-ink/60">
                    Tempat yang siap tayang akan muncul di sini secara otomatis.
                  </p>
                </>
              )}
            </div>
          )}
        </section>

        {/* Intro */}
        <section className="px-1 pb-4 pt-7">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent/90">
            SINGGAH LOKAL
          </p>
          <h1 className="mt-2 max-w-xl text-[28px] font-semibold leading-tight tracking-tight text-brand-ink sm:text-[34px]">
            Jangan hanya datang.
            <br />
            Kenali ceritanya.
          </h1>
        </section>
      </section>
    </main>
  );
}
