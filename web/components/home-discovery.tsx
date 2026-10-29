"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import CuratedMapTab from "@/components/curated-map-tab";
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
  deactivateCuratedFilter,
  clearCitySearch,
  distanceMeters,
  fallbackSearchArea,
  formatDistance,
  isSameViewport,
  liveDurationLabel,
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
 * GEOLOCATION CAPABILITY — the hydration-safe read (2026-10-25). Whether the
 * browser HAS geolocation never changes at runtime, so there is nothing to
 * subscribe to. The server snapshot is `false` ("a fix may still be coming"),
 * which is also what the client's first render uses, so the server HTML and the
 * first client render agree on every value derived from it. React then reads
 * the client answer and re-renders — never during hydration.
 */
const subscribeToNothing = () => () => {};
const hasNoGeolocation = () => typeof navigator !== "undefined" && !navigator.geolocation;
const hasNoGeolocationOnServer = () => false;

/**
 * GESTURE HELP PANEL (2026-10-21). The automatic pill, its ~3 s timer, and the
 * "already seen" localStorage flag are GONE: the help is a panel that appears
 * only when the "?" control in the map's column is tapped, and stays until the
 * visitor closes it (close button, outside tap, or Esc).
 *
 * The copy is verified against the ACTUAL behaviour of this map:
 *  · one-finger camera pan is locked off on touch-primary devices, and the Home
 *    stage is 100dvh with `overflow-hidden`, so a single finger on the map is
 *    not a page scroll either — it is the results list (at `full`) that
 *    scrolls with one finger. The panel says exactly that instead of the old
 *    "one finger scrolls the page" claim, which was not true on this screen.
 *
 * The panel is INFORMATION ONLY (2026-10-22): it lists the gestures and the
 * grip double-tap reset, and carries no action button. Resetting the tab to its
 * default corner stays where it already was — two taps on the grip.
 */
const GESTURE_HELP_BOTTOM_GAP_PX = 56;
// The panel never grows into the floating logo/menu or the search bar: its top
// edge is kept GESTURE_HELP_TOP_SAFE_PX below the stage's top edge, and its
// height is additionally capped at 60% of the stage so a long panel can never
// take the screen. (It is a modal with its own backdrop, so it may pass over
// the filter chips it obscures; it never covers the header or the search.)
const GESTURE_HELP_TOP_SAFE_PX = 96;
const GESTURE_HELP_MAX_STAGE_RATIO = 0.6;
const GESTURE_HELP_MIN_HEIGHT_PX = 160;

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
 * CARD ENTRY FRAME (2026-10-23). A card animates exactly ONCE, the first time
 * it enters the viewport — never on a scroll back, and never while hidden.
 * The observer is per card and disconnects itself, so the results list does
 * not re-render when a card becomes visible; only that card's frame flips its
 * `data-inview` flag. The stagger is short and capped, and CSS removes the
 * animation entirely under prefers-reduced-motion.
 */
function PlaceCardFrame({ index, children }: { index: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  // Marks time (ms) so CSS can cap the stagger without a second state value.
  const staggerClass = index < 6 ? `singgah-card-delay-${index}` : "";

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver !== "function") {
      // Deferred, not synchronous: a setState directly in the effect body is a
      // cascading render. The fallback still shows the card immediately.
      queueMicrotask(() => setInView(true));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setInView(true);
        observer.disconnect();
      },
      { threshold: 0.01, rootMargin: "0px 0px -6% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-card-inview={inView ? "true" : "false"}
      className={`singgah-card-frame h-full w-full ${staggerClass}`}
    >
      {children}
    </div>
  );
}

/**
 * CARD COVER (2026-10-18) — a 4:5 photo with a skeleton/blur-up and a
 * fail-closed placeholder. The canonical cover wins whenever it loads; the
 * neutral local placeholder (PRESENTATION ONLY — never a Place photo) covers
 * a missing OR failed image, so a card can never render a broken image. The
 * component holds only local image-loading state; no data changes.
 */
function PlaceCardCover({
  name,
  src,
  priority = false,
}: {
  name: string;
  src: string | null | undefined;
  priority?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // NEAR-VIEWPORT GATE (2026-10-23). Every cover used to be a native lazy
  // <img>, but Chrome's lazy threshold on a slow connection reaches thousands
  // of pixels: on the Home sheet it fetched dozens of full-size producer PNGs
  // at once, starving the hydration chunks (measured: hydration at 8.7 s on
  // mobile 4G / 4x CPU). Only the first two cards of a row load eagerly; every
  // other cover mounts its <img> once its cell comes within 400px of the
  // viewport, so scrolling still reveals photos immediately while the first
  // paint stays cheap. Presentation only — the URL, fallback, skeleton, and
  // load-state reconciliation are unchanged.
  const [near, setNear] = useState(priority);
  const hostRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (priority || near || !src || failed) return;
    const node = hostRef.current;
    if (!node || typeof IntersectionObserver !== "function") {
      queueMicrotask(() => setNear(true));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [priority, near, src, failed]);

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
    <span ref={hostRef} className="contents">
      {!loaded && (
        <div
          aria-hidden
          className="absolute inset-0 animate-pulse bg-[#e5dfd1] motion-reduce:animate-none"
        />
      )}
      {near ? (
        /* External producer-supplied image URL; next/image would require host
           allowlisting that producers cannot configure. Same rationale and
           pattern as the Place detail hero. The two leading cards load
           eagerly; every later cover is mounted by the near-viewport gate
           above and still stays a native lazy image. */
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          ref={imgRef}
          src={src}
          alt={`Gambar sampul ${name}`}
          width={600}
          height={600}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "low"}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`h-full w-full object-cover transition-[opacity,filter,transform] duration-500 group-hover:scale-[1.03] motion-reduce:transition-none ${
            loaded ? "scale-100 opacity-100 blur-0" : "scale-105 opacity-0 blur-md"
          }`}
        />
      ) : null}
    </span>
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
  // Manual retry for the LIVE feed's explicit failed state (2026-10-23). The
  // 15 s poll already retries by itself; this lets the user ask immediately.
  // Bumping the nonce re-runs the existing load effect unchanged.
  const [liveRetryNonce, setLiveRetryNonce] = useState(0);
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
  // FIRST-FRAME READINESS (root-cause fix, 2026-10-23): the map must not paint
  // a frame of its own before it knows whether a real location fix is coming.
  // This turns true as soon as the FIRST geolocation attempt settles —
  // success (a fix exists) or failure/timeout/unavailable (there is no fix).
  // It is not a timer: it is the existing request's own callbacks, and the
  // request itself already carries its 8 s timeout.
  // START VALUE IS `false` ON BOTH SIDES (hydration fix, 2026-10-25). The
  // server cannot know whether a fix is coming, so it assumes "still settling"
  // — and the FIRST client render must say the same thing, or the distance
  // tab is rendered pressed in the server HTML and unpressed by the client.
  // React warns about such an attribute mismatch only in development and in
  // production does NOT repair it, so the tab stayed green for good while its
  // own state said otherwise (tests/home-initial-camera.e2e.test.ts scenario
  // (e), a browser with no geolocation at all).
  // (The setter keeps its long-standing name: it is what the geolocation
  // callbacks call once the FIRST attempt has an outcome.)
  const [viewerSettledByFix, setViewerSettled] = useState<boolean>(false);
  // A browser with NO geolocation has nothing to wait for, and that answer is
  // read through useSyncExternalStore: its SERVER snapshot (and therefore the
  // first client render) is `false`, so hydration sees identical markup, and
  // the real answer is applied one commit later. No coordinate is involved and
  // nothing is invented — a browser WITH geolocation keeps waiting for the
  // first real fix exactly as before.
  const noGeolocation = useSyncExternalStore(
    subscribeToNothing,
    hasNoGeolocation,
    hasNoGeolocationOnServer,
  );
  const viewerSettled = viewerSettledByFix || noGeolocation;
  // Explicit "Lokasi Saya" requests bump this nonce so the map re-centers on
  // the latest fix on demand.
  const [locateNonce, setLocateNonce] = useState(0);
  // "LOKASI SAYA" IN-FLIGHT feedback (2026-10-23): the press starts a fresh
  // geolocation request, which can take a moment on a phone. While it runs the
  // filter-row icon shows a small spinner; the control, its aria-label, and
  // the request path are unchanged.
  const [locatePending, setLocatePending] = useState(false);
  // GEOLOCATION PERMISSION (2026-10-26). `null` = the Permissions API is
  // absent, unsupported, or the query failed: the card keeps the previous
  // "Aktifkan lokasi" behavior in that case. The initial value is the same on
  // the server and in the first client render, and the card itself only exists
  // after `viewerSettled`, so this can never cause a hydration mismatch.
  const [geolocationPermission, setGeolocationPermission] = useState<
    "prompt" | "denied" | "granted" | null
  >(null);
  // The denied help is local, expanded on demand, and never persisted.
  const [deniedHelpOpen, setDeniedHelpOpen] = useState(false);
  const grantedRefreshRef = useRef(false);
  const viewerSettledRef = useRef(false);
  const viewerPositionKnownRef = useRef(false);
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
    currentOffset: number;
  } | null>(null);
  const [stageHeight, setStageHeight] = useState(640);
  // HAS THE STAGE BEEN MEASURED? (2026-10-25). `stageHeight` starts from a
  // paint-safe fallback, so `sheetVisiblePx` derived from it is NOT the panel's
  // real height on the first render. The map's catalogue frame reserves that
  // panel, and a first frame may never be decided from a guessed inset (it can
  // only be decided once), so the map is told `null` until the measurement
  // below has run. False on the server and in the first client render, so it
  // introduces no server/client difference.
  // The floating "Tempat Pilihan" tab clamps against the REAL stage width (a
  // window resize or rotation changes where its edges are), so the same
  // measurement that drives the sheet also publishes the width.
  const [stageMeasured, setStageMeasured] = useState(false);
  const [stageWidth, setStageWidth] = useState(0);
  const [sheetPosition, setSheetPosition] = useState<SheetPosition>("mid");
  // `dragOffset` is the SETTLED drag value (start/release only). The live
  // translate is written straight to the sheet element's transform during the
  // gesture, so a drag never re-renders the sheet or its card list per frame
  // (performance requirement, 2026-10-23).
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const sheetRef = useRef<HTMLElement | null>(null);
  // Which card's marker is currently highlighted. `pressedPlaceId` is the
  // transient press feedback from a card; `selectedPlaceId` persists after a
  // marker tap so the chosen pin and its card stay visibly linked.
  const [pressedPlaceId, setPressedPlaceId] = useState<string | null>(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [pendingScrollPlaceId, setPendingScrollPlaceId] = useState<string | null>(null);
  // GESTURE HELP PANEL (2026-10-21): opened ONLY by the "?" control. There is
  // no automatic appearance, no timer, and no persisted "seen" flag any more.
  const [gestureHelpOpen, setGestureHelpOpen] = useState(false);
  const gestureHelpCloseRef = useRef<HTMLButtonElement | null>(null);


  // Measure the stage so the three snap offsets are real pixels. A
  // ResizeObserver covers mobile browser chrome, rotation, and the desktop
  // window; the initial 640 is a paint-safe fallback that the first effect
  // run replaces before the user can interact. The measured height is the
  // REAL visible stage — no artificial floor may push the sheet below the
  // viewport (the old 320px clamp did exactly that on very short stages).
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      setStageHeight(Math.max(0, node.clientHeight));
      setStageWidth(Math.max(0, node.clientWidth));
      // The panel height derived from THIS height is the real one; the map may
      // now use it to reserve the results panel in its first frame.
      setStageMeasured(true);
    };
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

  // GESTURE HELP PANEL LIFECYCLE. The panel is modal-ish: while it is open, the
  // backdrop owns the taps (outside tap closes), Esc closes, and focus moves to
  // the 44px close button and returns to the "?" control afterwards. Nothing
  // here touches the map's gestures, the sheet, the filters, or the camera.
  const closeGestureHelp = useCallback(() => {
    setGestureHelpOpen(false);
    const recall = document.querySelector<HTMLButtonElement>("[data-gesture-hint-recall]");
    recall?.focus();
  }, []);

  const handleShowGestureHint = useCallback(() => {
    setGestureHelpOpen(true);
  }, []);

  useEffect(() => {
    if (!gestureHelpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setGestureHelpOpen(false);
        document.querySelector<HTMLButtonElement>("[data-gesture-hint-recall]")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const timer = window.setTimeout(() => gestureHelpCloseRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(timer);
    };
  }, [gestureHelpOpen]);

  const setSheetSnap = useCallback((next: SheetPosition) => {
    dragRef.current = null;
    setDragOffset(null);
    setSheetPosition(next);
  }, []);

  // FLOATING TAB TOGGLE (2026-10-22): the tab is TWO-WAY now. A tap on the
  // inactive tab enters the layer (LIVE off, exactly as before); a tap on the
  // ACTIVE tab leaves it and the last distance preset is the active filter
  // again — it was never changed by entering curation, so nothing is invented.
  // A drag never toggles (the component resolves tap vs drag itself). The
  // camera is untouched in both directions.
  const handleCuratedToggle = useCallback(() => {
    const next = curatedOnly ? deactivateCuratedFilter() : activateCuratedFilter();
    setCuratedOnly(next.curatedOnly);
    setLiveOnly(next.liveOnly);
  }, [curatedOnly]);

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
        currentOffset: settledOffset,
      };
      setDragOffset(settledOffset);
      setDragging(true);
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
      drag.currentOffset = next;
      // IMPERATIVE, transform-only: React state stays untouched during the
      // gesture, so the 58-card list is not re-rendered on every pointermove.
      // The released snap still goes through React state (endSheetDrag).
      const sheet = sheetRef.current;
      if (sheet) sheet.style.transform = `translateY(${next}px)`;
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
    // The final pointermove already resolved against the same range; using it
    // keeps the release identical to what the user saw, and the release point
    // still corrects a slow drag whose last move lagged.
    const current = Math.min(
      Math.max(drag.startOffset + (releasedY - drag.startY), sheetOffsets.full),
      sheetOffsets.small,
    );
    drag.currentOffset = current;
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
    // Write the settled transform before clearing the gesture flag: React may
    // skip rewriting an unchanged inline style, so the element must already
    // hold the final offset when the drag ends.
    const sheet = sheetRef.current;
    if (sheet) sheet.style.transform = `translateY(${sheetOffsets[next]}px)`;
    setDragOffset(null);
    setDragging(false);
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
  }, [liveOnly, liveRetryNonce]);

  // Real viewer position when permission is granted; no fallback point is
  // ever invented — without a position (or Place coordinates) no distance
  // label is shown (PO: no fake positions). The SAME handler serves the
  // initial mount fix and the explicit "Lokasi Saya" presses: a press always
  // asks the browser for a FRESH position (locate-refresh fix, 2026-09-30).
  const requestViewerPosition = useCallback(() => {
    // No geolocation at all: nothing to wait for (the state above already says
    // so), and no coordinate is invented either way.
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
        setLocatePending(false);
        setViewerSettled(true);
      },
      // Denial/failure is silent: the camera keeps the honest no-origin frame —
      // no fallback coordinate, no default location, no dataset change.
      () => {
        setLocatePending(false);
        setViewerSettled(true);
      },
      { timeout: 8000 },
    );
  }, []);

  // Initial mount fix — the same fresh-position request path.
  useEffect(() => {
    requestViewerPosition();
  }, [requestViewerPosition]);

  // Permission state is READ, never assumed (2026-10-26). `getCurrentPosition`
  // on an already-denied permission does nothing at all in Chrome, so the
  // card's button must not promise a prompt it cannot show. The query is
  // client-only (null until it answers), listens for `change`, and cleans the
  // listener up on unmount.
  useEffect(() => {
    viewerSettledRef.current = viewerSettledByFix;
  }, [viewerSettledByFix]);
  useEffect(() => {
    viewerPositionKnownRef.current = viewerPosition !== null;
  }, [viewerPosition]);
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const applyStatus = (state: PermissionState) => {
      if (state !== "prompt" && state !== "denied" && state !== "granted") return;
      setGeolocationPermission(state);
      // A permission CHANGE closes the denied popover (2026-10-29): its steps
      // describe a state that no longer holds. The pill's own copy follows the
      // new state on the next render.
      setDeniedHelpOpen(false);
    };
    const handleChange = () => {
      if (cancelled || !status) return;
      applyStatus(status.state);
      // Reaching `granted` through the browser's own permission UI must centre
      // the map without a reload. The in-flight mount request already owns the
      // first attempt, so this fires only after that attempt settled with no
      // fix, and only once.
      if (
        status.state === "granted" &&
        viewerSettledRef.current &&
        !viewerPositionKnownRef.current &&
        !grantedRefreshRef.current
      ) {
        grantedRefreshRef.current = true;
        requestViewerPosition();
      }
    };
    let query: Promise<PermissionStatus>;
    try {
      query = navigator.permissions.query({ name: "geolocation" as PermissionName });
    } catch {
      // A throwing query is the same as an unsupported one: keep the previous
      // locate behavior and never fake a status.
      return;
    }
    query
      .then((result) => {
        if (cancelled) return;
        status = result;
        applyStatus(result.state);
        result.addEventListener("change", handleChange);
      })
      .catch(() => {
        // Unknown permission support: keep the previous locate behavior and
        // never fake a status.
      });
    return () => {
      cancelled = true;
      status?.removeEventListener("change", handleChange);
    };
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
    // A browser without geolocation never fires a callback, so the spinner is
    // cleared immediately in that case; otherwise the request's own callbacks
    // clear it on success or honest failure.
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocatePending(false);
    } else {
      setLocatePending(true);
    }
    requestViewerPosition();
  }, [requestViewerPosition, resetViewportLatch]);

  // DENIED POPOVER CONTROL (2026-10-29). The popover belongs to the no-location
  // pill on the map. These refs only handle dismissal and focus — no camera,
  // no permission, and no geolocation call lives here.
  const inviteHelpToggleRef = useRef<HTMLButtonElement | null>(null);
  const invitePopoverRef = useRef<HTMLDivElement | null>(null);
  const invitePopoverCloseRef = useRef<HTMLButtonElement | null>(null);
  const closeDeniedHelp = useCallback(() => {
    setDeniedHelpOpen(false);
    // Focus goes back to the control that opened it, exactly like the gesture
    // help panel does with its own "?" control.
    inviteHelpToggleRef.current?.focus();
  }, []);

  // DISMISSAL (Esc, outside tap) + focus handoff. Pointer listeners are
  // capture-phase so a tap on the map, the sheet, or any chrome closes the
  // popover without those surfaces losing their own behaviour.
  useEffect(() => {
    if (!deniedHelpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeDeniedHelp();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (invitePopoverRef.current?.contains(target)) return;
      if (inviteHelpToggleRef.current?.contains(target)) return;
      closeDeniedHelp();
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    const timer = window.setTimeout(() => invitePopoverCloseRef.current?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.clearTimeout(timer);
    };
  }, [deniedHelpOpen, closeDeniedHelp]);

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

  // NO-LOCATION INVITE (2026-10-25; one board since 2026-10-26). Without a
  // location the map frames the WHOLE catalogue (the documented, permitted
  // no-origin view) and the radius tabs are correctly unpressed — but nothing
  // in words said so, and a world-scale frame with clustered pins reads as
  // "there are only two places". ONE warm card states the rule that is really
  // on screen and offers the real locate action; the old floating chip is
  // gone. It never invents a coordinate, never moves the camera, and never
  // changes a filter or the catalogue.
  //
  // It appears only once the FIRST location attempt has really settled with no
  // location, and only in the plain discovery view (no search in flight or
  // resolved, no curated/LIVE layer). It disappears the moment a fix exists.
  // It is mutually exclusive with the empty-state overlay: both live in the
  // same vertical band, and stacking two notices there would cover the map for
  // nothing.
  const noLocationInviteVisible =
    viewerSettled &&
    activeCenter === null &&
    !searchPending &&
    searchCenter === null &&
    !curatedOnly &&
    !liveOnly &&
    !mapEmptyStateVisible;

  // LOCATION INVITE CARD (2026-10-26). The honest "you are looking at the whole
  // catalogue right now" surface for the no-location catalogue frame — a
  // single, warm card instead of the old floating chip. It never invents a
  // coordinate, never moves the camera, never changes a filter or the
  // catalogue, and it is mutually exclusive with the viewport empty-state
  // overlay (stacking two notices would cover the map for nothing).
  //
  // It appears only in the plain discovery view with no location yet
  // (`noLocationInviteVisible`), only once the FIRST location attempt has settled
  // (`viewerSettled`), and only when the dataset still has Places to pin
  // (`mapPlaces.length > 0`) — when the viewport is genuinely empty the honest
  // empty-state overlay owns that band instead. When a real fix exists the card
  // never renders at all.
  //
  // PLACEMENT (measured 2026-10-26 at 390×844): the pin-free band between the
  // filter row (bottom 158) and the northernmost pin (top 224) is 65px. The
  // required title + one-line subtitle + 44px button cannot fit there without
  // shrinking the copy below a readable size, and every lower band either holds
  // pins or the "Tempat Pilihan" tab. The card therefore uses the documented
  // fallback: it is the FIRST row inside the results panel, above the first
  // Place card. It covers no pin, filter, tab, header, or the panel's top edge,
  // and it moves the first card down by 60px (58px card + 2px gap), within the
  // permitted ~60px.
  //
  // The action is the SAME `handleLocatePress` the filter row uses — no second
  // location path. The button is rendered ONLY when the browser actually has
  // geolocation (`noGeolocation` is the hydration-safe client answer and is
  // `false` on the server exactly like the first client render), so a browser
  // without geolocation sees the honest explainer with no fake action, and the
  // whole card is still absent from the server HTML because `viewerSettled`
  // starts false on both sides.
  const locationInvitePillVisible =
    noLocationInviteVisible &&
    mapPlaces.length > 0;

  // INVITE PILL BAND (2026-10-29) — the pill's measured bottom edge in STAGE
  // pixels, published to the map so the CATALOGUE frame can reserve the strip
  // the pill covers.
  //
  // WHY: the pill floats directly under the filter row, inside the band the
  // catalogue frame previously assumed was free. At 390×844 and 412×915 the
  // fitted pins happen to start below it, but at 360×640 the world frame's
  // northern pins sit at y≈158 while the pill spans 166–218 — 58 of 70 pins
  // then painted underneath a map control. Padding chosen by hand would be a
  // guess for one viewport and an over-reserve for the others, so Home sends
  // the REAL number instead: the stage and the map share one box (the map is
  // `absolute inset-0` of the stage), so `pill.bottom - stage.top` is already
  // in map pixels.
  //
  // `null` = the pill is shown but has not been measured yet. The map then
  // HOLDS its one first frame rather than decide it from a guessed inset,
  // exactly like `bottomInset`. `0` = no pill, so nothing is reserved.
  const invitePillRef = useRef<HTMLDivElement | null>(null);
  const [invitePillBandPx, setInvitePillBandPx] = useState<number | null>(null);
  const invitePillShown = locationInvitePillVisible && sheetPosition !== "full";

  useEffect(() => {
    // No pill on the map: nothing to publish. The prop below already collapses
    // to 0 in that case, so this effect never needs to write state to say so.
    if (!invitePillShown) return;
    const measure = () => {
      const pill = invitePillRef.current;
      const stage = stageRef.current;
      if (!pill || !stage) return;
      setInvitePillBandPx(
        Math.max(0, Math.round(pill.getBoundingClientRect().bottom - stage.getBoundingClientRect().top)),
      );
    };
    measure();
    // The pill's band follows the chrome above it, so it moves with the stage
    // (browser chrome, rotation) — the same events the sheet already listens to.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [invitePillShown, stageHeight]);

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
  const renderPlaceCard = (place: Place, isCurated: boolean, index = 0) => {
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

    // Tone (2026-10-23): curated = thin gold ring, LIVE = a soft bright-red
    // edge. Both are DISPLAY only and come from canonical data (is_curated /
    // the live feed); an ordinary card keeps the neutral hairline.
    const tone = live
      ? "border-live/25 ring-1 ring-live/30"
      : isCurated
        ? "border-[#d8c08f]/70 ring-1 ring-[#c9a45c]/75"
        : "border-black/[0.06]";

    return (
      <PlaceCardFrame index={index}>
      <VisitedLink
        key={place.id}
        href={live ? `/live/${live.sessionId}` : `/places/${place.id}`}
        className={`singgah-place-card group relative flex h-full w-full flex-col overflow-hidden rounded-[22px] border bg-white shadow-[0_1px_1px_rgb(32_35_31/0.04),0_6px_16px_rgb(32_35_31/0.08),0_18px_36px_rgb(32_35_31/0.06)] transition-[transform,box-shadow] duration-150 ease-out hover:shadow-[0_2px_3px_rgb(32_35_31/0.05),0_10px_24px_rgb(32_35_31/0.10),0_24px_44px_rgb(32_35_31/0.07)] motion-safe:active:scale-[0.97] ${tone}`}
        visitedClassName={live ? "ring-2 ring-live/40" : "ring-2 ring-brand-accent/40"}
        onPointerDown={(event) => {
          setPressedPlaceId(place.id);
          // Prefetch on press, not on arrival: the detail route is ready by the
          // time the tap resolves, without preloading every card's page. The
          // link's own resolved href is read here, so the destination is
          // declared in exactly one place.
          const href = event.currentTarget.getAttribute("href");
          if (href) router.prefetch(href);
        }}
        onPointerUp={() => setPressedPlaceId(null)}
        onPointerCancel={() => setPressedPlaceId(null)}
        onPointerLeave={() => setPressedPlaceId(null)}
      >
        {/* CARD COVER (2026-10-23) — a square photo dominates the card, and
            the Place name lives ON the photo over a gradient scrim. The
            bottom pills are kept clear of the name (name stops 32px above
            the photo edge; pills occupy the last ~24px). The canonical cover
            wins; a missing/failed image falls back to the neutral placeholder. */}
        <div className="relative aspect-square w-full shrink-0 overflow-hidden bg-[#ece7db]">
          <PlaceCardCover name={place.name} src={place.coverImageUrl} priority={index < 2} />

          {/* Legibility scrim — sits under all card UI, never over the text. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-[linear-gradient(to_top,rgb(15_18_16/0.82)_0%,rgb(15_18_16/0.45)_45%,rgb(15_18_16/0)_100%)]"
          />

          {/* OVERLAYS: ✦ curated badge top-left, decorative heart top-right,
              real distance bottom-left on a glass pill, pulsing LIVE pill
              bottom-right when a session is active. The distance stays
              fail-closed: it renders ONLY when the real origin and canonical
              Place coordinates both exist — never a fabricated number. */}
          {isCurated && (
            <span
              className="absolute left-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[linear-gradient(135deg,#f0d17e_0%,#c9a45c_55%,#a97a27_100%)] text-[14px] leading-none text-white shadow-[0_2px_8px_rgb(0_0_0/0.30)] ring-1 ring-white/85"
              title="Tempat Pilihan"
            >
              <span aria-hidden>✦</span>
              <span className="sr-only">Tempat Pilihan</span>
            </span>
          )}
          {/* No favorite feature exists in the MVP — the heart is DECORATIVE
              and deliberately does NOT look like a button: no chip, no
              surface, no shadow box. It is a faint watermark on the photo
              (aria-hidden, non-interactive) and must never read as saved state. */}
          <span
            aria-hidden
            className="pointer-events-none absolute right-2 top-2 select-none text-[17px] leading-none text-white/75 drop-shadow-[0_1px_2px_rgb(0_0_0/0.55)]"
          >
            ♡
          </span>

          {/* NAME ON THE PHOTO (name is max 2 lines; category/stars/actions
              stay on the white card body below). */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-2.5 pb-9 pt-8">
            <h3 className="line-clamp-2 text-[13.5px] font-bold leading-snug text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.55)]">
              {place.name}
            </h3>
          </div>

          <div className="absolute inset-x-2 bottom-2 z-10 flex items-end justify-between gap-1">
            {distance ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-white/20 px-1.5 py-1 text-[10px] font-bold leading-none text-white shadow-[0_1px_3px_rgb(0_0_0/0.30)] ring-1 ring-white/40 backdrop-blur-md">
                <span aria-hidden>➤</span>
                {distance}
              </span>
            ) : (
              <span />
            )}
            {live && (
              <button
                type="button"
                onClick={(event) => {
                  stopNestedCardAction(event);
                  router.push(`/live/${live.sessionId}`);
                }}
                className="singgah-live-pulse inline-flex touch-manipulation items-center gap-1 rounded-full bg-live px-2 py-1 text-[10px] font-bold uppercase leading-none tracking-wide text-white transition duration-100 hover:bg-[#c93027] active:scale-95"
                aria-label={`Buka Live di ${place.name}`}
              >
                <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none" />
                LIVE
              </button>
            )}
          </div>
        </div>

        {/* CARD BODY — category, star slots, LIVE status, and the action row.
            Stars come ONLY from the canonical Discovery engine output (stars
            alone — the numeric score never leaves the server); a Place outside
            the engine shows five empty slots. NEVER a rating number or review
            count. The short description stays on the Place detail page. */}
        <div className="flex flex-1 flex-col p-2.5">
          <p className="truncate text-[10px] font-semibold tracking-wide text-brand-ink/55">
            {displayPlaceCategory(place.category)}
          </p>
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

          {/* LIVE STATUS: with an active session the red pulsing pill sits ON
              the photo (above); without one this compact chip says "Belum
              LIVE" and carries the full sentence in its aria-label. Pressing
              it still shows the honest non-live notice; live state itself is
              never invented — the canonical liveByPlaceId feed is the only
              source. */}
          {!live && (
            <button
              type="button"
              aria-pressed={nonLiveNoticePlaceId === place.id}
              onClick={(event) => {
                stopNestedCardAction(event);
                setNonLiveNoticePlaceId((current) => (current === place.id ? null : place.id));
              }}
              className="mt-1 inline-flex w-fit touch-manipulation items-center gap-1 rounded-full bg-live/[0.08] px-1.5 py-0.5 text-[10px] font-bold leading-none text-live transition duration-100 hover:bg-live/[0.14] active:scale-95"
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
              to it. Both are at least 40px tall and give instant press
              feedback (<100ms). */}
          <div className="mt-auto flex items-center gap-1.5 pt-2">
            {directionsUrl ? (
              <button
                type="button"
                onClick={(event) => {
                  stopNestedCardAction(event);
                  window.open(directionsUrl, "_blank", "noopener,noreferrer");
                }}
                className="inline-flex h-10 min-w-0 flex-1 touch-manipulation items-center justify-center gap-1 rounded-[12px] bg-[linear-gradient(135deg,#0a5640_0%,#0e6b4f_100%)] px-2 text-[11px] font-bold text-white shadow-[0_4px_12px_rgb(10_86_64/0.28)] transition duration-100 hover:brightness-110 active:scale-95"
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
      </PlaceCardFrame>
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
            viewerSettled={viewerSettled}
            locateNonce={locateNonce}
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
               the credit is never covered at any snap position — and the
               catalogue frame reserves the same band so no pin is fitted
               underneath the panel. `null` = not measured yet: the frame is
               held rather than decided from the 640px fallback stage. */
            bottomInset={stageMeasured ? sheetVisiblePx : null}
            /* The no-location invite pill's band, measured in the SAME pass
               and used ONLY by the catalogue frame (`applyCatalogueFrame`)
               to keep the northern pins out from under it. 0 when no pill is
               on the map, `null` while it is on the map but unmeasured — the
               frame is held for that measurement, never guessed. */
            catalogueTopInset={invitePillShown ? invitePillBandPx : 0}
            /* EXPLICIT CAMERA REQUEST (product decision, 2026-10-03): the three
               hand-driven camera actions bump this nonce, which releases the
               map's interaction latch so the frame THEY produce stays. Nothing
               else carries a nonce, so no marker refresh, discovery poll,
               viewport report, or fresh geolocation fix can take the camera
               back afterwards. */
            cameraRequestNonce={cameraRequestNonce}
          />
        </div>

        {/* FLOATING "TEMPAT PILIHAN" TAB (2026-10-21). ONE instance, over the
            map, draggable — the old chip in the sheet header is gone and left
            no reserved space behind. The component owns only its own position
            (clamped inside the visible map band, snapped to an edge, persisted
            as side + ratio); the pressed state, the handler, the curated
            dataset, and the LIVE-exclusivity rule are unchanged. It hides
            itself when the sheet reaches `full`. */}
        <CuratedMapTab
          pressed={curatedOnly}
          onToggle={handleCuratedToggle}
          stageWidth={stageWidth}
          stageHeight={stageHeight}
          sheetVisiblePx={sheetVisiblePx}
        />

        {/* Header + auth entry (Masuk / Sign out) + URL-derived active tabs —
            FLOATING over the map (MOCKUP §1/§5). Presentation only: the
            header keeps its logo, nav, and auth behavior verbatim. The "?"
            gesture-help control now lives in this header row (2026-10-23),
            immediately left of the bell; the old map control column is gone. */}
        <SiteNav floating onShowGestureHint={handleShowGestureHint} />

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

              2026-10-23: "Lokasi Saya" joins the row as its LAST 44px cell.
              The split is `auto` for LIVE, three equal radius cells, then the
              icon cell; every control is 44px tall and nothing wraps at 360. */}
          {/* FILTER ROW SURFACE (bug fix, 2026-10-20): the four chips float on
              the map, so the 6px gaps between them used to show whatever sat
              behind — a Place name chip ("…al") could be read through the row.
              The row now paints an OPAQUE cream surface (same brand token as
              the header/sheet) with a hairline ring, so nothing behind it can
              leak between the chips. Zero padding: chip size and the row's
              height are unchanged, so the control column's 190px start still
              matches the chrome. Handlers, order, colours, and semantics are
              untouched. */}
          <div className="pointer-events-auto mt-2.5 grid w-full min-w-0 grid-cols-[auto_repeat(3,minmax(0,1fr))_44px] gap-1.5 rounded-[16px] bg-brand-cream ring-1 ring-black/5">
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
              className={`inline-flex h-11 touch-manipulation items-center justify-center gap-1 whitespace-nowrap rounded-[14px] px-1.5 text-[11px] font-bold tracking-wide shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition duration-100 active:scale-95 sm:px-3 sm:text-xs ${
                liveOnly
                  ? "bg-live text-white"
                  : "border border-live/25 bg-white text-live"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${liveOnly ? "bg-white" : "bg-live"}`} />
              LIVE
            </button>
            {DISTANCE_FILTERS.map((filter) => {
              // PRESSED STATE (bug fix 2026-10-25): a distance tab is a claim
              // about an ANCHORED radius, so it may only read as selected when
              // the preset can actually be framed. With no search center and
              // no device fix `activeCenter` is null and the map keeps the
              // honest catalogue spread (no invented coordinate) — the "1 km"
              // tab used to stay dark-pressed in exactly that state and
              // described a local frame the map was not showing. While the
              // FIRST fix is still in flight (`!viewerSettled`) the tab stays
              // selected, so it never blinks off and back on. The radius,
              // the default, and the camera preset are unchanged.
              const selected =
                distanceFilter === filter && !curatedOnly && (activeCenter !== null || !viewerSettled);
              return (
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
                  aria-pressed={selected}
                  className={`inline-flex h-11 touch-manipulation items-center justify-center whitespace-nowrap rounded-[14px] px-1 text-center text-[11px] font-bold shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition duration-100 active:scale-95 sm:px-3 sm:text-xs ${
                    selected
                      ? "bg-brand-primary text-white"
                      : "border border-black/5 bg-white text-brand-ink/70"
                  }`}
                >
                  {filter}
                </button>
              );
            })}

            {/* "LOKASI SAYA" (2026-10-23): the same handler and the same
                aria-label as the removed map tile, now the LAST control in the
                ONE filter row — a 44px icon cell beside LIVE and the radii.
                It keeps the row's height/surface and never wraps. While the
                fresh geolocation request runs it shows a small spinner; the
                press itself is not blocked or re-routed. */}
            <button
              type="button"
              data-home-locate
              onClick={handleLocatePress}
              title="Lokasi Saya"
              aria-label="Lokasi saya — pusatkan peta ke lokasi aktual"
              aria-busy={locatePending}
              className="relative inline-flex h-11 w-11 touch-manipulation items-center justify-center justify-self-end rounded-[14px] border border-black/5 bg-white text-brand-ink/80 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition duration-100 hover:bg-brand-cream active:scale-95"
            >
              <span aria-hidden className="pointer-events-auto absolute -inset-0.5" />
              {locatePending ? (
                <span
                  aria-hidden
                  className="h-4 w-4 animate-spin rounded-full border-2 border-brand-primary/25 border-t-brand-primary motion-reduce:animate-none"
                />
              ) : (
                <svg aria-hidden viewBox="0 0 24 24" width="20" height="20" fill="none">
                  <circle cx="12" cy="12" r="6.5" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="12" cy="12" r="2.4" fill="#2563eb" />
                  <path
                    d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
          </div>

          {/* LOCATION INVITE PILL (2026-10-29) — the ONE no-location board,
              back ON THE MAP where a map control belongs.

              POSITION (candidate A, measured at 360×640, 390×844 and 412×915):
              8px below the filter row, inside the SAME `px-4` chrome column, so
              its horizontal margins are the filter row's by construction. The
              wrapper stays click-through; only the pill and its button opt
              back into pointer events, exactly like every other floating Home
              surface.

              THE FRAME RESERVES THIS BAND (2026-10-29). The pill owns pixels
              the catalogue fit used to consider free, so Home publishes the
              pill's measured bottom edge (`catalogueTopInset`) and
              `applyCatalogueFrame` pushes the fitted spread clear of it. That
              is what keeps the 360×640 frame honest: the same world span, the
              same 70 pins, none of them painted under the pill.

              SHOWN only in the same no-location state the in-panel card used
              (`locationInvitePillVisible`), and hidden when the sheet reaches
              `full` (the map is not visible then). It is also mutually
              exclusive with the viewport empty-state overlay, which owns the
              same band when it is up.

              COPY is warm, never a warning: a plain title, one short subtitle,
              and the real action. The subtitle is allowed to wrap to two 13px
              lines inside the 44px content box; the title is shortened to
              "Temukan terdekat" so it stays on ONE line even beside the
              longer "Cara mengaktifkan" button at 360px (measured: the column
              is 144px there, and the longer wording wrapped to two lines,
              pushing the subtitle 1px past the pill's lower edge), and
              `min-w-0` keeps the text column from ever running under the
              button. */}
          {invitePillShown && (
            <div ref={invitePillRef} className="relative mt-2 flex">
              <div
                data-home-invite-pill
                role="status"
                aria-live="polite"
                className="singgah-locate-pill pointer-events-auto relative flex h-[52px] w-full min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-1"
              >
                <span aria-hidden data-home-invite-pill-icon className="singgah-locate-pill__icon">
                  <span className="singgah-locate-pill__ripple" />
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                    <path
                      d="M12 21s6.5-5.4 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.6 12 21 12 21Z"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                    <circle cx="12" cy="10" r="2.3" fill="currentColor" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    data-home-invite-title
                    className="text-[11.5px] font-bold leading-[14px] text-brand-ink"
                  >
                    Temukan terdekat
                  </p>
                  <p
                    data-home-invite-subtitle
                    className="text-[9.5px] leading-[13px] text-brand-ink/75"
                  >
                    {noGeolocation
                      ? "Peta ini menampilkan semua tempat."
                      : "Aktifkan lokasi, peta berpusat di sekitarmu"}
                  </p>
                </div>
                {noGeolocation ? null : geolocationPermission === "denied" ? (
                  <button
                    type="button"
                    ref={inviteHelpToggleRef}
                    data-home-invite-help-toggle
                    onClick={() => setDeniedHelpOpen((open) => !open)}
                    aria-expanded={deniedHelpOpen}
                    aria-controls="home-invite-denied-popover"
                    className="singgah-locate-pill__action h-11 shrink-0 touch-manipulation whitespace-nowrap px-3 text-[10px] font-bold"
                  >
                    Cara mengaktifkan
                  </button>
                ) : (
                  <button
                    type="button"
                    data-home-invite-locate
                    onClick={handleLocatePress}
                    aria-busy={locatePending}
                    className="singgah-locate-pill__action h-11 shrink-0 touch-manipulation whitespace-nowrap px-3 text-[10px] font-bold"
                  >
                    {locatePending ? (
                      <span
                        aria-hidden
                        className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white align-[-1px] motion-reduce:animate-none"
                      />
                    ) : (
                      <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        width="12"
                        height="12"
                        fill="none"
                        className="mr-1 inline-block align-[-1px]"
                      >
                        <path
                          d="M12 21s6.5-5.4 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.6 12 21 12 21Z"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                    Aktifkan lokasi
                  </button>
                )}

                {/* DENIED POPOVER (2026-10-29): a small floating dialog, NEVER
                    in the flow, so opening it moves nothing. Chrome shows no
                    permission dialog once geolocation is denied, so this is
                    the honest alternative: the Android steps, a reload action,
                    and a 44px close target. It closes on ×, on an outside tap,
                    on Esc, and automatically when the permission state
                    changes. Focus moves to its close button on open and
                    returns to the toggle on close. */}
                {geolocationPermission === "denied" && deniedHelpOpen ? (
                  <div
                    id="home-invite-denied-popover"
                    ref={invitePopoverRef}
                    role="dialog"
                    aria-label="Cara mengaktifkan lokasi"
                    data-home-invite-help
                    className="pointer-events-auto absolute left-0 right-0 top-full z-[1120] mt-2 rounded-[16px] border border-brand-primary/15 bg-white p-3 shadow-[0_14px_34px_rgb(14_107_79/0.18)]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="pt-2 text-[12px] font-bold leading-4 text-brand-ink">
                        Cara mengaktifkan lokasi
                      </p>
                      <button
                        type="button"
                        ref={invitePopoverCloseRef}
                        onClick={closeDeniedHelp}
                        aria-label="Tutup cara mengaktifkan lokasi"
                        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-brand-ink/70 transition hover:bg-brand-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/50"
                      >
                        <span aria-hidden className="text-[20px] leading-none">×</span>
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-brand-ink/80">
                      Ketuk ikon gembok/pengaturan di address bar &gt; Izin &gt; Lokasi &gt;
                      Izinkan, lalu muat ulang halaman.
                    </p>
                    <button
                      type="button"
                      data-home-invite-reload
                      onClick={() => window.location.reload()}
                      className="mt-2 inline-flex h-11 w-full touch-manipulation items-center justify-center rounded-[12px] border border-brand-primary/25 bg-brand-cream px-3 text-[11px] font-bold text-brand-primary transition duration-100 hover:bg-white active:scale-95"
                    >
                      Muat ulang halaman
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          )}

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

        {/* GESTURE HELP PANEL (2026-10-21). Appears ONLY when the "?" tile in
            the map's control column is tapped — the automatic pill, its ~3 s
            timer, and the "already seen" flag are removed. It stays until the
            visitor closes it: the 44×44 close button, an outside tap (the
            backdrop), or Esc. Focus moves to the close button and returns to
            the "?" afterwards.

            COPY IS VERIFIED, NOT ASSUMED. The map has no compass and no
            one-finger pan (touch-primary lock), and the Home stage is 100dvh
            with `overflow-hidden`, so a single finger on the map neither pans
            nor scrolls the page. What one finger really does on this screen is
            scroll the results list when the sheet is at `full`, so that is
            what the panel says. Two-finger pan and pinch zoom come straight
            from Leaflet's TouchZoom (midpoint = pan, distance = zoom), tapping
            a pin selects its card, and the floating tab is moved by dragging
            it. No gesture is advertised that the map cannot perform.

            LOOK: an OPAQUE white surface (solid, not translucent) with
            brand-ink text — 15.2:1, far above the 4.5:1 requirement — 13px
            body text, a hairline border, and a strong shadow. It is anchored
            56px above the visible sheet seam, so its bottom edge never touches
            the OSM credit (which ends at seam − 22), and its height is capped
            at 60% of the stage with a 96px top clearance, so it never grows
            over the floating logo/menu or the search bar.

            INFORMATION ONLY (2026-10-22): the reset button is gone. The panel
            lists the gestures and the grip double-tap reset; the only reset
            control in the UI is that double tap, and there is nothing else to
            remove. */}
        {gestureHelpOpen && (
          <>
            <button
              type="button"
              aria-label="Tutup petunjuk gestur"
              tabIndex={-1}
              onClick={closeGestureHelp}
              className="absolute inset-0 z-[1200] cursor-default bg-brand-ink/15"
            />
            <div
              data-gesture-help
              role="dialog"
              aria-modal="true"
              aria-labelledby="gesture-help-title"
              className="absolute inset-x-3 z-[1210] mx-auto max-w-sm overflow-y-auto rounded-[18px] border border-black/10 bg-white p-3 text-brand-ink shadow-[0_16px_40px_rgb(0_0_0/0.28)]"
              style={{
                bottom: sheetVisiblePx + GESTURE_HELP_BOTTOM_GAP_PX,
                maxHeight: Math.max(
                  GESTURE_HELP_MIN_HEIGHT_PX,
                  Math.min(
                    stageHeight * GESTURE_HELP_MAX_STAGE_RATIO,
                    stageHeight -
                      sheetVisiblePx -
                      GESTURE_HELP_BOTTOM_GAP_PX -
                      GESTURE_HELP_TOP_SAFE_PX,
                  ),
                ),
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <h2 id="gesture-help-title" className="text-[15px] font-bold leading-tight">
                  Petunjuk gestur peta
                </h2>
                <button
                  ref={gestureHelpCloseRef}
                  type="button"
                  onClick={closeGestureHelp}
                  aria-label="Tutup petunjuk gestur"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-brand-ink/70 transition hover:bg-brand-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/50"
                >
                  <span aria-hidden className="text-[22px] leading-none">×</span>
                </button>
              </div>
              <ul className="mt-1 divide-y divide-black/5 border-t border-black/5">
                <li className="flex items-start gap-2 py-1.5">
                  <span aria-hidden className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" />
                  <p className="text-[13px] leading-snug">
                    <span className="font-bold">Dua jari geser</span> — menggeser peta.
                  </p>
                </li>
                <li className="flex items-start gap-2 py-1.5">
                  <span aria-hidden className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" />
                  <p className="text-[13px] leading-snug">
                    <span className="font-bold">Cubit</span> — memperbesar atau memperkecil peta.
                  </p>
                </li>
                <li className="flex items-start gap-2 py-1.5">
                  <span aria-hidden className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" />
                  <p className="text-[13px] leading-snug">
                    <span className="font-bold">Satu jari</span> — menggulir daftar saat panel penuh.
                  </p>
                </li>
                <li className="flex items-start gap-2 py-1.5">
                  <span aria-hidden className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" />
                  <p className="text-[13px] leading-snug">
                    <span className="font-bold">Ketuk pin</span> — membuka kartu Tempat di daftar.
                  </p>
                </li>
                <li className="flex items-start gap-2 py-1.5">
                  <span aria-hidden className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" />
                  <p className="text-[13px] leading-snug">
                    <span className="font-bold">Geser tab “Tempat Pilihan”</span> — memindahkannya di atas peta.
                  </p>
                </li>
                <li className="flex items-start gap-2 py-1.5">
                  <span aria-hidden className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-primary" />
                  <p className="text-[13px] leading-snug">
                    <span className="font-bold">Ketuk dua kali grip tab</span> — kembali ke posisi awal.
                  </p>
                </li>
              </ul>
            </div>
          </>
        )}

      </section>

      {/* RESULTS BOTTOM SHEET (2026-10-18) — three positions, one surface.
          `small`, `mid`, and `full` are measured snap offsets (see
          sheetOffsets); the sheet is always full-height and translated down,
          so its header stays at the visible top edge in every position. The
          floating "Peta" button is the only exit from `full`. The tab and
          the handle live in the header and therefore travel with the sheet. */}
      <section
        ref={sheetRef}
        className={`singgah-sheet absolute inset-x-0 bottom-0 z-20 flex h-full flex-col rounded-t-[24px] bg-brand-cream shadow-[0_-8px_24px_rgb(0_0_0/0.08)] ${
          dragging ? "singgah-sheet-dragging" : ""
        }`}
        style={{ transform: `translateY(${sheetOffset}px)` }}
        aria-labelledby="place-results-heading"
      >
        {/* COMPACT HANDLE BAND (2026-10-19; tightened 2026-10-23): 44px —
            exactly the drag target, so the first card can start 16px below the
            grip instead of losing a whole extra band. The handle, its keyboard
            controls, the snap math (`SHEET_HEADER_PX`), and the one drag
            target are unchanged. */}
        <div className="relative flex h-11 shrink-0 items-center justify-center">
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

          {/* THE "TEMPAT PILIHAN" TAB LEFT THIS BAND (2026-10-21). It is a
              floating, draggable control over the map now (CuratedMapTab), so
              the 48px header holds ONLY the centred drag handle — no absolute
              sibling, no reserved left column, and no leftover gap. The
              handler, `aria-pressed`, the curated activation rule, and the
              LIVE exclusivity rule are unchanged. */}
        </div>

        {/* Only the LIST scrolls, and only in `full`; in small/mid the same
            content is clipped by the sheet so a swipe can never fight the
            sheet drag or the map. */}
        <div
          ref={sheetListRef}
          className={`mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col px-4 ${
            sheetPosition === "full"
              ? "overflow-y-auto overscroll-contain pb-24 pt-4"
              : "overflow-hidden pb-8 pt-4"
          }`}
        >
        {/* LOCATION INVITE BOARD — MOVED ONTO THE MAP (2026-10-29). The
            in-panel card (`data-home-invite-card`) is GONE: it was a MAP
            CONTROL rendered inside the results list, so it pushed the first
            Place card down and read as if it belonged to the list. The board
            now lives over the map as the compact pill below (see the filter
            row), and the first Place card is back at its baseline offset. */}

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

        {/* LIVE feed FIRST LOAD skeleton (2026-10-23): the tab is active and
            nothing has settled yet. Two neutral card placeholders keep the
            sheet from flashing empty, and they disappear the moment the real
            list (or the honest empty/failed state) renders. */}
        {liveOnly && liveItems.length === 0 && liveFeedStatus === "loading" && (
          <div aria-hidden className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4">
            {[0, 1].map((slot) => (
              <div
                key={slot}
                className="h-[290px] animate-pulse rounded-[22px] bg-white/70 ring-1 ring-black/5 motion-reduce:animate-none"
              />
            ))}
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
            <button
              type="button"
              onClick={() => {
                // Re-run the existing feed effect with one visible retry; the
                // last good data (if any) is still never discarded.
                setLiveFeedStatus("loading");
                setLiveRetryNonce((nonce) => nonce + 1);
              }}
              className="mt-4 inline-flex h-10 touch-manipulation items-center justify-center rounded-[12px] border border-live/30 bg-white px-4 text-[12px] font-bold text-live transition duration-100 hover:bg-live/[0.06] active:scale-95"
            >
              Coba lagi
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
              {/* The "Tempat Pilihan" caption is intentionally GONE (2026-10-23):
                  it repeated the floating tab and pushed the first card down.
                  The row id, order, cards, and data are unchanged. */}
              <div
                id={CURATED_RESULTS_ANCHOR_ID}
                className="-mx-4 grid grid-cols-2 items-stretch gap-x-3 gap-y-4 px-4 pb-1"
              >
                {curatedListed.map((place, index) => (
                  <div
                    key={place.id}
                    id={`place-card-curated-${place.id}`}
                    data-place-card-id={place.id}
                    ref={(node) => {
                      const key = `curated:${place.id}`;
                      if (node) cardRefs.current.set(key, node);
                      else cardRefs.current.delete(key);
                    }}
                    className={`singgah-place-cell h-full w-full rounded-[22px] ${
                      selectedPlaceId === place.id
                        ? "ring-2 ring-brand-primary ring-offset-2 ring-offset-brand-cream"
                        : ""
                    }`}
                  >
                    {renderPlaceCard(place, place.isCurated, index)}
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
                {discoveryRowPlaces.map((place, index) => (
                  <div
                    key={place.id}
                    id={`place-card-discovery-${place.id}`}
                    data-place-card-id={place.id}
                    ref={(node) => {
                      const key = `discovery:${place.id}`;
                      if (node) cardRefs.current.set(key, node);
                      else cardRefs.current.delete(key);
                    }}
                    className={`singgah-place-cell h-full w-full rounded-[22px] ${
                      selectedPlaceId === place.id
                        ? "ring-2 ring-brand-primary ring-offset-2 ring-offset-brand-cream"
                        : ""
                    }`}
                  >
                    {renderPlaceCard(place, curatedIdSet.has(place.id), index)}
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
