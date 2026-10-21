"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import HomeMap, { type HomeMapPlace } from "@/components/home-map";
import PlaceFollowButton from "@/components/place-follow-button";
import SiteNav from "@/components/site-nav";
import VisitedLink from "@/components/visited-link";
import { resolveCoverLoadState } from "@/lib/place-cover";
import { PLACE_CATEGORIES, type Place } from "@/lib/places";
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
  fallbackSearchArea,
  formatDistance,
  isSameViewport,
  liveDurationLabel,
  MAP_CONTROL_COLUMN_BOTTOM_PX,
  MAP_CONTROL_COLUMN_TOP_PX,
  narrowToViewport,
  normalizeSearchArea,
  resolveActiveCenter,
  resolveExploreFitPlaces,
  resolveLocalAreaCoverage,
  resolveSheetDrop,
  resolveSheetOffsets,
  SHEET_FLICK_VELOCITY,
  stopNestedCardAction,
  toggleLiveFilter,
  type DistanceFilter,
  type LiveDiscoveryItem,
  type MapViewport,
  type SheetPosition,
} from "@/lib/live/ui";

/**
 * GESTURE HINT (2026-10-20). The hint is now shown by the FIRST one-finger
 * touch on the map, not by the render: a hint that appeared on load was often
 * already fading (or gone) by the time the map was interactive and the user
 * looked at it. It holds for ~3 s, then fades.
 */
const GESTURE_HINT_VISIBLE_MS = 3000;
/** Pill height in px: 12px text + 2×6px padding + 2px border (measured 28). */
const GESTURE_HINT_HEIGHT_PX = 28;
/**
 * "Already seen" flag. A returning visitor is not taught the same gesture on
 * every visit; the small "?" control in the map's control column recalls it on
 * demand. Storage failures (private mode, disabled storage) are ignored — the
 * hint then simply behaves as un-seen.
 */
const GESTURE_HINT_SEEN_KEY = "singgah.gestureHintSeen";

/**
 * How far the "Tempat Pilihan" tab hangs ABOVE the results sheet's top edge
 * (2026-10-20). 20px is enough to read as a tab over the map while its top
 * edge stays clear of the OSM credit's lower edge (seam − 22) at 360px, where
 * that credit starts furthest left.
 */
const CURATED_TAB_HANG_PX = 20;

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
// LIVE poll request budget (audit fix, 2026-10-17): a hung `/api/live/
// discovery` request must never hold the tab in limbo. The timeout is well
// under the 15 s poll interval, so two ticks can never overlap; on expiry the
// AbortController cancels the request and the feed simply stays on its last
// successful data until the next tick.
const LIVE_REQUEST_TIMEOUT_MS = 10_000;

// GEOCODE request budget (audit fix, 2026-10-17). The server bounds its own
// outbound geocoder call (`GEOCODE_TIMEOUT_MS` in lib/live/photon.ts, 5 s),
// but the browser→server leg could still stall on a flaky network, freezing
// `searchPending` — and, through the in-flight guard, an identical retry —
// until reload. The client budget is comfortably above the server's so a slow
// but healthy answer is never cut off, while a hung one still settles as an
// honest failure.
const GEOCODE_TIMEOUT_MS = 10_000;

/**
 * BOTTOM SHEET (2026-10-18, short-viewport fix 2026-10-19) — three snap
 * positions for the results surface.
 *
 *  · small: only the hanging tab + the 64px handle header — the map is the
 *    screen and the sheet is a grab bar.
 *  · mid: the default. The sheet covers 42% of the stage, leaving ~58% of the
 *    map visible (the requested 55–60% band), capped on short stages so the
 *    floating map controls stay uncovered.
 *  · full: the sheet fills the screen and the card list is the ONLY scrollable
 *    area; the floating "Peta" button returns to mid.
 *
 * Heights are measured from the stage at runtime (`resolveSheetOffsets`), so
 * the same numbers work on every supported height; nothing is a fixed
 * viewport assumption.
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

/**
 * PLACE CATEGORY FOR THE CARD (2026-10-18). The card shows the canonical
 * `places.category` on one truncated line. Values outside the canonical
 * vocabulary — an empty string, a DEV fixture, or a raw test string — fall
 * back to a neutral label instead of printing whatever was stored. It never
 * invents a category, and the card never becomes a category filter.
 */
const PLACE_CATEGORY_FALLBACK = "Kategori belum tersedia";

function displayPlaceCategory(category: string | null | undefined): string {
  const trimmed = (category ?? "").trim();
  return (PLACE_CATEGORIES as readonly string[]).includes(trimmed)
    ? trimmed
    : PLACE_CATEGORY_FALLBACK;
}

/**
 * CARD COVER (2026-10-18) — a 4:5 photo with a skeleton/blur-up and a
 * fail-closed placeholder. The canonical cover wins whenever it loads; the
 * neutral local placeholder (PRESENTATION ONLY — never a Place photo) covers
 * a missing OR failed image, so a card can never render a broken image. The
 * component holds only local image-loading state; no data changes.
 */
function PlaceCardCover({ name, src }: { name: string; src: string | null | undefined }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // CACHED-IMAGE / HYDRATION RECONCILIATION (bug fix, 2026-10-20). The cover is
  // part of the SERVER-rendered markup, so the browser frequently finishes
  // loading it before React hydrates and attaches `onLoad`; for a cached image
  // that event has already fired and never fires again, which left the card on
  // its skeleton for good. This reads the element's own state once per src
  // instead of waiting for an event that may never come. Measured before the
  // fix on a 390×844 load: `complete=true`, `naturalWidth=1200`, computed
  // `opacity: 0` + `blur(12px)` behind the cream skeleton.
  useEffect(() => {
    const state = resolveCoverLoadState(imgRef.current);
    if (state === "loaded") setLoaded(true);
    else if (state === "failed") setFailed(true);
  }, [src]);

  if (!src || failed) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element */
      <img
        src="/place-cover-placeholder.svg"
        alt=""
        aria-hidden
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }

  return (
    <>
      {!loaded && (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-[#e5dfd1] motion-reduce:animate-none"
        />
      )}
      {/* External producer-supplied image URL; next/image would require host
          allowlisting that producers cannot configure. Same rationale and
          pattern as the Place detail hero. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        src={src}
        alt={`Gambar sampul ${name}`}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`h-full w-full object-cover transition-[opacity,filter,transform] duration-500 group-hover:scale-[1.03] motion-reduce:transition-none ${
          loaded ? "scale-100 opacity-100 blur-0" : "scale-105 opacity-0 blur-md"
        }`}
      />
    </>
  );
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
  // Home filter bar — ONE row on mobile (PO 2026-09-26): LIVE leftmost, then
  // the distance tabs ("Tempat Pilihan" moved to the results transition band
  // on 2026-10-18). Default = "1 km":
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
  const [searchNonce, setSearchNonce] = useState(0);
  const [liveItems, setLiveItems] = useState<LiveDiscoveryItem[]>([]);
  // LIVE FEED STATUS (audit fix, 2026-10-17): the feed keeps its LAST
  // SUCCESSFUL payload, so its state is tracked separately from the data.
  //   "loading" — the tab is active and no answer has settled yet;
  //   "ready"   — the last settled request SUCCEEDED (its payload may be
  //               empty, which is a real empty state);
  //   "failed"  — the last settled request FAILED; any previously loaded
  //               items stay in `liveItems` untouched (stale-but-real data
  //               instead of an emptied list), and the next poll retries.
  // The status only decides which EMPTY-STATE copy renders when there are no
  // items at all; it never hides loaded data and adds no banner.
  const [liveFeedStatus, setLiveFeedStatus] = useState<"loading" | "ready" | "failed">("loading");
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

  // BOTTOM SHEET STATE (2026-10-18). `scope` is the settled snap position;
  // `dragOffset` is the live translate while a pointer drags the header (null
  // when settled). The list scrolls ONLY in `full`; in mid/small the sheet
  // shows its header and the first cards and nothing inside it scrolls.
  const stageRef = useRef<HTMLElement | null>(null);
  const sheetListRef = useRef<HTMLDivElement | null>(null);
  // A Place can be listed in BOTH the curated row and the discovery row (the
  // documented OVERLAP rule), so card refs and DOM ids are scoped per row.
  // Selection prefers the curated card, then the discovery card, and the DOM
  // never contains duplicate element ids.
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const dragRef = useRef<{
    startY: number;
    startOffset: number;
    lastY: number;
    lastT: number;
    velocity: number;
  } | null>(null);
  const [stageHeight, setStageHeight] = useState(640);
  const [sheetPosition, setSheetPosition] = useState<SheetPosition>("mid");
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  // Which card's marker is currently highlighted. `pressedPlaceId` is the
  // transient press feedback from a card; `selectedPlaceId` persists after a
  // marker tap so the chosen pin and its card stay visibly linked.
  const [pressedPlaceId, setPressedPlaceId] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [pendingScrollPlaceId, setPendingScrollPlaceId] = useState<string | null>(null);
  // The two-finger hint is a HINT, not a label: it appears when the visitor
  // FIRST touches the map with one finger, stays readable ~3 s, then fades.
  // Presentation only — the map's gestures and the hint's copy are unchanged.
  const [gestureHintVisible, setGestureHintVisible] = useState(false);
  // "Already seen" flag, read after mount (never during render: the server has
  // no localStorage, so reading it early would desynchronise hydration).
  const gestureHintSeenRef = useRef(false);
  const gestureHintTimerRef = useRef<number | null>(null);

  // Measure the stage so the three snap offsets are real pixels. A
  // ResizeObserver covers mobile browser chrome, rotation, and the desktop
  // window; the initial 640 is a paint-safe fallback that the first effect
  // run replaces before the user can interact. The measured height is the
  // REAL visible stage — no artificial floor may push the sheet below the
  // viewport (the old 320px clamp did exactly that on very short stages).
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStageHeight(Math.max(0, node.clientHeight));
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const sheetOffsets = useMemo(() => resolveSheetOffsets(stageHeight), [stageHeight]);
  const settledOffset = sheetOffsets[sheetPosition];
  const sheetOffset = dragOffset ?? settledOffset;
  const sheetVisiblePx = Math.max(0, stageHeight - sheetOffset);

  // GESTURE HINT LIFT (2026-10-20) — the pill rides the visible sheet edge at
  // `sheetVisiblePx + 44`: the 22px OSM credit band plus a 22px gap, so the
  // credit stays readable in every snap position.
  //
  // On a stage short enough for that lift to land inside the floating control
  // column band (top 190…bottom 278, very short landscape phones), the pill
  // parks 8px ABOVE the column instead. Every supported portrait/desktop stage
  // keeps the plain lift.
  const gestureHintLiftBasePx = sheetVisiblePx + 44;
  const gestureHintTopPx = stageHeight - gestureHintLiftBasePx - GESTURE_HINT_HEIGHT_PX;
  const gestureHintLiftPx =
    gestureHintTopPx < MAP_CONTROL_COLUMN_BOTTOM_PX &&
    gestureHintTopPx + GESTURE_HINT_HEIGHT_PX > MAP_CONTROL_COLUMN_TOP_PX
      ? stageHeight - (MAP_CONTROL_COLUMN_TOP_PX - 8)
      : gestureHintLiftBasePx;

  // One "seen" flag, one timer. `remember` is false only for the explicit
  // "?" recall, which may show the hint again after it was already seen.
  const showGestureHint = useCallback((remember: boolean) => {
    if (gestureHintTimerRef.current !== null) {
      window.clearTimeout(gestureHintTimerRef.current);
      gestureHintTimerRef.current = null;
    }
    setGestureHintVisible(true);
    if (remember) {
      gestureHintSeenRef.current = true;
      try {
        window.localStorage.setItem(GESTURE_HINT_SEEN_KEY, "1");
      } catch {
        // Storage unavailable (private mode): the flag just does not persist.
      }
    }
    gestureHintTimerRef.current = window.setTimeout(() => {
      gestureHintTimerRef.current = null;
      setGestureHintVisible(false);
    }, GESTURE_HINT_VISIBLE_MS);
  }, []);

  useEffect(() => {
    try {
      gestureHintSeenRef.current = window.localStorage.getItem(GESTURE_HINT_SEEN_KEY) === "1";
    } catch {
      // Storage unavailable: behave as un-seen for this session.
    }
    return () => {
      if (gestureHintTimerRef.current !== null) window.clearTimeout(gestureHintTimerRef.current);
    };
  }, []);

  // TRIGGER (2026-10-20): the FIRST one-finger touch on the map surface — not
  // the render. Gated so the hint can never appear while the map is still
  // loading (`mapViewport` is the map's first real report), while the sheet is
  // being dragged, from the second finger of a pinch (`isPrimary`), or again
  // once the visitor has seen it. Mouse/pen pointers carry no touch gesture to
  // teach, so they are ignored.
  const sheetDragging = dragOffset !== null;
  const mapReady = mapViewport !== null;
  useEffect(() => {
    const node = stageRef.current;
    if (!node || !mapReady) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || !event.isPrimary) return;
      if (sheetDragging || gestureHintSeenRef.current) return;
      const target = event.target as Element | null;
      // The map surface only: a touch on the search bar, the filter row, the
      // sheet, or the floating controls is not a map gesture.
      if (!target?.closest(".singgah-home-map")) return;
      showGestureHint(true);
    };
    node.addEventListener("pointerdown", onPointerDown);
    return () => node.removeEventListener("pointerdown", onPointerDown);
  }, [mapReady, sheetDragging, showGestureHint]);

  const setSheetSnap = useCallback((next: SheetPosition) => {
    dragRef.current = null;
    setDragOffset(null);
    setSheetPosition(next);
  }, []);

  // The "?" tile in the control column: re-show the SAME hint component, on
  // demand, for a visitor whose "seen" flag is already set. It lives in the
  // map's control column, which the sheet covers at `full` — so it is exactly
  // as reachable as the map it explains, and it never moves the sheet.
  const handleShowGestureHint = useCallback(() => {
    showGestureHint(false);
  }, [showGestureHint]);

  const beginSheetDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      // ONE pointer owns the drag. A second finger on the handle must not reset
      // the origin while the first is still down (otherwise the first pointerup
      // would settle using the second pointer's start point).
      if (dragRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      dragRef.current = {
        startY: event.clientY,
        startOffset: settledOffset,
        lastY: event.clientY,
        lastT: performance.now(),
        velocity: 0,
      };
      setDragOffset(settledOffset);
    },
    [settledOffset],
  );

  const moveSheetDrag = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const now = performance.now();
      const delta = event.clientY - drag.startY;
      const next = Math.min(Math.max(drag.startOffset + delta, sheetOffsets.full), sheetOffsets.small);
      const elapsed = now - drag.lastT;
      if (elapsed > 0) drag.velocity = (event.clientY - drag.lastY) / elapsed;
      drag.lastY = event.clientY;
      drag.lastT = now;
      setDragOffset(next);
    },
    [sheetOffsets.full, sheetOffsets.small],
  );

  const endSheetDrag = useCallback((event?: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    // Explicit release: pointer capture is otherwise only released implicitly,
    // and a lost capture must never leave the sheet stuck mid-drag.
    if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    // The release point is the authoritative end of a slow drag; the last
    // pointermove can be several pixels behind it.
    const releasedY = event?.clientY ?? drag.lastY;
    const current = Math.min(
      Math.max(drag.startOffset + (releasedY - drag.startY), sheetOffsets.full),
      sheetOffsets.small,
    );
    // A flick is only a flick while the pointer is still moving. If the last
    // move was long before the release (the finger stopped, then lifted), the
    // stale velocity must not advance an extra snap.
    const velocity = performance.now() - drag.lastT > 100 ? 0 : drag.velocity;
    // FAST GESTURE: a flick moves exactly one snap in its direction; a slower
    // drag settles on the nearest snap. Both paths end on a real position.
    // The decision is the shared, unit-tested `resolveSheetDrop`.
    const next = resolveSheetDrop({
      position: sheetPosition,
      offsets: sheetOffsets,
      offsetPx: current,
      velocity,
      flickVelocity: SHEET_FLICK_VELOCITY,
    });
    setDragOffset(null);
    setSheetPosition(next);
  }, [sheetOffsets, sheetPosition]);

  const handleSheetKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const order: SheetPosition[] = ["small", "mid", "full"];
      const index = order.indexOf(sheetPosition);
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSheetSnap(order[Math.min(order.length - 1, index + 1)]);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSheetSnap(order[Math.max(0, index - 1)]);
      } else if (event.key === "Home") {
        event.preventDefault();
        setSheetSnap("full");
      } else if (event.key === "End") {
        event.preventDefault();
        setSheetSnap("small");
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSheetSnap(sheetPosition === "full" ? "mid" : "full");
      }
    },
    [setSheetSnap, sheetPosition],
  );

  // MARKER → CARD (2026-10-18). A base-pin tap selects the Place: the marker
  // is highlighted, the sheet opens to full so the list can actually scroll,
  // and the matching card is scrolled into view only when it is not already
  // visible. The card link remains the only navigation target.
  const selectPlaceFromMap = useCallback((placeId: string) => {
    setSelectedPlaceId(placeId);
    setPressedPlaceId(null);
    setPendingScrollPlaceId(placeId);
    setSheetPosition("full");
  }, []);

  useEffect(() => {
    if (!pendingScrollPlaceId || sheetPosition !== "full") return;
    const node =
      cardRefs.current.get(`curated:${pendingScrollPlaceId}`) ??
      cardRefs.current.get(`discovery:${pendingScrollPlaceId}`);
    const list = sheetListRef.current;
    if (!node || !list) {
      setPendingScrollPlaceId(null);
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    // Let the snap transition settle before measuring; reduced motion skips
    // the wait and the smooth scroll together.
    const timer = window.setTimeout(() => {
      const listRect = list.getBoundingClientRect();
      const cardRect = node.getBoundingClientRect();
      const alreadyVisible = cardRect.top >= listRect.top && cardRect.bottom <= listRect.bottom;
      if (!alreadyVisible) {
        node.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
      }
      setPendingScrollPlaceId(null);
    }, reduced ? 0 : 320);
    return () => window.clearTimeout(timer);
  }, [pendingScrollPlaceId, sheetPosition]);

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
  //
  // FEED INTEGRITY (audit fix, 2026-10-17). The old `.catch(() =>
  // setLiveItems([]))` turned every transient failure into an EMPTY list —
  // valid LIVE cards, pins, and rows vanished and the UI claimed "belum ada
  // Live" while the network was merely down. The rules now:
  //  · a failed request NEVER writes `liveItems` — the last successful
  //    payload stays on screen (stale-but-real), and only the internal
  //    status marks it as not-freshly-updated;
  //  · every request carries an AbortController with a bounded timeout, is
  //    aborted on teardown, and an in-flight request is aborted when the
  //    next tick starts, so slow responses can neither pile up nor land
  //    after a newer answer (a per-load request number drops them);
  //  · polling pauses while the tab is hidden and reloads immediately on
  //    return, so a background tab keeps no requests running;
  //  · loading / loaded-empty / failed stay DISTINCT states, so a legitimate
  //    empty result is still shown as an empty state and a failure is never
  //    shown as "no Live". The reset to "loading" deliberately lives in the
  //    LIVE tab's click handler (the only path that turns the tab on), NOT in
  //    this effect: a synchronous setState here would cascade a re-render per
  //    mode entry, and a poll RETRY must keep the "failed" card visible
  //    instead of flickering it away for one round trip.
  useEffect(() => {
    if (!liveOnly) return;

    let cancelled = false;
    let latestRequest = 0;
    let inFlight: AbortController | null = null;

    const load = () => {
      // A hidden tab must not poll; the visibility listener below reloads the
      // moment the tab becomes visible again.
      if (document.visibilityState === "hidden") return;
      const request = ++latestRequest;
      // One request at a time: a new tick supersedes a still-running one.
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const timeout = window.setTimeout(() => controller.abort(), LIVE_REQUEST_TIMEOUT_MS);
      fetch("/api/live/discovery", { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Live discovery unavailable"))))
        .then((payload: { live: LiveDiscoveryItem[] }) => {
          // Only the NEWEST request of the CURRENT tab session may write
          // state — a late answer can never overwrite a newer one.
          if (cancelled || request !== latestRequest) return;
          setLiveItems(payload.live ?? []);
          setLiveFeedStatus("ready");
        })
        .catch(() => {
          // KEEP THE LAST GOOD DATA: a failure marks the feed as failed and
          // changes nothing else. `liveItems` keeps whatever the last
          // successful load returned, so a network blip can never empty the
          // list or hide LIVE pins that were real a moment ago.
          if (cancelled || request !== latestRequest) return;
          setLiveFeedStatus("failed");
        })
        .finally(() => {
          window.clearTimeout(timeout);
          if (inFlight === controller) inFlight = null;
        });
    };

    // Polling pauses with the hidden tab and resumes with one fresh load.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    load();
    const interval = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      // No state may land after teardown; the in-flight request is aborted
      // and its answer is dropped by both the cancel flag and the request
      // number.
      latestRequest += 1;
      inFlight?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(interval);
    };
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

      // CLIENT-SIDE TIMEOUT (audit fix, 2026-10-17): one AbortController per
      // submit, aborted on a bounded timeout. An aborted request settles into
      // the EXISTING failure path below — same honest message, same state
      // reset, `searchPending` dropped, `inFlightSearchRef` freed in
      // `finally` — so the next search always works without a reload, and a
      // cancellation is never treated as a valid search result.
      let timeoutId: number | null = null;
      try {
        const controller = new AbortController();
        timeoutId = window.setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
        const response = await fetch(`/api/geocode?q=${encodeURIComponent(trimmed)}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
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
        resetViewportLatch();
      } catch {
        if (submittedSearchRef.current !== trimmed) return;
        if (!isCurrent()) return;
        setSearchPending(false);
        setSearchError("Layanan lokasi sedang tidak tersedia. Coba lagi nanti.");
        setSearchCenter(null);
        setSearchArea(null);
      } finally {
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        // The query is only free again once THIS request settled, so an
        // identical submit issued while it was in flight stays a no-op.
        if (inFlightSearchRef.current === trimmed) inFlightSearchRef.current = null;
        // The camera trigger bumps ONLY while this answer still owns the
        // current intent (audit fix, 2026-10-17). A SUPERSEDED request that
        // settles late used to bump `searchNonce` unconditionally, which
        // re-fired the map's search-camera effect for the newer answer —
        // re-fitting and re-latching a frame the user may have already panned
        // away from, without any new search having answered. The three
        // explicit invalidation paths (empty submit, clear ×, "Lokasi Saya")
        // reset the center themselves, so they never needed this bump.
        if (isCurrent()) setSearchNonce((nonce) => nonce + 1);
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
    // Coverage goes back to the REAL Leaflet bounds; the synthetic bridge box
    // existed only for a city that no longer owns the viewport.
    resetViewportLatch();
    // The frame this press produces is the viewer's LOCAL AREA; the map must
    // not let a later radius preset take the camera back.
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

  // The floating "Tempat Pilihan" information board was REMOVED (2026-10-18).
  // It restated the layer name, a per-layer count, the camera radius, and a
  // "Ke hasil" scroll action in a card that permanently covered the map's
  // bottom edge, and it duplicated the results sheet that starts right below
  // it. Its title, count, radius wording, and "Ke hasil" action are gone with
  // it; the curated LIST, the curated cards, the filter state, and every
  // camera/coverage rule they read stay exactly as they were.

  // ONE card renderer for every row (2026-10-18): the compact 2-column card.
  // It keeps every previous attribute — cover, ✦ curated badge, decorative
  // heart, real distance, name, category, stars, Follow, Direction, LIVE
  // status — except the short description, which now lives only on the
  // Place detail page. No numeric score is ever rendered anywhere.
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
        className="group flex h-full w-full flex-col overflow-hidden rounded-[22px] border border-black/5 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition duration-200 hover:shadow-[0_8px_20px_rgb(0_0_0/0.08)] motion-safe:active:scale-[0.99]"
        visitedClassName={live ? "border-live/50 bg-[#fdf6f2]" : "border-brand-accent/30 bg-[#faf6ee]"}
        onPointerDown={() => setPressedPlaceId(place.id)}
        onPointerUp={() => setPressedPlaceId(null)}
        onPointerCancel={() => setPressedPlaceId(null)}
        onPointerLeave={() => setPressedPlaceId(null)}
      >
        {/* CARD COVER — 4:5 full-bleed (2026-10-18). The canonical cover wins;
            a missing or failed image falls back to the neutral local
            placeholder, and a real cover blur-ups from a skeleton. */}
        <div className="relative aspect-[4/5] w-full shrink-0 overflow-hidden bg-[#ece7db]">
          <PlaceCardCover name={place.name} src={place.coverImageUrl} />

          {/* OVERLAYS: ✦ curated badge top-left, decorative heart top-right,
              real distance bottom-left on a glass pill, pulsing LIVE pill
              bottom-right when a session is active. The distance stays
              fail-closed: it renders ONLY when the real origin and canonical
              Place coordinates both exist — never a fabricated number. */}
          {isCurated && (
            <span
              className="absolute left-1.5 top-1.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-brand-secondary text-[11px] leading-none text-white shadow-[0_1px_3px_rgb(0_0_0/0.18)] ring-1 ring-white/60"
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
            className="absolute right-1.5 top-1.5 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white/90 text-[11px] leading-none text-brand-ink/70 shadow-[0_1px_3px_rgb(0_0_0/0.12)]"
          >
            ♡
          </span>
          {distance && (
            <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-0.5 rounded-full bg-brand-ink/60 px-1.5 py-1 text-[10px] font-bold leading-none text-white shadow-[0_1px_3px_rgb(0_0_0/0.24)] ring-1 ring-white/25 backdrop-blur-md">
              <span aria-hidden>➤</span>
              {distance}
            </span>
          )}
          {live && (
            <button
              type="button"
              onClick={(event) => {
                stopNestedCardAction(event);
                router.push(`/live/${live.sessionId}`);
              }}
              className="absolute bottom-1.5 right-1.5 z-10 inline-flex items-center gap-1 rounded-full bg-live px-2 py-1 text-[10px] font-bold uppercase tracking-wide leading-none text-white shadow-[0_2px_8px_rgb(0_0_0/0.24)] transition hover:opacity-90"
              aria-label={`Buka Live di ${place.name}`}
            >
              <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none" />
              LIVE
            </button>
          )}
        </div>

        {/* CARD TEXT — name (max 2 lines), category (1 truncated line), the
            5-slot star row, then the compact LIVE status chip. Stars come
            ONLY from the canonical Discovery engine output (stars alone —
            the numeric score never leaves the server); a Place outside the
            engine shows five empty slots. NEVER a rating number, NEVER a
            review count — no such data exists in this product. The short
            description is NOT rendered on the card any more; it stays on the
            Place detail page. */}
        <div className="flex flex-1 flex-col p-2.5">
          <h3 className="line-clamp-2 text-[13px] font-bold leading-snug text-brand-ink">{place.name}</h3>
          <p className="mt-0.5 truncate text-[10px] font-semibold tracking-wide text-brand-ink/55">
            {displayPlaceCategory(place.category)}
          </p>
          {/* MOCKUP §9/§18: five star slots, always. The active slots take the
              gold tone OF THE ACTUAL rating value (1→4 from the canonical
              engine), the empty slots stay light gray, and no rating number
              or review count is ever rendered — neither exists in the data. */}
          <p className="mt-1 flex items-center gap-px" aria-hidden>
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

          {/* LIVE STATUS (PO 2026-09-26, compacted 2026-10-18): every card
              keeps its honest status. With an active session the red pulsing
              pill sits ON the photo (above); without one this compact chip
              says "Belum LIVE" and carries the full sentence in its
              aria-label. Pressing it still shows the honest non-live notice;
              live state itself is never invented — the canonical
              liveByPlaceId feed is the only source. */}
          {!live && (
            <button
              type="button"
              aria-pressed={nonLiveNoticePlaceId === place.id}
              onClick={(event) => {
                stopNestedCardAction(event);
                setNonLiveNoticePlaceId((current) => (current === place.id ? null : place.id));
              }}
              className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-live/[0.08] px-1.5 py-0.5 text-[10px] font-bold leading-none text-live transition hover:bg-live/[0.14]"
              aria-label={`${place.name}: Belum LIVE — belum ada proses Live yang berlangsung. Ketuk untuk keterangan.`}
            >
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-live/60" />
              Belum LIVE
            </button>
          )}
          {!live && nonLiveNoticePlaceId === place.id && (
            <p
              role="status"
              className="mt-1.5 rounded-[10px] bg-live/[0.08] px-2 py-1 text-[10px] font-semibold leading-snug text-live"
            >
              {place.name} sedang tidak Live. Tempat ini dapat memulai Live kapan saja.
            </p>
          )}

          {/* ONE ACTION ROW: Direction is the primary deep-green control
              (flex-1, icon + text); Follow is the outline icon button next
              to it. Both are at least 40px tall. */}
          <div className="mt-auto flex items-center gap-1.5 pt-2">
            {directionsUrl ? (
              <button
                type="button"
                onClick={(event) => {
                  stopNestedCardAction(event);
                  window.open(directionsUrl, "_blank", "noopener,noreferrer");
                }}
                className="inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-1 rounded-[12px] bg-brand-primary px-2 text-[11px] font-bold text-white shadow-[0_2px_8px_rgb(14_107_79/0.18)] transition hover:bg-brand-primary-deep"
                aria-label={`Petunjuk arah ke ${place.name} di aplikasi peta`}
              >
                <span aria-hidden>➤</span>
                <span className="truncate">Direction</span>
              </button>
            ) : (
              // Fail-closed: no canonical coordinates → no navigation target
              // is ever invented.
              <span
                aria-disabled="true"
                title="Koordinat Tempat belum tersedia"
                className="inline-flex h-10 min-w-0 flex-1 cursor-not-allowed items-center justify-center gap-1 rounded-[12px] bg-brand-ink/[0.06] px-2 text-[11px] font-bold text-brand-ink/30"
              >
                <span aria-hidden>➤</span>
                <span className="truncate">Direction</span>
              </span>
            )}
            <PlaceFollowButton placeId={place.id} iconOnly />
          </div>
        </div>
      </VisitedLink>
    );
  };

  return (
    <main
      ref={stageRef}
      /* 100dvh is the area the user can actually see (it follows mobile
         browser chrome). The old 560px minimum made the stage TALLER than a
         short landscape viewport, pushing the sheet's handle and lower edge
         below the visible screen; the stage now never exceeds the viewport. */
      className="relative h-[100dvh] overflow-hidden bg-brand-cream text-brand-ink"
    >
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
      <section className="absolute inset-0 isolate overflow-hidden bg-[#d9dfd2]">
        {/* Map base layer — full-bleed behind ALL floating chrome. */}
        <div className="absolute inset-0 z-0">
          <HomeMap
            places={visibleMapPlaces}
            liveByPlaceId={liveByPlaceId}
            viewerPosition={viewerPosition}
            locateNonce={locateNonce}
            onRequestLocate={handleLocatePress}
            /* GESTURE HINT RECALL (2026-10-20): the "?" tile in the control
               column re-opens the one hint component. */
            onShowGestureHint={handleShowGestureHint}
            /* The REAL visible viewport is reported back here: it is the ONE
               geographic coverage source for the markers and for the Discovery
               Place / "Tempat Pilihan" rows. It carries geometry only — it
               never changes eligibility, membership, or the camera. */
            /* ONE deterministic camera preset for the distance tabs (PO,
               2026-09-29; coverage unified by the product decision of
               2026-09-30; curated decoupled 2026-10-05): the 1/5/10 km tabs
               map to their ordered preset radii. "Tempat Pilihan" is a
               PRESENTATION layer and no longer switches the camera to a 10 km
               frame, so the prop carries only the active distance preset.
               CAMERA-ONLY — the curated membership (canonical is_curated) and
               the curated LIST below stay independent of this value. */
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
            /* One-shot pin focus feedback (PO, 2026-09-30): a SHORT pulse on
               the EXISTING Current Location pin — no new marker, no map
               animation of its own; the camera itself moves through the
               shared 0.6 s transition (instant under prefers-reduced-motion,
               see cameraAnimationOptions in home-map.tsx). Since the curated
               tab became presentation-only (2026-10-05) it no longer changes
               the preset radius, so this wiring fires no pulse on its own —
               it is kept as the pinned presentation contract for whenever a
               preset pulse is due again. */
            pulsePinOnPresetChange={curatedOnly}
            onViewportHasPlaces={handleViewportHasPlaces}
            onViewportChange={handleViewportChange}
            /* MARKER ↔ CARD (2026-10-18): a base pin tap selects its Place —
               the pin is highlighted and the matching card is scrolled into
               view. A transient press on a card highlights the same pin. */
            highlightedPlaceId={pressedPlaceId ?? selectedPlaceId}
            onSelectPlace={selectPlaceFromMap}
            /* The OSM attribution is lifted above the visible sheet edge, so
               the credit is never covered at any snap position. */
            bottomInset={sheetVisiblePx}
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

          {/* Home filter bar — ONE row (PO 2026-09-26; MOCKUP §3).
              MOVED (2026-10-18): "Tempat Pilihan" left this row for the
              results sheet at the bottom of the map, so the row now holds the
              LIVE filter plus the three ordered distance tabs. LIVE stays
              leftmost and the radius presets keep their master labels
              ("10 km+" is master-locked) and their order. The same single-row
              guarantee applies: no wrap, no second row, no page-level
              horizontal overflow at 360 px.

              MOCKUP §3 selected state: the active control is BRAND GREEN
              (bg-brand-primary), the distance tabs keep their white surface,
              and LIVE keeps its red dot. Selection logic, handlers, and
              semantics are completely unchanged — only the colors moved.

              The four-column split replaces the old five-column one byte for
              byte in spirit: `auto` for LIVE, then three equal radius cells. */}
          {/* FILTER ROW SURFACE (bug fix, 2026-10-20): the four chips float on
              the map, so the 6px gaps between them used to show whatever sat
              behind — a Place name chip ("…al") could be read through the row.
              The row now paints an OPAQUE cream surface (same brand token as
              the header/sheet) with a hairline ring, so nothing behind it can
              leak between the chips. Zero padding: chip size and the row's
              height are unchanged, so the control column's 190px start still
              matches the chrome. Handlers, order, colours, and semantics are
              untouched. */}
          <div className="pointer-events-auto mt-2.5 grid w-full min-w-0 grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-1.5 rounded-[16px] bg-brand-cream ring-1 ring-black/5">
            <button
              onClick={() => {
                // Mutually exclusive modes (lib/live/ui.ts): turning LIVE on
                // leaves "Tempat Pilihan"; turning it off changes nothing
                // else (curated layer and distance tab keep their state).
                const next = toggleLiveFilter(liveOnly, curatedOnly);
                setLiveOnly(next.liveOnly);
                setCuratedOnly(next.curatedOnly);
                // Fresh session per entry (audit fix, 2026-10-17): entering
                // LIVE resets the feed status here, in click context — the
                // effect itself never sets state synchronously, and a stale
                // "failed" from a previous visit can never greet a new one.
                setLiveFeedStatus("loading");
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
            {DISTANCE_FILTERS.map((filter) => (
              <button
                key={filter}
                onClick={() => {
                  setDistanceFilter(filter);
                  // A radius preset owns the map on its own, so it leaves the
                  // curated place-set tab — the rule it has always had. A
                  // distance tab is also an explicit camera request, which
                  // releases the map's interaction latch.
                  setCuratedOnly(false);
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

          {/* MAP SURFACE (2026-10-18): the map now fills the whole stage, and
              the bottom sheet floats over its lower half. The old in-flow
              `60vh` spacer is gone with the flow layout; the stage itself is
              the Leaflet box, so it always has a valid, non-degenerate size.
              The floating chrome still reserves its top band, and the sheet
              reserves the bottom one — no camera rule changed. */}
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
             size and shadow are reduced, and it stays clear of the Leaflet
             controls.

             RAISED to `bottom-32` (2026-10-04): the floating results card now
             owns the map's bottom-left corner, and its height is not fixed —
             a long search query wraps the panel title to a second line and
             grows the card by roughly one more row. At `bottom-24` those two
             cards could touch when a search returned nothing (empty state up,
             floating results card down, both centered and overlapping
             horizontally). `bottom-32` clears a two-line title with room to
             spare, and the 470px map floor leaves ample space above it. */
          <div
            className="pointer-events-none absolute inset-x-0 z-[1100] flex justify-center px-4 transition-[bottom] duration-300 motion-reduce:transition-none"
            style={{ bottom: sheetVisiblePx + 128 }}
          >
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

        {/* CONSOLIDATED INFORMATION BOARD: REMOVED (2026-10-18).
            The floating "Tempat Pilihan" card that used to sit on the map's
            bottom edge — title, per-layer count, radius/coverage wording, and
            the "Ke hasil" scroll action — is GONE, together with the height
            it permanently covered. It restated the layer and its context in a
            second surface directly above the results sheet, so nothing
            replaces it: no count strip, no radius caption, no scroll action.
            The map's bottom edge is now clear for the map itself and for the
            OSM attribution, which keeps its existing fixed offset (there is no
            floating card left to lift it above).

            The measured SCALE BAR was removed on 2026-10-04 and still renders
            nothing in its place; no distance indicator replaces it either. */}

        {/* GESTURE HINT (2026-10-18; compact 2026-10-20): the only touch
            gestures this map keeps are TWO-FINGER ones. Verified against the
            installed Leaflet 1.9 source: TouchZoom's `_onTouchMove` pans by the
            pinch MIDPOINT and zooms by the pinch DISTANCE, while the
            touch-primary one-finger lock (`dragging` / `doubleClickZoom` off)
            leaves a single finger to scroll the page. The hint therefore states
            exactly the supported pair — never a gesture the map cannot
            perform.

            CONTRAST (2026-10-20): the old pill was 10px, 55%-opacity ink on an
            85%-opaque white card — it read as text leaking onto the map. It is
            now a SOLID deep-green pill (`brand-primary-deep` #0a5640, opaque)
            with pure white 12px semibold text: contrast 8.69:1 (WCAG AA needs
            4.5:1). One thin light border plus a soft green shadow separates it
            from the tiles; a 14px two-finger icon sits in front of the words.
            It keeps the control column's 12px right inset and rides 44px above
            the visible seam, so the OSM credit keeps its gap. Because a marker
            or the blue location dot can legitimately be anywhere (this frame's
            pins clear the pill on all three sheet positions at 360/390, but
            that is data, not a guarantee), the hint also fades after
            GESTURE_HINT_VISIBLE_MS — it never becomes a permanent cover over
            the map it describes. One component, still click-through, no
            gesture logic touched. */}
        {gestureHintVisible && (
          <div
            data-gesture-hint
            className="pointer-events-none absolute right-3 z-[1100] inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-brand-primary-deep px-3 py-1.5 text-[12px] font-semibold leading-none text-white shadow-[0_6px_18px_rgb(10_86_64/0.35)] transition-opacity duration-300 motion-reduce:transition-none"
            style={{ bottom: gestureHintLiftPx }}
          >
            {/* Two-finger glyph: exactly the gesture the map supports. */}
            <svg aria-hidden viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M9 11V5.8a1.6 1.6 0 0 1 3.2 0V11" />
              <path d="M12.2 11V4.9a1.6 1.6 0 0 1 3.2 0V11" />
              <path d="M15.4 11.4V7.6a1.6 1.6 0 0 1 3.2 0V15a5.4 5.4 0 0 1-5.4 5.4h-1.5a5 5 0 0 1-3.9-1.9l-3-3.6a1.6 1.6 0 0 1 2.4-2.1L9 14.6" />
            </svg>
            2 jari: geser &amp; cubit
          </div>
        )}

      </section>

      {/* RESULTS BOTTOM SHEET (2026-10-18) — three positions, one surface.
          `small`, `mid`, and `full` are measured snap offsets (see
          sheetOffsets); the sheet is always full-height and translated down,
          so its header stays at the visible top edge in every position. The
          floating "Peta" button is the only exit from `full`. The tab and
          the handle live in the header and therefore travel with the sheet. */}
      <section
        className={`singgah-sheet absolute inset-x-0 bottom-0 z-20 flex h-full flex-col rounded-t-[24px] bg-brand-cream shadow-[0_-8px_24px_rgb(0_0_0/0.08)] ${
          dragOffset !== null ? "singgah-sheet-dragging" : ""
        }`}
        style={{ transform: `translateY(${sheetOffset}px)` }}
        aria-labelledby="place-results-heading"
      >
        {/* COMPACT HANDLE BAND (2026-10-19): the seam band is 48px instead of
            64px — the 44px drag target plus 2px of breathing room — so the map
            and the first Tempat Pilihan card lose only the space that was
            genuinely spare. The handle, its keyboard controls, the snap math
            (`SHEET_HEADER_PX`), and the one drag target are unchanged. */}
        <div className="relative flex h-12 shrink-0 items-center justify-center">
          {/* The sheet's accessible name. It stays in the DOM so
              `aria-labelledby` always resolves, but it is not a visible
              title. */}
          <h2 id="place-results-heading" className="sr-only">
            Hasil Tempat
          </h2>

          {/* HANDLE (2026-10-18): the one drag target. It is a real button —
              focusable, keyboard-operable (ArrowUp/ArrowDown/Home/End,
              Enter/Space), named for assistive technology, and at least 44px
              in both axes. Pointer capture keeps the drag on the handle even
              when the finger leaves it. */}
          <button
            type="button"
            aria-label="Atur tinggi panel hasil"
            title="Geser untuk mengubah tinggi panel hasil"
            aria-expanded={sheetPosition === "full"}
            onPointerDown={beginSheetDrag}
            onPointerMove={moveSheetDrag}
            onPointerUp={endSheetDrag}
            onPointerCancel={endSheetDrag}
            onLostPointerCapture={endSheetDrag}
            onKeyDown={handleSheetKeyDown}
            className="inline-flex h-11 w-16 touch-none cursor-grab items-center justify-center rounded-full text-brand-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/50 active:cursor-grabbing"
          >
            <span aria-hidden className="block h-1.5 w-10 rounded-full bg-black/15" />
            <span className="sr-only">Tarik atau gunakan tombol panah untuk mengubah tinggi panel</span>
          </button>

          {/* PANEL TAB (2026-10-18; HANGING above the seam, 2026-10-20). ONE
              instance. In small/mid it now protrudes 20px ABOVE the sheet's
              top edge — a real tab hanging over the map, with a strong shadow
              — instead of sitting inline with the handle, where it read as a
              card attribute. At `full` the sheet is already at the top of the
              stage, so the tab tucks 2px inside the header band instead of
              being pushed off-screen; there it still keeps 18px to the first
              card (2+44 → 64).

              PLACEMENT: bottom-LEFT, 20px above the seam. The OSM credit is
              bottom-RIGHT and its lower edge sits at seam−22, so the tab's top
              edge (seam−20) clears it in every position — measured at 360px,
              where the credit starts furthest left (x=126). The gesture pill
              lives bottom-right too, the floating control column top-right
              (190…278), and the first card starts at seam+48, i.e. 24px below
              the tab's lower edge (required gap: 16px).

              CONTRAST: inactive = opaque white + hairline border + ink text;
              active = dark brand green with pure white text. 44px tap height
              (min-h-11), 11px bold label, ✦ icon, px-2 and a 4px gap keep the
              chip at ~126px, so at 360px its right edge (x=142) stays 6px
              clear of the centred 64px drag handle (x=148).

              The handler, `aria-pressed`, the curated-activation rule and the
              LIVE exclusivity rule are unchanged, and the tab still travels
              with the sheet because it is positioned against the sheet's own
              header. */}
          <button
            type="button"
            onClick={() => {
              // Same exclusivity rule from the curated side: LIVE off.
              const next = activateCuratedFilter();
              setCuratedOnly(next.curatedOnly);
              setLiveOnly(next.liveOnly);
            }}
            aria-pressed={curatedOnly}
            title="Tempat Pilihan"
            /* The hang is an inline offset, not a utility class: it is derived
               from the measured seam, so `top` is explicit (-20px = 20px of the
               tab above the sheet edge; 2px inside the band at `full`). */
            style={{ top: sheetPosition === "full" ? 2 : -CURATED_TAB_HANG_PX }}
            className={`absolute left-4 z-30 inline-flex min-h-11 items-center justify-center gap-1 whitespace-nowrap rounded-[14px] border px-2 text-[11px] font-bold shadow-[0_8px_18px_rgb(0_0_0/0.22)] transition active:scale-[0.98] ${
              curatedOnly
                ? "border-brand-primary bg-brand-primary text-white shadow-[0_8px_18px_rgb(14_107_79/0.35)]"
                : "border-black/10 bg-white text-brand-ink hover:bg-brand-cream"
            }`}
          >
            <span aria-hidden>✦</span>
            Tempat Pilihan
          </button>
        </div>

        {/* Only the LIST scrolls, and only in `full`; in small/mid the same
            content is clipped by the sheet so a swipe can never fight the
            sheet drag or the map. */}
        <div
          ref={sheetListRef}
          className={`mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col px-4 ${
            sheetPosition === "full"
              ? "overflow-y-auto overscroll-contain pb-24 pt-4"
              : "overflow-hidden pb-8"
          }`}
        >
        {/* "Tempat Pilihan" is ONE curated discovery layer (PO 2026-09-26):
            no category chips and no secondary category row — Place
            categories stay internal data, never a Home filter UI. */}

        {/* LIVE filter EMPTY state — shown ONLY when the feed really loaded
            and the result really was empty (`ready`). Based only on canonical
            discovery data; no fake Live. */}
        {liveOnly && liveItems.length === 0 && liveFeedStatus === "ready" && (
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

        {/* LIVE feed FAILED with NOTHING loaded yet (audit fix, 2026-10-17).
            Before the first successful load there is no data to keep, so this
            is the ONE honest case where the LIVE tab has genuinely nothing to
            show AND cannot confirm whether any Live exists. It says so plainly
            instead of claiming "belum ada Live", it adds no banner elsewhere,
            and it needs no retry button: the running 15 s poll retries by
            itself and swaps this card for the real list or the real empty
            state as soon as an answer settles. Once ANY payload has loaded,
            a later failure keeps that data on screen and this card never
            appears. */}
        {liveOnly && liveItems.length === 0 && liveFeedStatus === "failed" && (
          <div
            role="status"
            className="mt-4 rounded-[18px] border border-live/20 bg-white p-6 text-center shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
          >
            <p className="text-sm font-bold text-brand-ink">Live belum dapat dimuat.</p>
            <p className="mt-1 text-xs text-brand-ink/60">
              Periksa koneksi internet Anda. Daftar akan diperbarui otomatis.
            </p>
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
            engine order), narrowed by search and the visible area. Inside the
            Tempat Pilihan layer the results render as TWO ordered rows —
            Baris 1: Tempat Pilihan, Baris 2: Discovery Place — while every
            other mode renders that single canonical row. No layer ever
            deduplicates the other: a Place in both layers appears in both
            rows (OVERLAP rule). */}
          {/* Baris 1 (curated layer only): the Admin-promoted selection.
              Renders nothing when no Place is curated — the curated layer
              never substitutes the full published set.
              MOCKUP §12 / 2026-10-18: the row is a 2-column card GRID on a
              vertical scroll — same dataset, same order, same cards;
              presentation only. */}
          {curatedOnly && curatedListed.length > 0 && (
            <>
              <p className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-brand-ink/55">
                Tempat Pilihan
              </p>
              <div
                id={CURATED_RESULTS_ANCHOR_ID}
                className="-mx-4 grid grid-cols-2 items-stretch gap-x-3 gap-y-4 px-4 pb-1"
              >
                {curatedListed.map((place) => (
                  <div
                    key={place.id}
                    id={`place-card-curated-${place.id}`}
                    data-place-card-id={place.id}
                    ref={(node) => {
                      const key = `curated:${place.id}`;
                      if (node) cardRefs.current.set(key, node);
                      else cardRefs.current.delete(key);
                    }}
                    className={`h-full w-full rounded-[24px] ${
                      selectedPlaceId === place.id
                        ? "ring-2 ring-brand-primary ring-offset-2 ring-offset-brand-cream"
                        : ""
                    }`}
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
                <p className="mb-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.12em] text-brand-ink/55">
                  Discovery Place
                </p>
              )}
              {/* 2026-10-18: the same 2-column grid as Baris 1 — a vertical
                  scroll of compact cards. Same dataset, same order, same
                  cards (presentation only). */}
              <div
                id={DISCOVERY_RESULTS_ANCHOR_ID}
                className="-mx-4 grid grid-cols-2 items-stretch gap-x-3 gap-y-4 px-4 pb-1"
              >
                {discoveryRowPlaces.map((place) => (
                  <div
                    key={place.id}
                    id={`place-card-discovery-${place.id}`}
                    data-place-card-id={place.id}
                    ref={(node) => {
                      const key = `discovery:${place.id}`;
                      if (node) cardRefs.current.set(key, node);
                      else cardRefs.current.delete(key);
                    }}
                    className={`h-full w-full rounded-[24px] ${
                      selectedPlaceId === place.id
                        ? "ring-2 ring-brand-primary ring-offset-2 ring-offset-brand-cream"
                        : ""
                    }`}
                  >
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

          {/* Intro — kept at the end of the scrollable list, so the full
              position really fills the screen with content. */}
          <section className="mt-6 px-1 pb-4 pt-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent/90">
              SINGGAH LOKAL
            </p>
            <h1 className="mt-2 max-w-xl text-[28px] font-semibold leading-tight tracking-tight text-brand-ink sm:text-[34px]">
              Jangan hanya datang.
              <br />
              Kenali ceritanya.
            </h1>
          </section>
        </div>
      </section>

      {/* FLOATING "PETA" (2026-10-18): only in the full position, where the
          map is covered and the only way back is this one explicit control. */}
      {sheetPosition === "full" && (
        <button
          type="button"
          onClick={() => setSheetSnap("mid")}
          aria-label="Kembali ke peta"
          className="absolute bottom-6 right-4 z-30 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-brand-primary px-4 text-xs font-bold text-white shadow-[0_8px_20px_rgb(0_0_0/0.22)] transition hover:bg-brand-primary-deep active:scale-[0.98]"
        >
          <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M9 4.5 3.5 6.8v12.2L9 16.7l6 2.3 5.5-2.3V4.5L15 6.8 9 4.5Z" strokeLinejoin="round" />
            <path d="M9 4.5v12.2M15 6.8v12.2" />
          </svg>
          Peta
        </button>
      )}
    </main>
  );
}
