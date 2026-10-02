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
  describeRadiusOrigin,
  formatDistance,
  isSameViewport,
  liveDurationLabel,
  narrowToViewport,
  resolveActiveCenter,
  resolveResultsAnchorId,
  stopNestedCardAction,
  toggleLiveFilter,
  type DistanceFilter,
  type LiveDiscoveryItem,
  type MapViewport,
} from "@/lib/live/ui";

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

  // LOCATION SEARCH — debounce is intentional: a server geocode must not run
  // on every keystroke, and the camera must not move while the user is still
  // typing. The window is short and time-based (250 ms), never length-based.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A response only wins while it is still for the CURRENT query, so a slow
  // earlier request can never overwrite a newer center (last-write-wins by
  // the query the user actually typed, not by arrival order).
  const activeSearchRef = useRef<string>("");
  // EPOCH guard (bug fix 2026-10-02): the string guard above cannot see a
  // response that was superseded by a LATER INTENT rather than a newer query
  // — pressing "Lokasi Saya" after "Riyadh" was typed leaves the text
  // unchanged, so the string guard would happily let the late Riyadh answer
  // drag the map and the rows back. Every intent change (new search, cleared
  // input, "Lokasi Saya") bumps the epoch, and a response carrying an older
  // epoch is dropped on arrival.
  const searchEpochRef = useRef(0);
  // Leaflet's own bounds for the search-recentered camera supersede the
  // synthetic ±0.05° bridge box. Releasing the latch on a NEW answer makes
  // coverage follow the real viewport again (so panning after a search works)
  // without a flash of the pre-search area in between.
  const resetViewportLatch = useCallback(() => {
    lastViewportRef.current = null;
    setMapViewport(null);
  }, []);

  const runSearch = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      const cleared = clearCitySearch();
      setSearchQuery(cleared.query);
      setSearchPending(cleared.pending);
      setSearchError(cleared.error);
      setSearchCenter(cleared.center);
      setSearchPlaceName(cleared.placeName);
      activeSearchRef.current = "";
      return;
    }

    activeSearchRef.current = trimmed;
    setSearchQuery(trimmed);
    setSearchPending(true);
    setSearchError(null);
    setSearchCenter(null);

    // Captured BEFORE the request goes out: a response is only allowed to
    // write state if no newer intent (new query, cleared input, "Lokasi
    // Saya") replaced this one in the meantime.
    const requestEpoch = searchEpochRef.current;
    const isCurrent = () =>
      acceptSearchResponse({
        requestEpoch,
        currentEpoch: searchEpochRef.current,
        submitted: trimmed,
        activeQuery: activeSearchRef.current,
      });

    try {
      // The provider endpoint is server-only; the browser calls our own
      // route, which validates the query and returns one canonical center.
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(trimmed)}`, {
        headers: { Accept: "application/json" },
      });
      if (activeSearchRef.current !== trimmed) return;
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
      if (activeSearchRef.current !== trimmed) return;
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
      // The geocoder's OWN resolved name drives the radius caption, so it can
      // never name a city the search did not resolve. An absent name falls
      // back to the neutral phrase rather than the typed text.
      setSearchPlaceName(
        typeof result.displayName === "string" && result.displayName.trim()
          ? result.displayName.trim()
          : typeof result.name === "string" && result.name.trim()
            ? result.name.trim()
            : null,
      );
      // The real Leaflet bounds for this new center supersede the synthetic
      // bridge box; the map reports them on the next moveend.
      resetViewportLatch();
    } catch {
      if (activeSearchRef.current !== trimmed) return;
      if (!isCurrent()) return;
      setSearchPending(false);
      setSearchError("Layanan lokasi sedang tidak tersedia. Coba lagi nanti.");
      setSearchCenter(null);
    } finally {
      // The nonce is bumped only AFTER the server answered, so the newest
      // successful request always wins — a slow earlier response can never
      // overwrite a later center.
      setSearchNonce((nonce) => nonce + 1);
    }
  }, [resetViewportLatch]);

  useEffect(() => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    // An empty query is cleared in the input handler (handleSearchChange),
    // NOT here: synchronizing state from an effect body would cascade renders.
    if (!searchQuery.trim()) return;
    debounceTimerRef.current = setTimeout(() => {
      runSearch(searchQuery);
    }, 250);
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [searchQuery, runSearch]);

  // Release the debounce handle on unmount so a pending timer never fires
  // after the component has left the page.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  // Clearing the input is the ONE place the search state resets (no effect):
  // an empty query immediately drops the pending flag, the error, and the
  // center, so the map and every row fall back to the REAL Leaflet viewport.
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (value.trim()) return;
    // Clearing the input is a real intent change: it must also invalidate a
    // response still in flight, or the old city would land right after the
    // user emptied the box.
    searchEpochRef.current += 1;
    activeSearchRef.current = "";
    const cleared = clearCitySearch();
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
    activeSearchRef.current = "";
    const cleared = clearCitySearch();
    setSearchQuery(cleared.query);
    setSearchPending(cleared.pending);
    setSearchError(cleared.error);
    setSearchCenter(cleared.center);
    setSearchPlaceName(cleared.placeName);
    // Coverage goes back to the REAL Leaflet bounds; the synthetic bridge box
    // existed only for a city that no longer owns the viewport.
    resetViewportLatch();
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
  const searchViewport = searchCenter
    ? {
        north: searchCenter.lat + 0.05,
        south: searchCenter.lat - 0.05,
        east: searchCenter.lng + 0.05,
        west: searchCenter.lng - 0.05,
      }
    : null;
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
  const curatedCoveragePlaces = useMemo(() => {
    if (!curatedOnly) return [];
    const nonCurated = searchFiltered.filter((place) => !curatedIdSet.has(place.id));
    return narrowToViewport(nonCurated, coverageViewport);
  }, [curatedOnly, searchFiltered, curatedIdSet, coverageViewport]);

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

  // MOCKUP §8/§9: the coverage box and the scale label mirror the ACTIVE
  // camera radius so the copy stays truthful — the exact preset that owns
  // the camera (1 km / 5 km / 10 km; "Tempat Pilihan" and "Lokasi Saya" =
  // 10 km). Display only; never an invented state.
  const activeRadiusMeters = curatedOnly
    ? CURATED_CAMERA_RADIUS_M
    : CAMERA_PRESET_RADIUS_M[distanceFilter];
  const activeRadiusLabel =
    activeRadiusMeters >= 1000 ? `${activeRadiusMeters / 1000} km` : `${activeRadiusMeters} m`;
  // Radius caption (bug fix 2026-10-03): it names the origin that is actually
  // doing the measuring — the SAME active center the coverage filter and the
  // distance labels use. It used to be a fixed "dari lokasi Anda", so Riyadh
  // results were captioned as if measured from the device.
  const radiusCaption = describeRadiusOrigin({
    radiusLabel: activeRadiusLabel,
    mode: activeSearch.mode,
    placeName: searchPlaceName,
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
            /* Instant-camera rule (PO, 2026-09-30): the camera itself applies
               with no animation at all, so entering "Tempat Pilihan" is made
               visually obvious by a SHORT one-shot focus pulse on the
               EXISTING Current Location pin — no new marker, no map
               animation. */
            pulsePinOnPresetChange={curatedOnly}
            onViewportHasPlaces={handleViewportHasPlaces}
            onViewportChange={handleViewportChange}
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
              sliders/control icon RIGHT. The right icon is DECORATIVE ONLY
              (aria-hidden, non-inline, never a button): no search-settings
              feature exists, and none is invented. Copy, input, and search
              behavior are untouched (ONE search implementation). */}
          <div className="pointer-events-auto mt-[60px] sm:mt-[64px]">
            <div className="flex items-center gap-2.5 rounded-[20px] border border-black/10 bg-white px-3.5 py-2.5 shadow-[0_2px_10px_rgb(0_0_0/0.10)]">
              <span className="shrink-0 text-base leading-none text-brand-ink" aria-hidden>⌕</span>
              <input
                className="w-full bg-transparent text-sm outline-none placeholder:text-black/40"
                placeholder="Cari tempat, cerita, produksi..."
                value={searchQuery}
                onChange={(event) => handleSearchChange(event.target.value)}
                aria-label="Cari tempat, cerita, produksi"
              />
              {/* Sliders/control icon (MOCKUP §2) — replaces the previous gear
                  glyph. Decorative only; it opens nothing. */}
              <span aria-hidden className="shrink-0 leading-none text-black/45">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
                  <circle cx="16" cy="7" r="2.2" />
                  <circle cx="10" cy="12" r="2.2" />
                  <circle cx="18" cy="17" r="2.2" />
                </svg>
              </span>
            </div>
            {/* LOCATION SEARCH status (PO 2026-10-02): ONE source of truth for
                the geocoder flow — searching, resolved center, or failure.
                It only REPORTS server state; it never runs a second search,
                never edits the input, and never decides which Places are
                listed. aria-live="polite" so the outcome is announced without
                interrupting typing. Rendered only for a non-empty query, so
                the empty input stays clean. The coordinate readout is the
                server's canonical answer, formatted — never a rounded or
                invented value. */}
            {searchQuery.trim() && (
              <p
                role="status"
                aria-live="polite"
                className={`mt-2 flex items-center gap-2 rounded-[16px] px-3 py-2 text-xs ${
                  searchPending
                    ? "bg-white/85 text-black/55"
                    : searchError
                      ? "bg-live/10 text-live"
                      : "bg-white/85 text-brand-ink"
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
                ) : searchCenter ? (
                  <>
                    <span aria-hidden className="h-3.5 w-3.5 rounded-full bg-brand-primary" />
                    <span>
                      Area pencarian: {searchCenter.lat.toFixed(4)}, {searchCenter.lng.toFixed(4)}
                    </span>
                  </>
                ) : null}
              </p>
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
              container keeps a valid, non-degenerate Leaflet size. */}
          <div aria-hidden className="h-[42vh] min-h-[260px] max-h-[520px] sm:h-[44vh]" />
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
             card itself is content-sized (w-fit) and capped at 20 rem, so it
             covers the smallest possible area and WRAPS instead of growing
             when the sentence is long or the screen is narrow. Padding, text
             size and shadow are reduced, and it stays clear of the coverage
             box (bottom-9) and the Leaflet controls. */
          <div className="pointer-events-none absolute inset-x-0 bottom-24 z-[1100] flex justify-center px-4">
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

        {/* MOCKUP §8: coverage box, bottom-left of the map — white, rounded,
            compact, with a target icon and the ACTIVE camera radius in the
            copy (truthful label, never an invented state). The caption names
            the origin that is really measuring — the searched city or the
            user's own location — so it can never contradict the results. */}
        <div className="pointer-events-none absolute bottom-9 left-4 z-[1100] flex max-w-[62%] items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-md ring-1 ring-black/10">
          <span aria-hidden className="shrink-0 text-sm leading-none text-brand-ink">⌖</span>
          <p className="text-[11px] font-semibold leading-4 text-brand-ink">{radiusCaption}</p>
        </div>

        {/* MOCKUP §9: scale, bottom-right of the map — the label follows the
            ACTIVE camera radius (same truthful rule as the coverage box) and
            the bar is the mockup's scale line. It sits above the OSM
            attribution so the two never collide. */}
        <div className="pointer-events-none absolute bottom-9 right-4 z-[1100] flex flex-col items-end gap-1">
          <span className="rounded bg-white/80 px-1 text-[11px] font-bold leading-4 text-brand-ink">
            {activeRadiusLabel}
          </span>
          <span aria-hidden className="block h-0.5 w-14 border-x-2 border-b-2 border-brand-ink/70" />
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
            mockup's "{n} tempat pilihan di sekitar Anda" subtitle. */}
        <section
          className="relative z-10 -mt-5 rounded-t-[24px] bg-brand-cream pb-2 pt-3 shadow-[0_-6px_18px_rgb(0_0_0/0.06)]"
          aria-labelledby="place-results-heading"
        >
          {/* Panel handle — small centered bar, mockup §10 (visual only). */}
          <span
            aria-hidden
            className="mx-auto mb-2.5 block h-1.5 w-12 rounded-full bg-black/15"
          />
          <div className="mb-3 flex items-end justify-between gap-3 px-1">
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
                    beneath it; normal modes keep the Discovery Place count. */}
                {curatedOnly
                  ? `${curatedListed.length} tempat pilihan di sekitar Anda`
                  : `${discoveryRowPlaces.length} tempat di sekitar Anda`}
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

          {/* Baris 1 (curated layer only): the Admin-promoted selection.
              Renders nothing when no Place is curated — the curated layer
              never substitutes the full published set.
              MOCKUP §12 (2026-10-01): the row is a HORIZONTAL STRIP at every
              viewport (mobile swipe AND desktop 1280) — same dataset, same
              order, same cards; presentation only. */}
          {curatedOnly && curatedListed.length > 0 && (
            <>
              <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-brand-ink/70">
                Tempat Pilihan
              </p>
              <div
                id={CURATED_RESULTS_ANCHOR_ID}
                className="-mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-2"
              >
                {curatedListed.map((place) => (
                  <div
                    key={place.id}
                    className="w-[46vw] max-w-[200px] min-w-[132px] shrink-0 snap-start"
                  >
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
              {/* MOCKUP §12 (2026-10-01): horizontal strip at EVERY viewport
                  — the same snap-strip pattern as Baris 1. Same dataset, same
                  order, same cards (presentation only).

                  GAP FIX (2026-10-01, §19 root cause): the Discovery row used
                  to render the cards DIRECTLY into the flex strip. Each card is
                  `w-full`, so every one of them claimed the full strip width
                  and flex-shrank it down to a few pixels — which is exactly the
                  "tall empty vertical stripes" pattern seen in the actual
                  render (no skeleton, no loading state, no empty pattern: the
                  cards themselves were collapsing). Wrapping each card in the
                  SAME fixed-width, non-shrinking track as the curated row is
                  the presentation-only fix: no data, order, eligibility, or
                  query changes, but the cards now render at their intended
                  size and several are visible side by side. */}
              <div
                id={DISCOVERY_RESULTS_ANCHOR_ID}
                className="-mx-4 flex snap-x snap-mandatory gap-2.5 overflow-x-auto px-4 pb-2"
              >
                {discoveryRowPlaces.map((place) => (
                  <div
                    key={place.id}
                    className="w-[46vw] max-w-[200px] min-w-[132px] shrink-0 snap-start"
                  >
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
