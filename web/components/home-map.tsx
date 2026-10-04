"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CircleMarker, LayerGroup, Map as LeafletMap, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  FIT_SINGLE_PLACE_ZOOM,
  boundsOfPoints,
  collectGeoPoints,
  isSameViewport,
  resolveCameraFitPadding,
  selectAlwaysLabelledPlaceIds,
  shouldReportViewportStatus,
  type MapViewport,
} from "@/lib/live/ui";

/**
 * Real interactive map for Home discovery.
 * - Tiles: OpenStreetMap (attribution required). ONE basemap — no
 *   terrain/satellite/layer selector; +/- zoom, scroll and touch zoom are
 *   all functional. One-finger camera control (touch drag + double-tap) is
 *   LOCKED OFF on touch-primary devices (PO 2026-09-27): a single finger
 *   never pans/zooms the map — two-finger pan + pinch zoom stay available.
 * - Markers come ONLY from canonical Place lat/lng — a Place without
 *   coordinates never receives a marker (fail-closed, no invented position).
 * - Current Location is the map's anchor: the real browser geolocation fix
 *   becomes the camera center. There is NO fallback viewport and NO invented
 *   user position — before the first real fix the map starts on the neutral
 *   world overview (fitWorld), never on a stand-in country view.
 * - Camera authority (PO, 2026-09-29 + 2026-09-30 map-coverage fix and
 *   coverage decision): ONE deterministic radius mechanism — every mode
 *   (1 km / 5 km / 10 km+ / "Tempat Pilihan") is a radius preset and the
 *   camera moves INSTANTLY (setView, animate: false) so the frame covers
 *   exactly that radius around the real Current Location. Distance-tab radii
 *   stay strictly ordered (1 < 5 < 10 km) and a preset zoom is derived from
 *   the radius alone — NEVER from the marker set. A newly chosen preset
 *   always applies (deterministic refocus); manual pan/zoom wins between
 *   choices. The explicit "Lokasi Saya" action is NOT a preset: since
 *   2026-10-03 it frames the viewer's LOCAL AREA (see the LOCAL AREA block
 *   below), so it is never bounded by a radius;
 *     · marker refreshes/API polling never move the camera;
 *     · the viewport is ALWAYS bounded to the chosen radius preset — the old
 *       one-shot marker fitBounds (which zoomed to a world view when no
 *       Current Location existed yet and the demo marker set was spread out)
 *       was REMOVED. With no real fix the map keeps the neutral world
 *       overview and NEVER auto-fits to the marker list.
 * - AUTO-FIT VIEWPORT (product decision, 2026-10-03 — supersedes the curated
 *   10 km frame and the search-center-only recenter, and ONLY those two
 *   rules): the camera frames the SPREAD of the relevant Places' canonical
 *   coordinates instead of a fixed radius around one point.
 *     · the bounds dataset is a SEPARATE dataset from the rendered markers:
 *       the same canonical content filter WITHOUT the viewport gate, so
 *       viewport -> markers -> camera can never become a circular dependency;
 *     · the fit happens ONLY on an EXPLICIT refocus trigger (choosing
 *       "Tempat Pilihan", or a new search answer). Marker refreshes,
 *       discovery re-polls, and every viewport report can never re-frame the
 *       camera, so there is no recenter loop and no repeated zoom;
 *     · manual pan/zoom still wins in between: no viewport or marker update
 *       can ever take the camera back;
 *     · ZERO Places with valid coordinates never invents a coordinate — a
 *       search keeps its geocoding center and the curated tab keeps the
 *       current view;
 *     · ONE Place is FOCUSED on its canonical coordinate (a degenerate box
 *       would otherwise jump to the map's maximum zoom);
 *     · the fit reserves the floating chrome (header, search, filter) and the
 *       map controls, so the framed Places are never hidden underneath them;
 *     · the distance tabs keep their ordered radius presets (unchanged).
 * - LOCAL AREA + EXPLICIT REQUEST LATCH (product decision, 2026-10-03 —
 *   correction of the 2026-10-03 auto-fit): the bounds datasets are bounded to
 *   the viewer's LOCAL AREA, and the frame an explicit request produces STAYS.
 *   · LOCAL AREA: the fit dataset is resolved against the REAL fix by
 *     `resolveLocalAreaCoverage` — the anchor Place's own canonical ISO
 *     country + subdivision when it has one, otherwise an adaptive
 *     data-derived separation. There is no fixed 10 km cap, no arbitrary
 *     replacement radius, and no fallback to the whole dataset: a "Lokasi
 *     Saya" or "Tempat Pilihan" focus can never frame West Java and Riyadh in
 *     one fit again.
 *   · LATCH: every explicit user request (a distance tab, "Tempat Pilihan",
 *     "Lokasi Saya", a new search answer) records the camera it produced.
 *     Marker refreshes, discovery polls, viewport reports, and the next
 *     geolocation fix are then BLOCKED from taking it back — which is what
 *     removed the last "the frame jumps again a moment later" behaviour
 *     without a single timer or debounce.
 * - "LOKASI SAYA" = LOCAL-AREA REFOCUS (product decision, 2026-10-03): the
 *   explicit "My Location" press FRAMES the viewer's local Place distribution
 *   (plus their own coordinate) instead of only recentring at the previous
 *   zoom. It reuses the same `fitCamera`, the same local-area dataset, and the
 *   same explicit-request latch as the curated focus — there is no second
 *   camera system. Empty local area → focus the user's own coordinate; denied
 *   geolocation → no camera move at all; manual pan/zoom survives until the
 *   next explicit request.
 * - MAP SCALE: the corner scale bar and its `onScaleChange` measurement were
 *   REMOVED on 2026-10-04 with the indicator itself (the approved Home/Map
 *   mockup shows no distance scale). Nothing else reads it: zoom, attribution,
 *   camera, and coverage never depended on the scale.
 * - One container = one Leaflet instance: the container is claimed
 *   synchronously before the async import resolves (Strict Mode double-mount
 *   and fast route transitions cannot initialize twice), and teardown fully
 *   removes listeners, layers, and the map itself. invalidateSize() runs on
 *   init and window resize so mobile remounts never leave stacked tiles.
 * - Marker system (PO, 2026-09-29; per-Place CURATED/NORMAL treatment,
 *   2026-09-30): ONE compact teardrop base pin for every Place with exactly
 *   TWO Place treatments — NORMAL (brown) and CURATED (secondary green + ✦
 *   accent, from the canonical `places.is_curated` flag of that Place) — plus
 *   the LIVE treatment (live red, pulsing core, small LIVE chip, top
 *   z-priority, navigates to /live/[sessionId]). The "Tempat Pilihan" map
 *   shows curated AND ordinary Places at once, so the treatment is per Place,
 *   never per mode. No emoji glyphs, no always-on name labels — names appear
 *   in hover/focus tooltips so dense maps stay readable.
 */
export type HomeMapPlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /**
   * Canonical curated membership for THIS Place (`places.is_curated`). The
   * "Tempat Pilihan" map shows curated AND ordinary Places at once, so the
   * CURATED vs NORMAL marker treatment is per Place, never per mode. It is
   * read-only display data: it never adds a Place to a layer, a list, or
   * Discovery.
   */
  isCurated?: boolean;
};

export type HomeMapLive = {
  sessionId: string;
  processTitle?: string;
};

/** Real device position from browser geolocation — never a default point. */
export type HomeMapViewer = { lat: number; lng: number; accuracy?: number };

type HomeMapProps = {
  places: HomeMapPlace[];
  liveByPlaceId: Map<string, HomeMapLive>;
  viewerPosition: HomeMapViewer | null;
  locateNonce: number;
  onRequestLocate: () => void;
  /**
   * THE camera preset (PO, 2026-09-29; coverage unified 2026-09-30): when
   * set, the camera moves instantly so the frame covers exactly this radius
   * around the real Current Location — through ONE deterministic radiusZoom
   * mechanism shared by every mode (1 km / 5 km / 10 km+ tabs, "Tempat
   * Pilihan", and the "Lokasi Saya" recenter, all 10 km at the widest). The
   * radius only ever changes the frame, never the marker set: it is decided
   * upstream and never filters Places.
   *
   * SUPERSEDED FOR THE CURATED LAYER AND FOR THE SCALE READOUT (2026-10-03):
   * an explicit "Tempat Pilihan" choice is framed by `fitCamera` over the
   * viewer's LOCAL AREA, and this value no longer describes that frame. It
   * remains the camera preset the three distance tabs still own, and it is
   * never rendered as a map scale.
   */
  cameraRadiusMeters?: number | null;
  /**
   * ACTIVE SEARCH CENTER (bug fix 2026-10-02): the ONE coordinate the radius
   * preset frames — the searched city while a city search is active, otherwise
   * the real Current Location fix.
   *
   * The preset used to hardcode `viewerPosition`, so choosing 1 km → 5 km
   * while a city was searched dragged the camera back to the device and left
   * the searched center owning nothing. This prop is resolved upstream by
   * `resolveActiveCenter`, so this component never has to re-derive the mode.
   * null = no usable center at all, in which case NO camera move is invented.
   *
   * WHAT null MEANS ON SCREEN (bug fix, 2026-10-03): geolocation denied and
   * nothing searched leaves the camera exactly where it is — on the neutral
   * world overview created at init — because there is no coordinate that could
   * honestly centre a radius (AGENTS.md: never fabricate one). The caller
   * therefore also stops naming a radius "dari lokasi Anda" in that state, so
   * a world frame is never presented as a local one.
   */
  cameraCenter?: { lat: number; lng: number } | null;
  /**
   * LOCATION SEARCH center (PO 2026-10-02): the canonical coordinate pair
   * returned by the server-only geocoder. When it changes, the camera moves
   * there INSTANTLY (animate: false — same rule as the preset mechanism, no
   * fly-through) at a zoom that frames the search window. It carries geometry
   * only: it never adds a marker, never touches the Current Location pin or
   * its pulse, never reads or writes the distance tabs, and never changes
   * the dataset. null = no search answer yet, so the camera is untouched.
   */
  searchCenter?: { lat: number; lng: number } | null;
  /** Bumped by the caller once a NEW search answer arrived (never per keystroke). */
  searchNonce?: number;
  /**
   * AUTO-FIT BOUNDS DATASET (product decision, 2026-10-03) for the curated
   * layer: the relevant Places' canonical coordinates, gathered WITHOUT the
   * viewport gate. It is deliberately NOT the `places` prop — that one is
   * narrowed to the visible viewport, which is what keeps the camera from
   * chasing the markers it just moved. Same canonical data, same membership,
   * one step earlier in the pipeline.
   */
  fitPlaces?: HomeMapPlace[];
  /**
   * EXPLICIT refocus trigger for the auto-fit camera (product decision,
   * 2026-10-03): bumped ONLY when the user chooses "Tempat Pilihan". Nothing
   * else — no marker refresh, no discovery poll, no viewport report — can
   * re-frame the camera.
   */
  fitNonce?: number;
  /**
   * AUTO-FIT BOUNDS DATASET for a location search (product decision,
   * 2026-10-03): the canonical coordinates of the Places relevant to the
   * SEARCHED region. A new answer frames their spread instead of only
   * centering on the geocoder's city point. An empty set keeps the search
   * center — no coordinate is ever invented.
   */
  searchFitPlaces?: HomeMapPlace[];
  /**
   * LOCAL-AREA BOUNDS DATASET for an explicit "Lokasi Saya" (product
   * decision, 2026-10-03): the eligible Places of the ACTIVE layer that belong
   * to the viewer's own local area, resolved UPSTREAM from the user's real
   * coordinates and canonical geography (country + administrative subdivision,
   * with the documented proximity fallback).
   *
   * It is deliberately a SEPARATE prop from `fitPlaces`, even though both hold
   * the same local-area set: the two refits have different TRIGGERS (the
   * curated choice vs. the locate press) and different fallbacks, and keeping
   * them apart is what lets one dataset serve both without either camera path
   * being able to fire for the other's reason.
   */
  locateFitPlaces?: HomeMapPlace[];
  /**
   * Short one-shot focus pulse on the EXISTING Current Location pin when a
   * preset applies: the camera itself moves instantly with NO animation, so
   * entering "Tempat Pilihan" is made visually obvious by this short pin
   * pulse instead. No new marker, no marker redesign, no map animation;
   * prefers-reduced-motion disables it.
   */
  pulsePinOnPresetChange?: boolean;
  /**
   * Viewport-aware empty state (PO, 2026-09-30): the map reports whether at
   * least one Place marker currently sits inside the REAL Leaflet viewport —
   * evaluated once when the map is ready and re-evaluated on every FINISHED
   * move/zoom (moveend/zoomend). Marker dataset, marker design, and camera
   * behavior are NOT affected by this callback.
   */
  onViewportHasPlaces?: (hasPlaces: boolean) => void;
  /**
   * The REAL visible viewport, reported as plain bounds (PO,
   * 2026-10-01: the viewport — not a radius preset — is the geographic
   * coverage source for the markers and the Home Place rows). Reported on
   * readiness, on every FINISHED move/zoom, and on resize; deduped by exact
   * bounds equality so a settled viewport never re-renders the list. It
   * reports VIEWPORT state only: it never changes eligibility, membership,
   * the marker dataset, or the camera.
   */
  onViewportChange?: (viewport: MapViewport) => void;
  /**
   * EXPLICIT CAMERA REQUEST (product decision, 2026-10-03): bumped by the
   * caller whenever the USER asks the camera to move — choosing a distance
   * tab, choosing "Tempat Pilihan", or pressing "Lokasi Saya".
   *
   * It is the release of the manual-interaction latch. Every automatic camera
   * move (a radius preset re-applied after a fresh geolocation fix, a marker
   * refresh, a viewport report) is blocked while the latch is held, so the
   * frame the user asked for is the frame that stays. Only a new explicit
   * request can take the camera back, and nothing else can — that is what makes
   * a "recenter loop" impossible without any debounce or timer.
   */
  cameraRequestNonce?: number;
};

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

const BRAND_BROWN = "var(--brand-accent)";
const BRAND_LIVE = "var(--live)";
// Current Location marker color (MOCKUP §6, 2026-10-01): the user marker is
// BLUE with a soft glow, per the latest approved mockup. Visual only — the
// geolocation fix, the camera, and the Place-marker model are untouched, and
// blue stays exclusive to the user pin (Place pins remain brown/green/red).
const BRAND_PIN = "#2563eb";
// Marker system colors (PO, 2026-09-29): ONE base Place pin (brand brown)
// with per-mode treatments — "Tempat Pilihan" uses the secondary brand
// green, LIVE uses the live red, and the Current Location disc is the BLUE
// user marker (MOCKUP §6) so it never looks like a Place.
const BRAND_SECONDARY = "var(--brand-secondary)";
/**
 * Name of the dedicated Current Location pane (see the map init effect). It
 * exists so the user disc always paints ABOVE every Place pin, whatever the
 * latitude-based z-ordering of DOM markers would do.
 */
const USER_PANE = "singgah-user-pane";

/**
 * ONE-SHOT locate feedback window (PO, 2026-09-30): how long the Current
 * Location pin pulses after "Lokasi Saya". It must cover the whole short
 * camera transition (LOCATE_TRANSITION_MS) so the pulse is still running
 * while the map settles, and it must stay BOUNDED — one short burst, never
 * a permanent animation. Mirrors .singgah-locate-pulse in globals.css.
 */
const LOCATE_PULSE_MS = 900;
/**
 * The short, light camera transition that "Lokasi Saya" used to ease through
 * (PO, 2026-09-30). RETIRED 2026-10-03: the action now frames the local Place
 * distribution, and a zoom-out across a whole neighbourhood is not something
 * to animate — every camera apply in this component is instant and the one-shot
 * pin pulse is the feedback. Nothing here may reintroduce a duration.
 */
/**
 * CLOSEST USABLE FOCUS for "Lokasi Saya" (product decision, 2026-10-01).
 * Used ONLY when the viewer's own coordinate is the whole frame (no eligible
 * local Place to fit); the bounds fit below does not need it.
 */
const LOCATE_MIN_ZOOM = 15;
/**
 * CLOSEST the "Lokasi Saya" FIT may land (product decision, 2026-10-03).
 *
 * The fit frames the local Place distribution plus the viewer's own position,
 * so a single Place standing next to the user would produce a box a few tens
 * of metres wide — a street-level frame that reads as a broken zoom rather
 * than as "your neighbourhood". This is a ZOOM LEVEL, never a coverage radius:
 * it can only widen the frame, never narrow it, so no eligible Place is ever
 * pushed out of view by it.
 */
const LOCATE_FIT_MAX_ZOOM = 16;
/**
 * Identity of the VIEWER'S OWN point inside the locate fit dataset.
 *
 * It is geometry only — the real geolocation fix, already the map's anchor,
 * never a fabricated coordinate and never a Place row. It is what keeps the
 * "Lokasi Saya" frame oriented around the user when the local Places are
 * spread away from them.
 */
const VIEWER_FIT_POINT_ID = "__viewer_position__";
/**
 * LOCATION SEARCH focus floor (PO 2026-10-02): a search recenter follows the
 * SAME never-zoom-out rule as "Lokasi Saya" — it keeps the viewer's current
 * close zoom and only ever raises a farther one, so a city-level result is
 * centered without forcing an unexpectedly wide frame. There is no pulse and
 * no transition: the geocoder already told us exactly where to look.
 */
const SEARCH_MIN_ZOOM = 13;
/**
 * SMOOTH VIEW-DISTANCE TRANSITION (product decision, 2026-10-04). Switching
 * between view distances — the 1/5/10 km tabs, "Tempat Pilihan", "Lokasi
 * Saya", and a new search answer — eases the camera instead of snapping, so
 * the change reads as one calm movement rather than a jump. ONE helper so
 * every camera apply shares the SAME duration and easing curve; there is no
 * per-path timing. Accessibility: `prefers-reduced-motion` falls back to the
 * instant apply, so nothing animates for users who asked for still motion.
 */
function cameraAnimationOptions(): { animate: boolean; duration?: number; easeLinearity?: number } {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  if (reduced) return { animate: false };
  return { animate: true, duration: 0.6, easeLinearity: 0.25 };
}
/**
 * COMFORTABLE DENSITY CAP for the "Tempat Pilihan" focus (product decision,
 * 2026-10-04): all curated Places are framed together, and this ZOOM LEVEL
 * stops a tightly clustered selection from becoming a street-level frame. It
 * is a zoom ceiling, never a coverage radius: it can only widen the frame, so
 * it can never push a curated Place out of view.
 */
const CURATED_FIT_MAX_ZOOM = 13;
/**
 * SURROUNDING-AREA radius for the Current Location pin (product decision,
 * 2026-10-04): the user marker shows a soft, translucent disc around it, so
 * "Lokasi Saya" reads as "the area around me" rather than a bare dot. It is
 * a DISPLAY ring only — never a coverage radius, never a camera bound, and it
 * never filters or admits a Place. The real device accuracy circle, when the
 * browser reports one, is drawn independently on top of it.
 */
const LOCATE_AREA_RADIUS_M = 350;
/**
 * PIN LABEL DENSITY (2026-10-05). The compact chip under every pin is
 * unchanged, but a dense cluster used to paint one chip per pin on top of one
 * another, so in exactly the area the user cares about NO name was readable.
 * The declutter is a DETERMINISTIC priority budget (`selectAlwaysLabelledPlaceIds`)
 * computed once per marker rebuild — no `getBoundingClientRect`, no per-frame
 * or per-render layout pass, nothing added on pan/zoom — and the chips past the
 * budget stay in the DOM, revealed by the existing hover/keyboard-focus state.
 * Nothing is filtered, nothing is removed, and labels are never ALL hidden:
 * the budget always keeps at least one.
 */
const PIN_LABEL_ON_DEMAND_ATTRIBUTE = "data-label-state";

/**
 * PIN LABEL PLACEMENT — the ONE anchor every chip has used since Place names
 * were added: the compact chip centred UNDER its pin. Presentation only — the
 * chip keeps its class, its truncation, its full text, and its accessible name.
 *
 * The alternative anchors ("right" / "left" / "above" collision placement)
 * were introduced for the "Semua Tempat" tab and were REMOVED with it on
 * 2026-10-04: that tab no longer exists, so the anchor picker had no caller
 * and every remaining frame renders this single placement.
 */
const PIN_LABEL_ANCHOR_STYLE =
  "position:absolute;left:50%;top:100%;transform:translate(-50%,1px);";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export default function HomeMap({
  places,
  liveByPlaceId,
  viewerPosition,
  locateNonce,
  onRequestLocate,
  cameraRadiusMeters = null,
  cameraCenter = null,
  searchCenter = null,
  searchNonce = 0,
  fitPlaces = [],
  fitNonce = 0,
  searchFitPlaces = [],
  locateFitPlaces = [],
  pulsePinOnPresetChange = false,
  onViewportHasPlaces,
  onViewportChange,
  cameraRequestNonce = 0,
}: HomeMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  // The single OSM basemap — removed explicitly in teardown so no orphaned
  // tile layer can ever survive a remount (repeated/stale-tile guard).
  const tileLayerRef = useRef<TileLayer | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const userLayerRef = useRef<LayerGroup | null>(null);
  // Short pin focus feedback (PO 2026-09-30): refs for
  // the Current Location pin element, the one-shot pulse timer, and the
  // pulse window (so a pin rebuild during an active pulse re-applies it).
  const userPinRef = useRef<CircleMarker | null>(null);
  const locatePulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locatePulseUntilRef = useRef(0);
  // Camera authority refs. After a real user pan/zoom automatic refreshes
  // never move the map again; programmatic instant moves set
  // programmaticMoveRef so they are not mistaken for user interaction.
  const userInteractedRef = useRef(false);
  const programmaticMoveRef = useRef(false);
  const locatePendingRef = useRef(false);
  const lastLocateNonceRef = useRef(0);
  // Latest fix readable from async callbacks (preset-flight guard).
  const viewerPositionRef = useRef<HomeMapViewer | null>(null);
  // Two-finger interaction observer (touch-primary only) — detached in teardown.
  const touchMoveObserverRef = useRef<((event: TouchEvent) => void) | null>(null);
  // Viewport-aware empty state (PO, 2026-09-30): refs for the reported
  // callback, the canonical marker-position mirror, and the last reported
  // status (dedup — no re-render storms during gestures).
  const onViewportHasPlacesRef = useRef<((hasPlaces: boolean) => void) | null>(null);
  const markerPositionsRef = useRef<[number, number][]>([]);
  // `null` = NOTHING REPORTED YET (bug fix 2026-10-01). It used to start at
  // `false`, which made the first evaluation a no-op whenever the viewport
  // really was empty — the Home overlay then stayed hidden until the user
  // panned or zoomed. The first report must always happen, INCLUDING an
  // empty viewport; afterwards the value dedupes as before.
  const lastViewportHasPlacesRef = useRef<boolean | null>(null);
  // REAL viewport reporting (product decision, 2026-10-01): the map owns the
  // ONE geographic coverage source. The latest callback and the last
  // reported bounds live in refs so the long-lived moveend/zoomend/resize
  // listeners never capture a stale render closure and never report the
  // same bounds twice (no re-render storms).
  const onViewportChangeRef = useRef<((viewport: MapViewport) => void) | null>(null);
  const lastViewportRef = useRef<MapViewport | null>(null);
  // EXPLICIT CAMERA REQUEST latch (product decision, 2026-10-03): the last
  // request nonce this map has already honoured. A newer one releases the
  // manual-interaction latch so the user's own choice applies; an equal one
  // changes nothing, so no automatic refresh can re-arm the camera.
  const lastRequestNonceRef = useRef(cameraRequestNonce);
  // Last measured Leaflet size — the container-resize guard (a change that
  // does not actually change the measured size must not re-report).
  const measuredSizeRef = useRef<{ x: number; y: number } | null>(null);
  // AUTO-FIT camera refs (product decision, 2026-10-03). The bounds datasets
  // are mirrored into refs so the fit effects can be keyed on their NONCE
  // ALONE: a new Place array (discovery re-poll, search refresh, viewport
  // narrowing upstream) can therefore never re-run a fit that already
  // happened, which is what makes a recenter loop impossible. lastFitNonceRef
  // guarantees the fit applies exactly once per explicit trigger.
  const fitPlacesRef = useRef<HomeMapPlace[]>(fitPlaces);
  const searchFitPlacesRef = useRef<HomeMapPlace[]>(searchFitPlaces);
  // Same mirroring rule for the "Lokasi Saya" local-area dataset. It is
  // refreshed in an effect declared BEFORE the locate effect below, so a press
  // always reads the CURRENT dataset — never the one from a previous fix or a
  // previous search.
  const locateFitPlacesRef = useRef<HomeMapPlace[]>(locateFitPlaces);
  const lastFitNonceRef = useRef(0);

  const router = useRouter();
  const [ready, setReady] = useState(false);

  const viewerPositionKey = viewerPosition ? `${viewerPosition.lat},${viewerPosition.lng}` : "";

  // Every render, the LATEST callback is mirrored into the ref (in an effect,
  // never during render) so the map's long-lived moveend/zoomend listeners
  // can never capture a stale closure.
  useEffect(() => {
    onViewportHasPlacesRef.current = onViewportHasPlaces ?? null;
  }, [onViewportHasPlaces]);

  useEffect(() => {
    onViewportChangeRef.current = onViewportChange ?? null;
  }, [onViewportChange]);

  useEffect(() => {
    fitPlacesRef.current = fitPlaces;
  }, [fitPlaces]);

  useEffect(() => {
    searchFitPlacesRef.current = searchFitPlaces;
  }, [searchFitPlaces]);

  useEffect(() => {
    locateFitPlacesRef.current = locateFitPlaces;
  }, [locateFitPlaces]);

  // Stable signature of the marker set (place ids + live session ids), so
  // the marker effect only re-runs when the set actually changes (the
  // discovery feed re-polls every 15 s).
  //
  // The LABEL RULE is part of that signature on purpose: switching between the
  // curated frame and "Semua Tempat" changes no marker identity at all (the
  // same Place can appear in both tabs), so without this the chips would keep
  // the previous tab's paint state and "Semua Tempat" would open with names
  // hidden. It is one extra token, so nothing else re-runs.
  const markerKey = useMemo(
    () =>
      places
        .map(
          (place) =>
            `${place.id}:${place.isCurated === true ? "c" : "-"}:${liveByPlaceId.get(place.id)?.sessionId ?? ""}`,
        )
        .join("|"),
    [places, liveByPlaceId],
  );

  // Viewport-aware empty state (PO, 2026-09-30): ONE shared re-evaluation
  // over the CANONICAL marker positions (never over an invented dataset).
  // Reports whether at least one Place currently sits inside the REAL
  // Leaflet viewport. The effect below keeps the callback ref fresh so the
  // map's long-lived listeners can never capture a stale render closure.
  const evaluateViewportStatus = useCallback(() => {
    const map = mapRef.current;
    const report = onViewportHasPlacesRef.current;
    if (!map || !report) return;
    const bounds = map.getBounds();
    const hasPlaces = markerPositionsRef.current.some(([lat, lng]) =>
      bounds.contains([lat, lng]),
    );
    // The FIRST evaluation always reports (even when empty — see the sentinel
    // above); after that, ONLY on change, which dedupes the burst of
    // moveend/zoomend events a gesture/flight can emit and prevents re-render
    // storms.
    if (shouldReportViewportStatus(lastViewportHasPlacesRef.current, hasPlaces)) {
      lastViewportHasPlacesRef.current = hasPlaces;
      report(hasPlaces);
    }
  }, []);

  // REAL viewport report (product decision, 2026-10-01): the visible area,
  // read from Leaflet itself and flattened into plain bounds. It is the ONLY
  // geographic coverage source the Home rows consume, so markers and lists can
  // never disagree with what the user can see. Deduped by exact bounds
  // equality — Leaflet fires moveend/zoomend in bursts, and a settled
  // viewport must never re-render the Home rows.
  const reportViewportBounds = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBounds();
    const viewport: MapViewport = {
      north: bounds.getNorth(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      west: bounds.getWest(),
    };
    const report = onViewportChangeRef.current;
    if (!report) return;
    if (isSameViewport(lastViewportRef.current, viewport)) return;
    lastViewportRef.current = viewport;
    report(viewport);
  }, []);

  // Short pin focus feedback (PO, 2026-09-30 instant-camera rule): the
  // camera applies INSTANTLY (no flyTo, no duration/easing anywhere), so the
  // ONLY motion feedback is this one-shot pulse on the EXISTING Current
  // Location pin — on every "Lokasi Saya" recenter and on entering the
  // "Tempat Pilihan" preset. The pin is Leaflet SVG (a Path accepts a
  // className): the temporary class (globals.css .singgah-locate-pulse,
  // disabled by prefers-reduced-motion) is added for ONE animation cycle and
  // removed again. No new marker, no marker-system change, no map animation.
  const triggerLocatePulse = useCallback(() => {
    // The feedback window is recorded FIRST, even when the pin element does
    // not exist yet: the Current Location pin is built asynchronously, so a
    // locate request that lands before it exists must NOT lose the pulse —
    // the window stays PENDING and the user-marker effect applies it to the
    // new element as soon as it is created.
    locatePulseUntilRef.current = Date.now() + LOCATE_PULSE_MS;
    if (locatePulseTimerRef.current !== null) clearTimeout(locatePulseTimerRef.current);
    const element = userPinRef.current?.getElement?.();
    if (!element) return;
    element.classList.remove("singgah-locate-pulse");
    // Force a reflow so a pulse restarted mid-cycle runs completely.
    void element.getBoundingClientRect();
    element.classList.add("singgah-locate-pulse");
    locatePulseTimerRef.current = setTimeout(() => {
      locatePulseTimerRef.current = null;
      userPinRef.current?.getElement?.()?.classList.remove("singgah-locate-pulse");
    }, LOCATE_PULSE_MS);
  }, []);

  // Jump to the real user position WITHOUT changing the frame width —
  // INSTANTLY (setView with animate: false; no duration/easing/animation).
  // Used ONLY by the no-preset path (cameraRadiusMeters === null, which no
  // Home mode reaches): the one-shot fallback focus. The "Lokasi Saya"
  // recenter uses the same zoom-preserving rule (see the locate effect
  // below); only the preset anchor derives a zoom from a radius. The pin
  // pulse marks the focus point either way.
  const focusUser = useCallback(
    (map: LeafletMap, position: { lat: number; lng: number }) => {
      programmaticMoveRef.current = true;
      map.setView([position.lat, position.lng], Math.max(map.getZoom(), 15), {
        ...cameraAnimationOptions(),
      });
      triggerLocatePulse();
    },
    [triggerLocatePulse],
  );

  // THE preset mechanism (PO, 2026-09-29): the zoom that makes the frame
  // cover a given radius around Current Location. Purely a function of the
  // radius (never of the current zoom) — strictly ordered radii produce
  // strictly ordered, deterministic zoom levels for every tab.
  const radiusZoom = useCallback(
    async (map: LeafletMap, position: { lat: number; lng: number }, radiusMeters: number) => {
      const L = (await import("leaflet")).default;
      // getBoundsZoom needs a non-degenerate box; project the radius into
      // degrees (lat degrees are exact, lng degrees widen toward the poles).
      const latDelta = radiusMeters / 111_320;
      const lngDelta = radiusMeters / (111_320 * Math.max(0.1, Math.cos((position.lat * Math.PI) / 180)));
      const bounds = L.latLngBounds(
        [position.lat - latDelta, position.lng - lngDelta],
        [position.lat + latDelta, position.lng + lngDelta],
      );
      return map.getBoundsZoom(bounds) - 0.5; // keep the radius ring inside the frame
    },
    [],
  );

  // Preset refocus: re-derives the camera from the preset radius around the
  // real Current Location on EVERY preset choice — switching tabs (1 km /
  // 5 km / 10 km+) or entering "Tempat Pilihan" always applies the new
  // preset deterministically, unless the user has interacted since the last
  // choice (their pan/zoom wins until the next explicit preset choice).
  const lastRadiusRef = useRef<number | null>(null);
  // One-shot latch for the null-preset focus (no Home mode reaches it; safety
  // only) so the automatic focus can never repeat after a user interaction.
  const autoFocusedRef = useRef(false);

  useEffect(() => {
    viewerPositionRef.current = viewerPosition;
  }, [viewerPosition]);

  // Create the map once. Leaflet touches window, so it is imported
  // dynamically inside the effect (safe for SSR of this client component).
  // The container is marked synchronously BEFORE the async import resolves,
  // so a second setup (React Strict Mode double-mount, fast route
  // transition, refresh) can never initialize a second Leaflet instance on
  // the same container — and a cancelled setup releases the mark.
  useEffect(() => {
    let cancelled = false;
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;

    const invalidate = (map: LeafletMap) => {
      map.invalidateSize();
    };

    (async () => {
      const container = containerRef.current;
      if (!container || container.dataset.singgahMap) return;
      container.dataset.singgahMap = "initializing";

      const L = (await import("leaflet")).default;
      if (cancelled) {
        container.dataset.singgahMap = "";
        return;
      }
      if (!containerRef.current || mapRef.current) {
        container.dataset.singgahMap = "";
        return;
      }

      // Gesture lock (PO task 2026-09-27): ONE finger must never pan or zoom
      // the Home map — single-finger input stays available for page/UI
      // interaction outside the map. Leaflet's Draggable is the ONLY
      // single-finger camera control (its _onDown explicitly finishes on
      // non-1-touch), and double-tap is the only one-finger ZOOM gesture —
      // so on touch-primary devices both are disabled on this map instance.
      // Two-finger gestures stay fully functional: TouchZoom performs BOTH
      // pinch zoom AND two-finger pan (map._move from the pinch midpoint)
      // independent of the Draggable handler. Pointer-fine devices (desktop
      // mouse/trackpad) keep every existing behavior untouched.
      const touchPrimary = window.matchMedia?.("(pointer: coarse)")?.matches === true;

      const map = L.map(container, {
        // Neutral world overview until the real Current Location fix defines
        // the viewport. There is deliberately NO country fallback, NO invented
        // position, and NO marker fitBounds — the viewport is owned by the
        // real fix + the bounded radius preset, nothing else.
        zoomControl: false,
        scrollWheelZoom: true,
        attributionControl: true,
        // 1-finger lock: no touch drag, no double-tap zoom (touch-primary
        // only — desktop keeps drag, double-click, and wheel zoom as-is).
        dragging: !touchPrimary,
        doubleClickZoom: !touchPrimary,
        // Single-world map: panning never repeats the world or shows wrapped
        // copies (the "Indonesia layer" / duplicate-tiles artifact on Android
        // Chrome comes from Leaflet's default world-copy jumping + wrapped
        // tile loads). noWrap lives on the TILE layer below; maxBounds pins
        // the camera to the single world.
        worldCopyJump: false,
        minZoom: 2,
        // Root cause of the "map slides out of its frame" bug (PO report,
        // 2026-09-25): the previous bounds used ±Infinity longitudes. Leaflet
        // projects ±180 lng to ±Infinity pixels at every zoom, so the drag
        // limit math (_getBoundsOffset / viscousLimit) produced NaN/Infinity
        // and NEVER clamped the pane — one strong drag moved the map pane an
        // unbounded distance inside the container, exposing the background
        // behind the tiles. Real pan clamping needs FINITE bounds. ±180 with
        // viscosity 1.0 clamps the pane at the world edge (drag is limited
        // with the proper Leaflet mechanism, drag itself stays ON).
        maxBounds: [
          [-85, -180],
          [85, 180],
        ],
        maxBoundsViscosity: 1.0,
      });
      map.fitWorld();
      // EXACTLY ONE tile layer for the map's whole lifetime — a removed
      // instance can never leave an orphaned OSM layer (stale/repeated tiles
      // after remount, refresh, or drag on Android Chrome).
      const tileLayer = L.tileLayer(OSM_TILE_URL, {
        attribution: OSM_ATTRIBUTION,
        maxZoom: 19,
        noWrap: true,
        // Match the map's FINITE maxBounds: tiles stop at the ±180 world
        // edge instead of requesting wrapped/empty tiles outside it.
        bounds: [
          [-85, -180],
          [85, 180],
        ],
      }).addTo(map);
      tileLayerRef.current = tileLayer;

      // Functional interactions: drag/touch pan, +/- zoom buttons, scroll
      // and touch zoom (single basemap, no layer selector). The control is a
      // real Leaflet zoom control (touch + keyboard operable); the titles are
      // its accessible names.
      L.control.zoom({ position: "topright", zoomInTitle: "Perbesar peta", zoomOutTitle: "Perkecil peta" }).addTo(map);

      map.on("moveend", () => {
        programmaticMoveRef.current = false;
        // Viewport-aware empty state (PO, 2026-09-30): every FINISHED move —
        // two-finger pan, pinch zoom, zoom control, or a programmatic preset
        // flight — re-evaluates whether a Place sits in the viewport.
        // Leaflet fires moveend once per gesture, never continuously during
        // it, so updates stay cheap. zoomend arrives right after moveend for
        // zooms (idempotent: it reports only on change).
        evaluateViewportStatus();
        // The visible area itself is the coverage source for the Home rows
        // (product decision, 2026-10-01), so it is reported on exactly the
        // same finished-move events — never per frame.
        reportViewportBounds();
      });
      map.on("zoomend", evaluateViewportStatus);
      map.on("zoomend", reportViewportBounds);
      map.on("dragstart", () => {
        if (!programmaticMoveRef.current) userInteractedRef.current = true;
      });
      map.on("zoomstart", () => {
        if (!programmaticMoveRef.current) userInteractedRef.current = true;
      });
      // Two-finger gestures bypass dragstart/zoomstart (TouchZoom moves the
      // camera directly), so keep the camera-authority guard honest for the
      // gestures that REMAIN enabled — observe (passively, never preventing
      // anything) two-finger touches as real user interaction.
      if (touchPrimary) {
        const onTwoFingerMove = (event: TouchEvent) => {
          if (event.touches.length === 2) userInteractedRef.current = true;
        };
        container.addEventListener("touchmove", onTwoFingerMove, { passive: true });
        touchMoveObserverRef.current = onTwoFingerMove;
      }

      mapRef.current = map;
      // USER MARKER PANE (product decision, 2026-10-01): Place pins are DOM
      // markers in Leaflet's markerPane (z-index 600) while a CircleMarker is
      // SVG in overlayPane (400), so the user disc used to paint UNDER every
      // Place pin — the exact opposite of "the user marker must be clearly
      // visible above the Place markers". A dedicated pane at 640 keeps it
      // above every Place pin (600) and still below tooltips (650).
      const userPane = map.createPane(USER_PANE);
      userPane.style.zIndex = "640";
      markerLayerRef.current = L.layerGroup().addTo(map);
      userLayerRef.current = L.layerGroup().addTo(map);
      container.dataset.singgahMap = "ready";
      setReady(true);

      // Mobile layout timing: panes can measure before the section settles.
      // invalidateSize() after init (and on every window resize) prevents
      // visually stacked tiles/layers on phones.
      invalidateTimer = setTimeout(() => {
        if (mapRef.current === map) {
          invalidate(map);
          // INITIAL STATE (PO, 2026-09-30): the first status is computed as
          // soon as the map is ready — the user never has to move the map
          // first. invalidateSize settled the real viewport size; any marker
          // set built before readiness is re-evaluated here too.
          evaluateViewportStatus();
          // ...and the FIRST real viewport is reported here as well, so the
          // rows follow the visible area without waiting for a gesture.
          reportViewportBounds();
        }
      }, 150);
    })();

    const onWindowResize = () => {
      const map = mapRef.current;
      if (map) invalidate(map);
      // Resize changes the visible viewport without any map move —
      // re-evaluate (evaluateViewportStatus is stable, [] deps).
      evaluateViewportStatus();
      reportViewportBounds();
    };

    // CONTAINER RESIZE (2026-10-01): the Home map box is sized in vh/clamp,
    // so it can change size WITHOUT a window resize event — the mobile
    // browser chrome collapsing, an orientation change, or the on-screen
    // keyboard. Leaflet only re-measures on window resize, which would leave
    // the reported viewport (and therefore the Place rows) narrowed to an area
    // that is no longer on screen. A ResizeObserver re-measures and re-reports
    // whenever the CONTAINER itself changes, and only when the measured size
    // really changed. It adds no global listener and no polling.
    const resizeObserver =
      typeof ResizeObserver === "function" && containerRef.current
        ? new ResizeObserver(() => {
            const map = mapRef.current;
            if (!map) return;
            const size = map.getSize();
            const previous = measuredSizeRef.current;
            if (previous && previous.x === size.x && previous.y === size.y) return;
            measuredSizeRef.current = { x: size.x, y: size.y };
            invalidate(map);
            evaluateViewportStatus();
            reportViewportBounds();
          })
        : null;
    if (resizeObserver && containerRef.current) resizeObserver.observe(containerRef.current);
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      setReady(false);
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      if (locatePulseTimerRef.current !== null) clearTimeout(locatePulseTimerRef.current);
      locatePulseTimerRef.current = null;
      window.removeEventListener("resize", onWindowResize);
      resizeObserver?.disconnect();
      const container = containerRef.current;
      if (container) {
        container.dataset.singgahMap = "";
        const observer = touchMoveObserverRef.current;
        if (observer) container.removeEventListener("touchmove", observer);
      }
      touchMoveObserverRef.current = null;
      markerLayerRef.current?.remove();
      markerLayerRef.current = null;
      userLayerRef.current?.remove();
      userLayerRef.current = null;
      tileLayerRef.current?.remove();
      tileLayerRef.current = null;
      const map = mapRef.current;
      if (map) {
        map.off();
        map.remove();
      }
      mapRef.current = null;
    };
    // Mount-once map lifecycle: evaluateViewportStatus is stable ([] deps)
    // and every dependency it reads lives in refs — no re-init is wanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AUTO-FIT MECHANISM (product decision, 2026-10-03) — ONE function, shared by
  // the curated refocus and the location search, so both obey the same three
  // rules and there is never a second, subtly different camera path.
  //
  // It frames the SPREAD of the given canonical coordinates, never the markers
  // currently rendered:
  //  - 0 valid Places  -> returns false and moves NOTHING. An empty dataset can
  //    never become a coordinate, a default city, or a world view; the caller
  //    keeps its search center or the current viewport.
  //  - 1 valid Place   -> focused directly on that coordinate. `fitBounds` on a
  //    degenerate box would jump to the map's maximum zoom, which is not
  //    "a suitable zoom for one Place".
  //  - many Places     -> fitBounds with the reserved chrome/control padding,
  //    so the whole spread is visible in the AREA the user can really see.
  //
  // The move is INSTANT (`animate: false`), like every other camera apply here,
  // and it flags itself as programmatic so its own moveend/zoomend events can
  // never be mistaken for a user interaction (which would latch the camera).
  //
  // `maxZoom` is the ONLY per-path difference, and it is a zoom level rather
  // than a radius: it lets a caller stop an extremely tight box from becoming
  // a street-level frame. It can only widen the frame, so it can never drop a
  // candidate Place out of it.
  const fitCamera = useCallback(
    async (map: LeafletMap, candidatePlaces: HomeMapPlace[], maxZoom?: number) => {
      const L = (await import("leaflet")).default;
      if (mapRef.current !== map) return false;
      const points = collectGeoPoints(candidatePlaces);
      const bounds = boundsOfPoints(points);
      // No Place with canonical coordinates: the camera stays exactly where it
      // is. Nothing is invented here (AGENTS.md: no fabricated data).
      if (!bounds) return false;
      programmaticMoveRef.current = true;
      if (points.length === 1) {
        const singleZoom =
          typeof maxZoom === "number" ? Math.min(FIT_SINGLE_PLACE_ZOOM, maxZoom) : FIT_SINGLE_PLACE_ZOOM;
        map.setView([points[0].lat, points[0].lng], singleZoom, { ...cameraAnimationOptions() });
        return true;
      }
      // Padding reserves the floating header/search/filter chrome, the
      // right-hand control column, and the coverage box + scale, clamped to the
      // real container size so a short mobile map still has room to fit into.
      const padding = resolveCameraFitPadding(map.getSize());
      const corners: [[number, number], [number, number]] = [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ];
      map.fitBounds(L.latLngBounds(corners), {
        paddingTopLeft: padding.paddingTopLeft,
        paddingBottomRight: padding.paddingBottomRight,
        ...(typeof maxZoom === "number" ? { maxZoom } : {}),
        ...cameraAnimationOptions(),
      });
      return true;
    },
    [],
  );

  // Camera anchor: the ACTIVE SEARCH CENTER is the map's center — the searched
  // city while a city search is active, otherwise the real Current Location fix
  // (bug fix 2026-10-02; previously the preset hardcoded the device fix, so a
  // radius change during a city search silently discarded the searched center).
  // EVERY mode is a cameraRadiusMeters preset (distance tabs from
  // CAMERA_PRESET_RADIUS_M, "Tempat Pilihan" = curated 50 km): a new preset
  // ALWAYS refocuses deterministically through the one radiusZoom mechanism —
  // zoom is derived from the preset radius, never from the current zoom, and
  // the frame is ALWAYS bounded to that preset (never fit to the marker list).
  // Manual pan/zoom wins between choices (the EXPLICIT CAMERA REQUEST below
  // is what re-arms it). Without a preset (no Home mode produces this) the
  // one-shot focus on the real fix keeps its behavior; markers never drive the
  // viewport.
  //
  // NO ORIGIN (bug fix, 2026-10-03): with `cameraCenter` null — geolocation
  // denied and nothing searched — there is nothing to centre, so the preset is
  // NOT applied and the map keeps its current (neutral world) frame. Nothing is
  // invented here, and the caller stops naming a radius in that state.
  //
  // The center is derived once per run and re-derived when it changes, so the
  // effect re-arms for a new city exactly as it does for a fresh device fix.
  const cameraCenterKey = cameraCenter ? `${cameraCenter.lat},${cameraCenter.lng}` : "";
  useEffect(() => {
    const map = mapRef.current;
    // EXPLICIT CAMERA REQUEST (product decision, 2026-10-03): a NEW request
    // number releases the manual-interaction latch, so the frame the user just
    // asked for applies even when they panned a moment ago. It is recorded
    // FIRST, before every early return, so a request can never be "replayed"
    // later by an unrelated readiness or fix change.
    const requestChanged = cameraRequestNonce !== lastRequestNonceRef.current;
    lastRequestNonceRef.current = cameraRequestNonce;
    if (requestChanged) userInteractedRef.current = false;
    // AUTO-FIT REFOCUS (product decision, 2026-10-03) — checked FIRST and
    // BEFORE the anchor guard, because a fit carries its OWN canonical
    // coordinates and must therefore still work when geolocation was denied
    // and no anchor exists at all.
    const fitChanged = fitNonce > 0 && fitNonce !== lastFitNonceRef.current;
    if (fitChanged) {
      if (!ready || !map) return;
      // Marked as applied even when the dataset is still empty: a later
      // viewport report or marker refresh must never re-frame the camera for
      // the SAME choice (that would be the recenter loop).
      lastFitNonceRef.current = fitNonce;
      lastRadiusRef.current = cameraRadiusMeters;
      // The camera is now exactly where the user's choice put it, so it is
      // LATCHED again: the radius preset must not take it back when the next
      // geolocation fix arrives. Only a new explicit request releases it.
      userInteractedRef.current = true;
      void (async () => {
        const applied = await fitCamera(map, fitPlacesRef.current, CURATED_FIT_MAX_ZOOM);
        // The instant-camera rule (PO 2026-09-30) is unchanged: the transition
        // into the layer is confirmed by the one-shot Current Location pin
        // pulse, never by an animated camera move.
        if (applied && pulsePinOnPresetChange) triggerLocatePulse();
      })();
      return;
    }
    const anchor = cameraCenter ?? viewerPosition;
    if (!ready || !map || !anchor) return;
    // CAMERA AUTHORITY (bug fix, 2026-10-03). Once the frame belongs to the
    // user — a preset applied, a curated/locate focus, or a real pan/zoom —
    // NOTHING may move it except a new explicit request, which released the
    // latch at the top of this effect.
    //
    // The guard used to be narrower: `userInteracted && lastRadius ===
    // cameraRadiusMeters`, so ANY change of the radius value re-armed the
    // preset. "Tempat Pilihan" passes CURATED_CAMERA_RADIUS_M, and leaving
    // that layer through the LIVE toggle changes the radius back to the
    // distance tab without any camera request at all — which silently snapped
    // the map to a 1 km device frame and threw away a manual pan. Every
    // explicit tab choice already bumps `cameraRequestNonce` above, so the
    // deterministic refocus rule is unchanged; only the accidental
    // reframing is gone.
    if (userInteractedRef.current) return;

    const radiusChanged = lastRadiusRef.current !== cameraRadiusMeters;
    lastRadiusRef.current = cameraRadiusMeters;

    let cancelled = false;
    (async () => {
      // ONE preset path for every mode (PO, 2026-09-29): distance tabs and
      // "Tempat Pilihan" all apply through the same radiusZoom preset — a
      // new preset always applies (deterministic), manual pan/zoom in
      // between is respected (latch re-arms only on the new preset choice).
      // The application is INSTANT (setView, animate: false): no duration,
      // no easing, no animation — entering "Tempat Pilihan" (or any preset
      // change) is made visually obvious by the one-shot pin focus pulse
      // instead (instant-camera rule, PO 2026-09-30).
      if (cameraRadiusMeters !== null) {
        const zoom = await radiusZoom(map, anchor, cameraRadiusMeters);
        if (cancelled || mapRef.current !== map || userInteractedRef.current) return;
        programmaticMoveRef.current = true;
        map.setView([anchor.lat, anchor.lng], Math.max(2, zoom), { ...cameraAnimationOptions() });
        // THE FRAME STAYS (bug fix, 2026-10-03): the preset that was just
        // applied is now the camera's state, so a later geolocation fix, a
        // marker refresh, or a mode switch cannot re-derive it. Without this
        // the preset re-applied on every fix, and each application silently
        // undid a pan the user had made in between.
        userInteractedRef.current = true;
        if (radiusChanged && pulsePinOnPresetChange) triggerLocatePulse();
        return;
      }
      // No preset at all (cameraRadiusMeters === null): focus the actual
      // location once — no radius re-zoom, and marker refreshes never
      // re-center afterwards.
      if (!autoFocusedRef.current) {
        autoFocusedRef.current = true;
        focusUser(map, anchor);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, viewerPositionKey, cameraCenterKey, cameraRadiusMeters, viewerPosition, cameraCenter, fitNonce, cameraRequestNonce, focusUser, radiusZoom, fitCamera, pulsePinOnPresetChange, triggerLocatePulse]);

  // Render/update the user marker from the real geolocation fix. Camera
  // decisions live in the anchor effect above.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !viewerPosition) return;
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      const layer = userLayerRef.current;
      if (cancelled || mapRef.current !== map || !layer) return;

      layer.clearLayers();
      // SURROUNDING AREA (product decision, 2026-10-04): a soft, translucent
      // disc around the Current Location pin so "Lokasi Saya" reads as "the
      // area around me" instead of a bare dot. Display only — it is never a
      // coverage radius, never a camera bound, and it never admits a Place.
      L.circle([viewerPosition.lat, viewerPosition.lng], {
        pane: USER_PANE,
        radius: LOCATE_AREA_RADIUS_M,
        color: BRAND_PIN,
        weight: 1,
        opacity: 0.4,
        fillColor: BRAND_PIN,
        fillOpacity: 0.1,
        interactive: false,
        className: "singgah-locate-area",
      }).addTo(layer);
      const accuracy = viewerPosition.accuracy ?? 0;
      if (Number.isFinite(accuracy) && accuracy > 0) {
        L.circle([viewerPosition.lat, viewerPosition.lng], {
          pane: USER_PANE,
          radius: accuracy,
          color: BRAND_PIN,
          weight: 1,
          fillColor: BRAND_PIN,
          fillOpacity: 0.12,
        }).addTo(layer);
      }
      // Current Location marker — unmistakably the USER's position and never
      // mistakable for a Place pin (MOCKUP §6, 2026-10-01): a white-core dot
      // in a BLUE disc with a white ring, glowing via the locate-pulse color
      // in globals.css. Place pins are teardrops (brown/green); LIVE pins are
      // the red badge. No click behavior — it is not a navigation target.
      userPinRef.current = L.circleMarker([viewerPosition.lat, viewerPosition.lng], {
        pane: USER_PANE,
        radius: 13,
        color: "#ffffff",
        weight: 4,
        fillColor: BRAND_PIN,
        fillOpacity: 1,
      }).addTo(layer);
      // A rebuild inside an active pulse window (a fresh fix committed by a
      // locate press) re-applies the one-shot feedback to the NEW element.
      if (Date.now() < locatePulseUntilRef.current) triggerLocatePulse();
      L.circleMarker([viewerPosition.lat, viewerPosition.lng], {
        pane: USER_PANE,
        radius: 5,
        color: BRAND_PIN,
        weight: 0,
        fillColor: "#ffffff",
        fillOpacity: 1,
        interactive: false,
      })
        .addTo(layer)
        .bindTooltip("Lokasi Anda", { direction: "top", offset: [0, -14] });
    })();

    return () => {
      cancelled = true;
      // The layer is cleared on rebuild/teardown — the pin element is gone.
      userPinRef.current = null;
    };
  }, [ready, viewerPosition, triggerLocatePulse]);

  // "Lokasi Saya": explicit REFOCUS on the viewer's LOCAL AREA (product decision,
  // 2026-10-03). The press is the user asking "where am I and what is around
  // me", so the camera now FRAMES that distribution instead of only recentring
  // on the fix at the previous zoom — which is what left the map at a broad,
  // inappropriate level with distant Places on screen.
  //
  // What it does NOT do:
  //  · no fixed 10 km radius and no radius at all: the bounds come from the
  //    LOCAL-AREA dataset (`locateFitPlaces`), already bounded upstream by the
  //    viewer's own canonical geography, plus the viewer's own coordinate;
  //  · no global fit, and no distant Place substituted: with NO eligible local
  //    Place the camera focuses the user's OWN coordinate and stops there;
  //  · no continuous auto-recentering: the fit is keyed on `locateNonce` alone
  //    and the frame is LATCHED, so marker refreshes, viewport reports,
  //    discovery polls, and a later geolocation fix cannot take it back. Only
  //    a new explicit request (a tab, "Tempat Pilihan", or another press)
  //    releases the latch;
  //  · manual pan/zoom therefore survives until the user asks again;
  //  · no invented coordinate: with no fix yet the request stays PENDING and
  //    resolves on the first real one; a denied or failed fix leaves the camera
  //    exactly where it is.
  //
  // It is INSTANT (animate: false), like every other camera apply here, and the
  // one-shot pin pulse is the feedback — so a zoom-out across a whole
  // neighbourhood never becomes a long animated flight.
  useEffect(() => {
    const map = mapRef.current;
    if (!locateNonce || lastLocateNonceRef.current === locateNonce) return;
    lastLocateNonceRef.current = locateNonce;
    locatePendingRef.current = true;
    if (!ready || !map || !viewerPosition) return;
    locatePendingRef.current = false;
    // LATCHED (product decision, 2026-10-03): the camera is now exactly where
    // this explicit request put it. A fresh geolocation fix that lands right
    // after the press must NOT re-frame the map to a radius preset the user
    // did not ask for — that was the "Lokasi Saya jumps to another frame"
    // behaviour. Only a new explicit request (a tab, "Tempat Pilihan", or
    // another "Lokasi Saya") releases the latch again.
    userInteractedRef.current = true;
    let cancelled = false;
    (async () => {
      if (cancelled || mapRef.current !== map) return;
      // Feedback FIRST: the pulse runs while the frame applies and stays
      // pending if the pin element does not exist yet.
      triggerLocatePulse();
      // The viewer's own position joins the local Places so the frame stays
      // oriented around the user — geometry only, never a Place row. It is
      // added ONLY when there are local Places to frame: with none, the user's
      // coordinate IS the whole frame, which the fallback below handles
      // without forcing a zoom-in.
      const localPlaces = locateFitPlacesRef.current;
      const candidates: HomeMapPlace[] =
        localPlaces.length > 0
          ? [
              ...localPlaces,
              {
                id: VIEWER_FIT_POINT_ID,
                name: "Lokasi Anda",
                latitude: viewerPosition.lat,
                longitude: viewerPosition.lng,
              },
            ]
          : [];
      const applied = await fitCamera(map, candidates, LOCATE_FIT_MAX_ZOOM);
      if (cancelled || mapRef.current !== map || applied) return;
      // NO eligible local Place at all: focus the user's own coordinate at the
      // close floor and stop. Never a distant Place, never the whole dataset,
      // never an invented point.
      programmaticMoveRef.current = true;
      map.setView([viewerPosition.lat, viewerPosition.lng], Math.max(map.getZoom(), LOCATE_MIN_ZOOM), {
        ...cameraAnimationOptions(),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera]);

  // LOCATION SEARCH camera (PO 2026-10-02; AUTO-FIT extended by the product
  // decision of 2026-10-03): the moment a NEW server geocode answer arrives,
  // the camera frames the SPREAD of the Places relevant to the searched region,
  // instantially and with the chrome/control padding reserved — it no longer
  // only centers on the geocoder's city point, so Places scattered across the
  // searched region are all visible instead of the ones near the midpoint.
  //
  // It stays keyed on `searchNonce`, not on the coordinates or on the Place
  // array, so a repeated search for the SAME place re-frames exactly once and
  // a later marker/viewport update can never loop the camera. Manual pan/zoom
  // in between is respected: nothing but a new answer re-frames it.
  // Clearing the query (searchCenter → null) never moves the camera. No
  // marker is added, the Current Location pin and its pulse are untouched, and
  // no radius/filter state is read or written here.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !searchCenter || !searchNonce) return;
    let cancelled = false;
    // Same latch as every other explicit request: the searched frame STAYS, and
    // a later geolocation fix cannot yank the map back to the device radius.
    userInteractedRef.current = true;
    (async () => {
      const applied = await fitCamera(map, searchFitPlacesRef.current);
      if (cancelled || applied) return;
      // NO Place with canonical coordinates in the searched region: keep the
      // geocoding center at the current zoom floor. Never a fabricated point,
      // never a world view, never a marker fit.
      programmaticMoveRef.current = true;
      map.setView([searchCenter.lat, searchCenter.lng], Math.max(map.getZoom(), SEARCH_MIN_ZOOM), {
        ...cameraAnimationOptions(),
      });
    })();
    return () => {
      cancelled = true;
    };
    // The nonce is the trigger; searchFitPlacesRef carries the current dataset
    // (a ref, so a new Place array can never re-run a completed re-frame).
  }, [ready, searchNonce, searchCenter, fitCamera]);

  // Rebuild markers whenever the filtered marker set changes. Camera note:
  // the viewport is NEVER driven by the marker set — there is NO fit to the
  // markers in this component. The auto-fit camera reads a SEPARATE bounds
  // dataset (`fitPlaces` / `searchFitPlaces`), which is the same canonical
  // content filter WITHOUT the viewport gate; that separation is exactly what
  // keeps viewport, marker filtering, and camera from becoming a circular
  // dependency. When no Current Location fix exists yet the map stays on the
  // neutral world overview until the real fix arrives. Marker refreshes
  // (markerKey effect) never move the camera at all.
  // Performance (PO 2026-09-26): the effect is keyed on markerKey — the
  // stable signature of the marker set (ids + live sessions) — NOT on the
  // places/liveByPlaceId object identities, so discovery state updates that
  // leave the marker set unchanged no longer trigger clearLayers + a full
  // marker rebuild (and the tile-layer is never touched here at all).
  useEffect(() => {
    if (!ready) return;

    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      const map = mapRef.current;
      const layer = markerLayerRef.current;
      if (cancelled || !map || !layer) return;

      layer.clearLayers();
      const currentPlaces = places;
      // Viewport-aware empty state (PO, 2026-09-30): the mirror holds ONLY
      // the canonical coordinates that actually receive a marker (same
      // Number.isFinite fail-closed rule as the markers below — a Place
      // without valid lat/lng never appears here and never invents a
      // position). Synced BEFORE the first report of the new set so the
      // overlay can never disagree with the rendered markers.
      const markerPositions: [number, number][] = [];
      for (const place of currentPlaces) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        markerPositions.push([place.latitude, place.longitude]);
      }
      markerPositionsRef.current = markerPositions;
      // LABEL DENSITY (2026-10-05): ONE deterministic pass over the rendered
      // pins decides which compact chips stay painted when a dense cluster is
      // on screen. It is computed here — once per MARKER REBUILD, an effect
      // already keyed on the stable marker signature — so panning, zooming,
      // and every viewport report cost nothing extra, and no layout is ever
      // measured (no `getBoundingClientRect`, no `offsetWidth`, no reflow).
      // Chips past the budget keep their DOM node and their full text; only
      // their paint state changes, and CSS reveals them again on the existing
      // hover/keyboard-focus state. Priority follows the marker ladder above:
      // curated first, then Live, then canonical order.
      const alwaysLabelledPlaceIds = selectAlwaysLabelledPlaceIds(
        currentPlaces.map((place) => ({
          id: place.id,
          isCurated: place.isCurated === true,
          isLive: liveByPlaceId.has(place.id),
        })),
      );
      if (currentPlaces.length === 0) {
        evaluateViewportStatus();
        return;
      }

      for (const place of currentPlaces) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        const position: [number, number] = [place.latitude, place.longitude];
        const live = liveByPlaceId.get(place.id);

        // LIVE treatment on the SAME base pin shape: a clean live-red teardrop
        // with a pulsing core and a small "LIVE" chip — instantly readable,
        // still compact, top z-priority, navigating to /live/[sessionId].
        if (live) {
          L.marker(position, {
            icon: L.divIcon({
              className: "singgah-map-marker",
              iconSize: [0, 0],
              html: `<div role="img" aria-label="Live sekarang di ${escapeHtml(place.name)} — lihat proses produksi" style="transform:translate(-50%,-100%);filter:drop-shadow(0 3px 4px rgb(0 0 0 / 0.3));">
                <div style="position:relative;width:30px;height:38px;">
                  <div style="position:absolute;left:50%;top:0;transform:translateX(-50%);width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:9999px 9999px 9999px 0;border:2px solid #fff;background:${BRAND_LIVE};transform:rotate(-45deg);transform-origin:center;"></div>
                  <span class="singgah-live-pulse" style="position:absolute;left:50%;top:8px;transform:translateX(-50%);width:8px;height:8px;border-radius:9999px;background:#fff;"></span>
                  <span style="position:absolute;left:50%;top:-12px;transform:translateX(-50%);background:${BRAND_LIVE};color:#fff;font-size:9px;font-weight:900;letter-spacing:0.08em;line-height:1;padding:3px 6px;border-radius:9999px;">LIVE</span>
                </div>
              </div>`,
            }),
            zIndexOffset: 1000,
            keyboard: true,
          })
            .addTo(layer)
            .on("click", () => router.push(`/live/${live.sessionId}`));
        }

        // THE base Place marker (PO, 2026-09-29; per-Place curated treatment,
        // 2026-09-30): one compact teardrop for every Place with exactly TWO
        // treatments — NORMAL (brown) and CURATED (secondary green + ✦
        // accent) — on the SAME shape. The treatment follows the Place's own
        // canonical `is_curated` flag, NOT the mode: the curated map shows
        // curated and ordinary Places side by side, so a mode-level flag
        // could not tell them apart. No emoji, no always-on name label: the
        // name appears in a tooltip on hover/focus/selection (decluttered
        // dense maps). A Place that is Live keeps its normal pin right next
        // to its LIVE pin.
        const isCurated = place.isCurated === true;
        const pinColor = isCurated ? BRAND_SECONDARY : BRAND_BROWN;
        // DENSE-FRAME LABEL STATE (2026-10-05): `always` paints the compact
        // chip outright; `on-demand` keeps the same chip — same markup, same
        // truncation, same full text — and lets globals.css hold it back until
        // the pin is hovered or keyboard-focused. The accessible name, the
        // tooltip, the click target, and the marker order are identical in
        // both states, so nothing becomes unreachable.
        const labelState = alwaysLabelledPlaceIds.has(place.id) ? "always" : "on-demand";
        const accent = isCurated
          ? `<span style="transform:rotate(45deg);color:#fff;font-size:13px;line-height:1;">✦</span>`
          : "";
        const placePin = `
          <div role="img" aria-label="Lihat ${escapeHtml(place.name)}" style="transform:translate(-50%,-100%);width:28px;height:36px;filter:drop-shadow(0 2px 3px rgb(0 0 0 / 0.3));">
            <div style="position:absolute;left:50%;top:0;transform:translateX(-50%) rotate(-45deg);width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:9999px 9999px 9999px 0;border:2px solid #fff;background:${pinColor};">
              ${accent}
            </div>
            <div style="position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:5px;height:5px;border-radius:9999px;background:${pinColor};box-shadow:0 0 0 2px rgb(255 255 255 / 0.9);"></div>
            <span class="singgah-pin-label" ${PIN_LABEL_ON_DEMAND_ATTRIBUTE}="${labelState}" style="${PIN_LABEL_ANCHOR_STYLE}">${escapeHtml(place.name)}</span>
          </div>`;
        const marker = L.marker(position, {
          icon: L.divIcon({
            className: "singgah-map-marker",
            iconSize: [0, 0],
            html: placePin,
          }),
          // SELECTED MARKERS ON TOP (bug fix, 2026-10-03). Leaflet stacks
          // markers inside one pane by a latitude-derived z-index plus this
          // offset, so a selected ("Tempat Pilihan") pin used to sink UNDER an
          // ordinary pin whenever the ordinary pin sat slightly further north —
          // the selected Place was the least visible thing on a map whose whole
          // point is the selection. The offsets below are a fixed LADDER, not a
          // comparison of the data:
          //   1000 LIVE chip · 900 selected (curated) · 500 ordinary · 0 the
          //   ordinary pin that belongs to a Live Place.
          // It is applied per marker at construction, so Leaflet re-applies it
          // on every pan, zoom, viewport report, marker rebuild, and re-render:
          // the order cannot drift and no effect, listener, or camera move is
          // involved (no update loop is even possible). Artwork, colour, shape,
          // size, coordinates, click/keyboard behaviour, and the dedicated
          // `singgah-user-pane` user disc are all untouched.
          zIndexOffset: isCurated ? 900 : live ? 0 : 500,
          keyboard: true,
        })
          .addTo(layer)
          .on("click", () => router.push(`/places/${place.id}`));
        // Name tooltip on hover/focus/selection ONLY (curated and normal) —
        // Leaflet opens it on hover and keyboard focus; click still navigates
        // to the Place, so 20–50 dense pins never stack name labels.
        marker.bindTooltip(escapeHtml(place.name), {
          direction: "top",
          offset: [0, -40],
          opacity: 1,
        });
      }
      // Marker set rebuilt: re-evaluate the viewport status against the NEW
      // set (a dataset change can place markers into — or remove them from —
      // the current viewport without any camera move).
      evaluateViewportStatus();
    })();

    return () => {
      cancelled = true;
    };
    // places/liveByPlaceId are read through markerKey (exact same set);
    // router is stable in the App Router. Re-running on their identities
    // would rebuild identical markers on unrelated state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, markerKey]);

  return (
    <div className="relative h-full w-full">
      {/* touch-none keeps drag/pinch inside the map container so page
          scroll/navigation never hijacks a map gesture. relative+z-0 makes
          THIS element a closed stacking context: Leaflet's own pane z-indexes
          (tile 200 … control 1000) stay trapped inside it and can never paint
          over React siblings. Without it Leaflet's _initLayout sets only
          position:relative (no z-index) and its big pane z-indexes compete
          directly with the overlays in the frame's stacking context — the
          root cause of tiles covering the empty-state card on mobile drag.
          singgah-home-map is a PRESENTATION hook only (MOCKUP §9): it scopes
          the CSS that nudges Leaflet's +/- stack below the floating Home
          chrome, so the Producer location picker map is never affected. */}
      <div
        ref={containerRef}
        className="relative z-0 h-full w-full touch-none singgah-home-map"
        aria-label="Peta Tempat"
      />
      {/* Map UI overlays ride ABOVE Leaflet's documented z-index ceiling
          (max control z-index = 1000): 1100+ keeps the React layer strictly
          on top in any drag/zoom state.

          MOCKUP §5/§9 (2026-10-01; re-ordered by the product decision of
          2026-10-03; NAVIGATION ARROW → COMPASS, 2026-10-04): the right-side
          control stack reads as ONE white rounded column, ordered from the
          floating chrome downwards — the COMPASS, then the labeled "Lokasi
          Saya" control, then Leaflet's own +/- zoom control BELOW them
          (position "topright", restyled white in globals.css). The dot on the
          labeled control is decorative (aria-hidden) — the accessible name
          stays on the button.

          THE COMPASS replaces the old Re-center navigation arrow in the SAME
          box (same offset, same 44px size, same surface, ring and shadow), as
          the approved mockup requires. It states orientation and NOTHING else:
          this Leaflet build (1.9.x core, no rotation plugin) cannot rotate the
          map at all — there is no `setBearing`/bearing state to read and no
          rotation to undo — so the map is ALWAYS north-up and the compass
          always points north. That is why it is a plain `role="img"` with an
          accessible name instead of a button: wiring a click to "restore
          north-up" would advertise a rotation capability this map does not
          have, i.e. invented behaviour. Re-centering is still ONE press away on
          the labeled "Lokasi Saya" control below it, with its geolocation
          behaviour untouched.

          POSITION (product decision, 2026-10-03): the map is the full-bleed
          background of Home, so the whole ladder is pushed DOWN to clear the
          floating header/search/filter chrome (~190px). The offsets below and
          the .leaflet-top offset in globals.css form ONE ladder and must move
          together: Re-center 190px → "Lokasi Saya" 240px (≈41px tall, ends
          ≈281px) → Leaflet's +/- stack 290px (ends ≈350px). The zoom control
          therefore sits BELOW both buttons and never collides with them, with
          the coverage box / scale at the bottom-right, or with the map surface
          — at every supported width (360 / 390 / 430 / 1280). Same controls,
          same handlers, same sizes: only the offsets changed. */}
      {/* COMPASS — orientation indicator (approved mockup, 2026-10-04).
          Replaces the old Re-center arrow in the SAME position, with the SAME
          44px box, white surface, radius, ring and shadow, so the control
          column keeps its exact geometry. NOT interactive: this map cannot
          rotate, so a click could not restore north-up and must not pretend
          to. The needle's red half points at true north; the accessible name
          states the same fact for a screen reader. */}
      <div
        role="img"
        aria-label="Arah peta: utara ke atas"
        className="absolute right-3 top-[190px] z-[1100] inline-flex h-11 w-11 items-center justify-center rounded-xl bg-white text-brand-ink shadow-md ring-1 ring-black/10"
      >
        <svg aria-hidden viewBox="0 0 24 24" width="22" height="22" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 4.2 15.1 13.2H8.9L12 4.2Z" fill="#dc2626" />
          <path d="M12 19.8 8.9 10.8h6.2L12 19.8Z" fill="currentColor" opacity="0.35" />
        </svg>
      </div>
      <button
        type="button"
        onClick={onRequestLocate}
        className="absolute right-3 top-[240px] z-[1100] inline-flex w-11 flex-col items-center gap-1 rounded-xl bg-white px-1 py-2 text-[9px] font-bold leading-tight text-brand-ink shadow-md ring-1 ring-black/10 transition hover:bg-brand-cream"
        aria-label="Lokasi saya — pusatkan peta ke lokasi aktual"
      >
        <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#2563eb] ring-2 ring-white" />
        Lokasi Saya
      </button>
    </div>
  );
}
