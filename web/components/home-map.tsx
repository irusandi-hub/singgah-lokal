"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  CircleMarker,
  LayerGroup,
  LatLngTuple,
  Map as LeafletMap,
  TileLayer,
} from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  FIT_SINGLE_PLACE_ZOOM,
  PIN_LABEL_HEIGHT_PX,
  boundsOfPoints,
  collectGeoPoints,
  isSameViewport,
  resolveCameraFitPadding,
  selectVisiblePinLabelIds,
  shouldReportViewportStatus,
  type MapViewport,
  type PinLabelBox,
} from "@/lib/live/ui";

/**
 * ONE shared Leaflet load (perf, 2026-10-25).
 *
 * Leaflet touches `window` at import time, so it stays a LAZY module and never
 * enters the server graph (`typeof window` guard below). What changes is
 * WHEN the chunk is requested: it used to start only after hydration, from
 * inside the map effect — leaving a ~1 s download (Slow 4G) between "Home is
 * interactive" and "the first frame can be decided", which in turn delayed
 * the very first OSM tile (the mobile LCP element). The request now starts as
 * soon as this chunk is evaluated, i.e. while the rest of Home is still
 * hydrating.
 *
 * NOTHING is created early: no map instance, no tile layer, no marker, no
 * camera. `finalizeInitialFrame` still decides the first frame and still
 * creates the ONE tile layer after it — the loading order there is untouched.
 * The single promise is shared by every former `import("leaflet")` call site,
 * so the module is fetched and parsed exactly once.
 */
function importLeaflet() {
  return import("leaflet");
}
let leafletModulePromise: ReturnType<typeof importLeaflet> | null = null;

function loadLeaflet() {
  if (!leafletModulePromise) leafletModulePromise = importLeaflet();
  return leafletModulePromise;
}

if (typeof window !== "undefined") void loadLeaflet();

/**
 * Real interactive map for Home discovery.
 * - Tiles: OpenStreetMap (attribution required). ONE basemap — no
 *   terrain/satellite/layer selector. Zoom is gesture-only since 2026-10-18
 *   (pinch and two-finger pan; the Leaflet +/- buttons were removed), and
 *   scroll-wheel zoom stays functional on pointer devices. One-finger camera
 *   control (touch drag + double-tap) is
 *   LOCKED OFF on touch-primary devices (PO 2026-09-27): a single finger
 *   never pans/zooms the map — two-finger pan + pinch zoom stay available.
 * - Markers come ONLY from canonical Place lat/lng — a Place without
 *   coordinates never receives a marker (fail-closed, no invented position).
 * - Current Location is the map's anchor: the real browser geolocation fix
 *   becomes the camera center. There is NO fallback viewport and NO invented
 *   user position. The FIRST frame is decided before anything is painted: a
 *   known origin (searched city, else the real fix) frames the local area; with
 *   no origin the map frames the canonical Place spread once the first location
 *   attempt has settled, so a world-scale frame is never painted and then
 *   replaced by the local one. Never a stand-in country or default city.
 * - Camera authority (PO, 2026-09-29 + 2026-09-30 map-coverage fix and
 *   coverage decision): ONE deterministic radius mechanism — every distance
 *   preset (1 km / 5 km / 10 km+) frames exactly that radius around the real
 *   Current Location through `radiusZoom`, applied with the ONE shared
 *   camera transition (`cameraAnimationOptions`, 2026-10-04: a short 0.6 s
 *   ease, instant under prefers-reduced-motion). Distance-tab radii
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
 *     · the fit happens ONLY on an EXPLICIT refocus trigger (a new search
 *       answer, or the "Lokasi Saya" press; the "Tempat Pilihan" tab stopped
 *       framing anything on 2026-10-05). Marker refreshes, discovery
 *       re-polls, and every viewport report can never re-frame the camera, so
 *       there is no recenter loop and no repeated zoom;
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
 *   · LATCH: every explicit user request (a distance tab, "Lokasi Saya", a
 *     new search answer) records the camera it produced.
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
 *   TWO Place treatments — NORMAL (warm brown gradient, white core) and
 *   CURATED (dark green, gold ✦, thin gold ring; from the canonical
 *   `places.is_curated` flag of that Place) — plus the LIVE treatment (live
 *   red, small pulsing red corner dot, LIVE chip, top z-priority, navigates
 *   to /live/[sessionId]). The "Tempat Pilihan" map
 *   shows curated AND ordinary Places at once, so the treatment is per Place,
 *   never per mode. No emoji glyphs. Each pin carries its compact Place-name
 *   chip beneath the anchor; since 2026-10-21 the chips are decluttered by
 *   ZOOM — a far frame keeps few names, a closer frame admits more, a chip
 *   that would collide with a kept one is held back, and the SELECTED Place is
 *   always labelled (see .singgah-pin-label in globals.css and
 *   `selectVisiblePinLabelIds`). The pin itself is never hidden, and the
 *   hover/focus tooltip still carries the FULL name.
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
  /**
   * FIRST-FRAME READINESS (root-cause fix, 2026-10-23): true once the FIRST
   * geolocation attempt has settled — success (a fix exists) or failure /
   * timeout / unavailable (there is no fix). The map's initial frame waits for
   * this ONLY while it has no origin of its own, so a real fix can never be
   * preceded by a world-scale frame that the fix then replaces. Defaults to
   * `true`, which is the correct, non-blocking behaviour for a caller that
   * never asks for a position.
   */
  viewerSettled?: boolean;
  locateNonce: number;
  /**
   * THE camera preset (PO, 2026-09-29; coverage unified 2026-09-30): when
   * set, the frame covers exactly this radius around the real Current
   * Location — through ONE deterministic radiusZoom mechanism owned by the
   * three distance tabs (1 km / 5 km / 10 km+) and applied with the shared
   * camera transition (`cameraAnimationOptions`, 0.6 s ease, instant under
   * prefers-reduced-motion). The radius only ever changes the frame, never
   * the marker set: it is decided upstream and never filters Places.
   *
   * SUPERSEDED FOR THE CURATED LAYER AND FOR THE SCALE READOUT (2026-10-03):
   * an explicit "Tempat Pilihan" choice used to be framed by `fitCamera` over
   * the viewer's LOCAL AREA, and this value never described that frame. Since
   * 2026-10-05 the curated tab moves no camera at all, so this value is purely
   * the active distance-tab preset, and it is never rendered as a map scale.
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
   * there through the ONE shared camera transition (`cameraAnimationOptions`,
   * short and eased, instant under prefers-reduced-motion) at a zoom that
   * frames the search window. It carries geometry
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
   * It is a SEPARATE prop from `places` because that one is narrowed to the
   * visible viewport, which is what keeps the camera from chasing the markers
   * it just moved.
   */
  locateFitPlaces?: HomeMapPlace[];
  /**
   * Short one-shot focus pulse on the EXISTING Current Location pin when a
   * preset applies: the camera moves through the shared camera transition,
   * and this short pin pulse is the affirmative feedback on top of it. No new
   * marker, no marker redesign, no map animation of its own;
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
  /**
   * MARKER ↔ CARD (2026-10-18). The Place whose pin is highlighted because its
   * card is being pressed or was selected from the map. Display only — it
   * changes no marker identity, membership, coordinate, or camera state.
   */
  highlightedPlaceId?: string | null;
  /**
   * A BASE PIN TAP SELECTS ITS PLACE (2026-10-18) instead of navigating: the
   * caller opens the results sheet and scrolls the matching card into view.
   * When absent the legacy navigation is kept. A LIVE pin still opens the live
   * session directly.
   */
  onSelectPlace?: (placeId: string) => void;
  /**
   * Visible sheet height in px (2026-10-18): the OSM attribution is lifted by
   * this amount so the credit is never covered at the small/mid positions.
   */
  bottomInset?: number;
};

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

// PLACE-PIN BROWN (2026-10-21): a DEEPER shade of the same brand accent brown.
// The old tan (`--brand-accent` #c89b6b) reached only 2.27:1 against the
// cream map surface, so a Place pin competed with the basemap instead of
// leading it. The deep brown keeps the brand hue and reaches 5.27:1 — the
// pin is the first thing read on a calm map, without changing its shape,
// size, anchor, or behaviour. `--brand-accent` itself is untouched everywhere
// else in the app.
const BRAND_BROWN = "var(--brand-pin)";
const BRAND_LIVE = "var(--live)";
// Current Location marker color (MOCKUP §6, 2026-10-01): the user marker is
// BLUE with a soft glow, per the latest approved mockup. Visual only — the
// geolocation fix, the camera, and the Place-marker model are untouched, and
// blue stays exclusive to the user pin (Place pins remain brown/green/red).
const BRAND_PIN = "#2563eb";
// Marker system colors (PO, 2026-09-29; deeper curated green 2026-10-22):
// ONE base Place pin (brand brown) with two Place treatments — "Tempat
// Pilihan" uses the DARK brand green (the sage secondary was too pale to read
// as a deliberate selection on the calm basemap), LIVE uses the live red, and
// the Current Location disc is the BLUE user marker (MOCKUP §6) so it never
// looks like a Place. Colours only: the shape, size, anchor, click target,
// aria-label, and marker ladder are identical in every treatment.
const BRAND_CURATED = "var(--brand-primary)";
/**
 * Name of the dedicated Current Location pane (see the map init effect). It
 * exists so the user disc always paints ABOVE every Place pin, whatever the
 * latitude-based z-ordering of DOM markers would do.
 */
const USER_PANE = "singgah-user-pane";

/**
 * ONE-SHOT locate feedback window (PO, 2026-09-30): how long the Current
 * Location pin pulses after "Lokasi Saya". It covers the whole camera apply
 * (the shared 0.6 s transition of `cameraAnimationOptions`, which is instant
 * under prefers-reduced-motion), and it must stay BOUNDED — one short burst,
 * never a permanent animation. Mirrors .singgah-locate-pulse in globals.css.
 */
const LOCATE_PULSE_MS = 900;
/**
 * HISTORY: "Lokasi Saya" once owned its own short camera easing
 * (LOCATE_TRANSITION_MS, PO 2026-09-30). That per-path constant was RETIRED
 * 2026-10-03 when the action began framing the local Place distribution, and
 * on 2026-10-04 camera motion returned through ONE shared helper —
 * `cameraAnimationOptions` below (0.6 s ease, instant under
 * prefers-reduced-motion). No per-path timing may come back here.
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
 * THE PRESET ZOOM FOR A RADIUS (PO, 2026-09-29) — one pure function, used by
 * BOTH the distance-tab preset effect and the initial frame. The zoom is a
 * function of the radius alone (never of the marker set, never of the current
 * zoom), so 1 km < 5 km < 10 km+ stay strictly ordered. The `- 0.5` keeps the
 * radius circle inside the frame; `getBoundsZoom` is Leaflet's own projection
 * math, so no coordinate is invented here.
 */
function presetZoomForRadius(
  map: LeafletMap,
  position: { lat: number; lng: number },
  radiusMeters: number,
): number {
  const latDelta = radiusMeters / 111_320;
  const lngDelta =
    radiusMeters / (111_320 * Math.max(0.1, Math.cos((position.lat * Math.PI) / 180)));
  const corners: LatLngTuple[] = [
    [position.lat - latDelta, position.lng - lngDelta],
    [position.lat + latDelta, position.lng + lngDelta],
  ];
  return map.getBoundsZoom(corners, false) - 0.5;
}
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
 *
 * SCOPE (audit 2026-10-17): the budget ranks PLACE chips only. The Current
 * Location disc deliberately carries NO name chip — its identity is the blue
 * disc, its glow, and the surrounding-area ring (MOCKUP §6), so it can never
 * consume a Place's label budget, collide with a Place chip, or hide behind
 * the declutter state. The user marker and the Place labels therefore never
 * compete for the same pixels or the same priority.
 */
const PIN_LABEL_ON_DEMAND_ATTRIBUTE = "data-label-state";
/** Chip max width from globals.css (`.singgah-pin-label`). */
const PIN_LABEL_MAX_WIDTH_PX = 124;
/** Approximate advance per character at 11.5px/600, plus the 7px side padding. */
const PIN_LABEL_CHAR_WIDTH_PX = 6.7;
/** Distance from the pin anchor down to the chip's top edge (CSS: top 100% + 1px). */
const PIN_LABEL_TOP_OFFSET_PX = 3;

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
  viewerSettled = true,
  locateNonce,
  cameraRadiusMeters = null,
  cameraCenter = null,
  searchCenter = null,
  searchNonce = 0,
  searchFitPlaces = [],
  locateFitPlaces = [],
  pulsePinOnPresetChange = false,
  onViewportHasPlaces,
  onViewportChange,
  cameraRequestNonce = 0,
  highlightedPlaceId = null,
  onSelectPlace,
  bottomInset = 0,
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
  const searchFitPlacesRef = useRef<HomeMapPlace[]>(searchFitPlaces);
  // Same mirroring rule for the "Lokasi Saya" local-area dataset. It is
  // refreshed in an effect declared BEFORE the locate effect below, so a press
  // always reads the CURRENT dataset — never the one from a previous fix or a
  // previous search.
  const locateFitPlacesRef = useRef<HomeMapPlace[]>(locateFitPlaces);
  // FIRST FRAME (root-cause fix, 2026-10-23). The initial frame is decided from
  // the ACTIVE ORIGIN (searched city first, else the real fix — the same
  // `cameraCenter` value every preset reads) and from the FIRST location
  // attempt's own outcome. All four are mirrored into refs so the mount-once
  // map lifecycle reads the CURRENT values instead of a stale closure.
  const initialOriginRef = useRef<{ lat: number; lng: number } | null>(null);
  const viewerSettledRef = useRef(viewerSettled);
  const cameraRadiusRef = useRef<number | null>(cameraRadiusMeters ?? null);
  const initialFrameDoneRef = useRef(false);
  const finalizeInitialFrameRef = useRef<(() => Promise<boolean>) | null>(null);

  const router = useRouter();
  const [ready, setReady] = useState(false);
  // LABEL VISIBILITY SOURCES (2026-10-21): the zoom-end listener is long-lived,
  // so the marker set, its Live membership, and the selected Place are mirrored
  // into refs. Zooming then re-decides which chips are painted without
  // rebuilding a single marker.
  const placesRef = useRef<HomeMapPlace[]>(places);
  const liveByPlaceIdRef = useRef(liveByPlaceId);
  const highlightedPlaceIdRef = useRef(highlightedPlaceId);
  // Place id -> the marker's icon element, so a label state can be flipped
  // directly (no marker rebuild, no layout read).
  const markersByIdRef = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    placesRef.current = places;
  }, [places]);

  useEffect(() => {
    liveByPlaceIdRef.current = liveByPlaceId;
  }, [liveByPlaceId]);

  useEffect(() => {
    highlightedPlaceIdRef.current = highlightedPlaceId;
  }, [highlightedPlaceId]);

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
    searchFitPlacesRef.current = searchFitPlaces;
  }, [searchFitPlaces]);

  useEffect(() => {
    locateFitPlacesRef.current = locateFitPlaces;
  }, [locateFitPlaces]);

  // FIRST-FRAME SOURCES (declared BEFORE the map lifecycle effect, so the very
  // first mount already sees them). `cameraCenter` is Home's ONE resolved
  // anchor (searched city first, else the real fix); the raw values are read
  // only as a safety net for a caller that passes one without the other.
  useEffect(() => {
    const origin = cameraCenter ?? viewerPosition ?? searchCenter ?? null;
    initialOriginRef.current = origin ? { lat: origin.lat, lng: origin.lng } : null;
  }, [cameraCenter, viewerPosition, searchCenter]);

  useEffect(() => {
    viewerSettledRef.current = viewerSettled;
  }, [viewerSettled]);

  useEffect(() => {
    cameraRadiusRef.current = cameraRadiusMeters ?? null;
  }, [cameraRadiusMeters]);

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

  // Short pin focus feedback (PO, 2026-09-30; camera motion unified
  // 2026-10-04): the camera moves through the ONE shared transition helper
  // (short 0.6 s ease, instant under prefers-reduced-motion), so the pin
  // pulse remains the affirmative feedback on top of it — on every "Lokasi
  // Saya" recenter and on a preset change. The pin is Leaflet SVG (a Path
  // accepts a
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

  // Jump to the real user position WITHOUT changing the frame width, through
  // the shared camera transition (instant under prefers-reduced-motion).
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
    async (map: LeafletMap, position: { lat: number; lng: number }, radiusMeters: number) =>
      // ONE implementation, shared with the initial frame — the preset zoom can
      // never differ between the first paint and a later tab choice.
      presetZoomForRadius(map, position, radiusMeters),
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

  // EDGE-SAFE LABEL ANCHORS (2026-10-23). The chip is normally centred under
  // its pin, but a pin near the viewport edge used to push half the chip into
  // the clipped map border. This keeps the SAME chip, text, max width, and
  // density budget; only its anchor slides inward so the full label stays on
  // screen. Re-applied on every settled move/zoom and marker rebuild.
  const applyPinLabelAnchors = useCallback(
    (map: LeafletMap, sourcePlaces: readonly HomeMapPlace[]) => {
      const size = map.getSize();
      const edge = 6;
      for (const place of sourcePlaces) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        const element = markersByIdRef.current.get(place.id);
        const label = element?.querySelector<HTMLElement>(".singgah-pin-label");
        if (!label) continue;
        const point = map.latLngToContainerPoint([place.latitude, place.longitude]);
        const width = Math.min(
          PIN_LABEL_MAX_WIDTH_PX,
          Math.round(place.name.length * PIN_LABEL_CHAR_WIDTH_PX) + 16,
        );
        // The chip's containing block is the 24px-wide `.singgah-pin`, whose
        // left edge sits 12px left of the pin anchor. `left: 50%` therefore is
        // 12px; the centre transform is kept only when there is room.
        const pinLeft = point.x - 12;
        let left: number;
        let transform: string;
        if (pinLeft + width / 2 < edge) {
          left = edge - pinLeft;
          transform = "translate(0,1px)";
        } else if (pinLeft + width / 2 > size.x - edge) {
          left = size.x - edge - width - pinLeft;
          transform = "translate(0,1px)";
        } else {
          left = 12;
          transform = "translate(-50%,1px)";
        }
        label.style.left = `${left}px`;
        label.style.transform = transform;
      }
    },
    [],
  );

  // LABEL DECLUTTER AT THE CURRENT ZOOM (2026-10-21). Pure projected geometry:
  // each chip's box is derived from `map.project(latlng, zoom)` and the SAME
  // chip typography (max 124px, 11.5px/600) — no `getBoundingClientRect`, no
  // `offsetWidth`, no reflow. A far-out frame therefore keeps few labels, a
  // close frame admits more, a label that would overlap a kept one is held
  // back, and the SELECTED Place is always labelled. Pins, coordinates, click
  // targets, tooltips, DOM text, and the marker ladder are untouched: only the
  // `data-label-state` paint flag changes, exactly like the pre-existing
  // density budget.
  const applyPinLabelStates = useCallback(
    (
      map: LeafletMap,
      sourcePlaces: readonly HomeMapPlace[],
      liveMap: Map<string, HomeMapLive>,
      selectedId: string | null,
    ) => {
      const zoom = map.getZoom();
      const boxes: PinLabelBox[] = [];
      for (const place of sourcePlaces) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        const point = map.project([place.latitude, place.longitude], zoom);
        const width = Math.min(
          PIN_LABEL_MAX_WIDTH_PX,
          Math.round(place.name.length * PIN_LABEL_CHAR_WIDTH_PX) + 16,
        );
        boxes.push({
          id: place.id,
          x: point.x - width / 2,
          y: point.y + PIN_LABEL_TOP_OFFSET_PX,
          width,
          height: PIN_LABEL_HEIGHT_PX,
          tier:
            place.id === selectedId
              ? 0
              : place.isCurated === true
                ? 1
                : liveMap.has(place.id)
                  ? 2
                  : 3,
        });
      }
      const visible = selectVisiblePinLabelIds({ boxes, zoom, pinnedId: selectedId });
      for (const [id, element] of markersByIdRef.current) {
        const label = element.querySelector<HTMLElement>(".singgah-pin-label");
        if (label) {
          label.setAttribute(PIN_LABEL_ON_DEMAND_ATTRIBUTE, visible.has(id) ? "always" : "on-demand");
        }
      }
      applyPinLabelAnchors(map, sourcePlaces);
    },
    [applyPinLabelAnchors],
  );

  // Called by the map's own zoomend, over the mirrors above.
  const refreshPinLabelsAtCurrentZoom = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    applyPinLabelStates(map, placesRef.current, liveByPlaceIdRef.current, highlightedPlaceIdRef.current);
  }, [applyPinLabelStates]);

  const refreshPinLabelAnchors = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    applyPinLabelAnchors(map, placesRef.current);
  }, [applyPinLabelAnchors]);

  // Create the map once. Leaflet touches window, so it is imported
  // dynamically inside the effect (safe for SSR of this client component).
  // The container is marked synchronously BEFORE the async import resolves,
  // so a second setup (React Strict Mode double-mount, fast route
  // transition, refresh) can never initialize a second Leaflet instance on
  // the same container — and a cancelled setup releases the mark.
  useEffect(() => {
    let cancelled = false;
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    let viewportSettleTimer: ReturnType<typeof setTimeout> | null = null;

    const invalidate = (map: LeafletMap) => {
      map.invalidateSize();
    };

    (async () => {
      const container = containerRef.current;
      // STRICT-MODE FIX (2026-10-19): only a READY map blocks a new setup. The
      // old guard also blocked on "initializing", which deadlocked the dev
      // Strict-Mode replay — the first effect claimed the container, its
      // cleanup released it, the replay saw "initializing" and gave up, and
      // the cancelled first import then cleared the claim, so NO map was ever
      // created. A cancelled setup now returns WITHOUT releasing the claim
      // (the replay owns the container), and the ready map plus `mapRef`
      // remain the single-instance gate.
      if (!container || container.dataset.singgahMap === "ready") return;
      container.dataset.singgahMap = "initializing";

      const L = (await loadLeaflet()).default;
      if (cancelled) return;
      if (!containerRef.current || mapRef.current) return;

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
      // OSM ATTRIBUTION (2026-10-21): the credit STAYS (ODbL requires it), but
      // Leaflet's decorative "Leaflet" wordmark and its flag are removed — the
      // contributor is what the licence asks us to show, and the credit is
      // styled to 9.5px with a translucent surface in globals.css. No link,
      // target, or rel is touched.
      map.attributionControl.setPrefix(false);

      // GESTURE-ONLY ZOOM (2026-10-18): the Leaflet +/- buttons were removed
      // from the Home map. Pinch and two-finger pan remain fully functional
      // (TouchZoom), and pointer devices keep the scroll wheel. There is no
      // button zoom control left to offset in the right-hand column.

      // VIEWPORT SETTLE (2026-10-23). moveend and zoomend both fire for one
      // zoom (in that order), so the old wiring ran the whole viewport pass
      // twice per gesture and re-rendered the Home rows twice. They are now
      // coalesced into ONE trailing update 80 ms after the last event of the
      // burst — still once per gesture, never per frame, and never during a
      // drag. The public callbacks, the emptiness rule, and the reported
      // bounds are unchanged; only the duplicate work between events is gone.
      const settleViewport = () => {
        if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
        viewportSettleTimer = setTimeout(() => {
          viewportSettleTimer = null;
          // Viewport-aware empty state (PO, 2026-09-30): every FINISHED move —
          // two-finger pan, pinch zoom, or a programmatic preset flight —
          // re-evaluates whether a Place sits in the viewport.
          evaluateViewportStatus();
          // The visible area itself is the coverage source for the Home rows
          // (product decision, 2026-10-01), so it is reported on exactly the
          // same settled events — never per frame.
          reportViewportBounds();
          // A settled pan can move a labelled pin to the viewport edge; slide
          // its anchor back inside without recomputing the density budget.
          refreshPinLabelAnchors();
        }, 80);
      };
      map.on("moveend", () => {
        programmaticMoveRef.current = false;
        settleViewport();
      });
      map.on("zoomend", settleViewport);
      // Label declutter is a ZOOM decision: pins spread out in pixels as the
      // camera gets closer, so the same deterministic pass admits more chips.
      map.on("zoomend", refreshPinLabelsAtCurrentZoom);
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

      // THE ONE INITIAL FRAME (root-cause fix, 2026-10-23).
      //
      // BUG THIS REPLACES: the map always painted a frame of its own first —
      // the whole-catalogue fit (added 2026-10-23 in PR #53 so the viewport
      // gate could not disagree with the first paint). Because the catalogue
      // spans the Gulf, Riyadh AND West Java, that fit is a WORLD-scale frame
      // (`minZoom: 2`, ~137° of longitude): every Place on screen is a couple
      // of pixels wide, the Gulf Places collapse into one blob, and the frame
      // is shifted north-east by the fit's asymmetric chrome padding. The
      // location camera then replaced it a moment later — so Home always went
      // "global overview → local area" during loading, and the narrowed local
      // marker set was drawn on top of the still-loading world basemap. That
      // is the reported "global map with only two places, then it changes".
      // PR #53 did not remove it because it only made the DATASET agree with
      // that first world frame; the world frame itself stayed the first paint.
      //
      // THE RULE NOW: one frame, decided before any tile or marker is painted.
      //   · a real origin is already known (search center, else the device
      //     fix) → frame the LOCAL AREA exactly like the existing camera
      //     presets do (radius preset around that origin; the local-area
      //     dataset when no radius is active; the origin itself as the last
      //     resort). No world frame is ever painted first;
      //   · no origin, and the FIRST location attempt already settled as
      //     failed/unavailable → frame the canonical Place spread, so markers,
      //     rows, and count agree with the frame (the documented, permitted
      //     no-origin view: no coordinate is invented);
      //   · no origin, and that attempt is still running → paint nothing yet.
      //     The basemap, the markers, and `ready` are held until the request's
      //     OWN callbacks settle it (the request already carries its 8 s
      //     timeout), so the first visible frame is the correct one. This is a
      //     data decision, not a delay: nothing here hides a wrong frame with a
      //     timer.
      const applyCatalogueFrame = () => {
        const initialPoints = collectGeoPoints(placesRef.current);
        const initialBounds = boundsOfPoints(initialPoints);
        if (initialPoints.length === 1) {
          // One Place: a degenerate box would jump to the map's maximum zoom,
          // so it is framed with the same single-Place zoom every other fit
          // uses.
          map.setView([initialPoints[0].lat, initialPoints[0].lng], FIT_SINGLE_PLACE_ZOOM, {
            animate: false,
          });
        } else if (initialBounds) {
          const initialPadding = resolveCameraFitPadding(map.getSize());
          map.fitBounds(
            L.latLngBounds(
              [initialBounds.south, initialBounds.west],
              [initialBounds.north, initialBounds.east],
            ),
            {
              paddingTopLeft: initialPadding.paddingTopLeft,
              paddingBottomRight: initialPadding.paddingBottomRight,
              animate: false,
            },
          );
        } else {
          // No Place coordinate at all: the world overview is the only honest
          // frame. Never a default city, country, or stand-in coordinate.
          map.fitWorld();
        }
      };

      const applyOriginFrame = (origin: { lat: number; lng: number }) => {
        const radius = cameraRadiusRef.current;
        if (typeof radius === "number" && Number.isFinite(radius) && radius > 0) {
          map.setView(
            [origin.lat, origin.lng],
            Math.max(2, presetZoomForRadius(map, origin, radius)),
            { animate: false },
          );
          return;
        }
        const points = collectGeoPoints(locateFitPlacesRef.current);
        const bounds = boundsOfPoints(points);
        if (points.length === 1) {
          map.setView([points[0].lat, points[0].lng], FIT_SINGLE_PLACE_ZOOM, { animate: false });
          return;
        }
        if (bounds) {
          const padding = resolveCameraFitPadding(map.getSize());
          map.fitBounds(
            L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]),
            {
              paddingTopLeft: padding.paddingTopLeft,
              paddingBottomRight: padding.paddingBottomRight,
              animate: false,
            },
          );
          return;
        }
        map.setView([origin.lat, origin.lng], Math.max(map.getZoom(), SEARCH_MIN_ZOOM), {
          animate: false,
        });
      };

      // EXACTLY ONE tile layer for the map's whole lifetime — a removed
      // instance can never leave an orphaned OSM layer (stale/repeated tiles
      // after remount, refresh, or drag on Android Chrome). It is created with
      // the FIRST FRAME, never before it, so no wrong basemap is ever
      // requested.
      const finalizeInitialFrame = async (): Promise<boolean> => {
        if (cancelled || mapRef.current !== map || initialFrameDoneRef.current) return false;
        // An unmeasured container cannot choose an honest frame — a 0-sized fit
        // is meaningless. The ResizeObserver finishes the frame as soon as the
        // real box exists (never a timer of its own).
        const size = map.getSize();
        if (size.x === 0 || size.y === 0) return false;
        const origin = initialOriginRef.current;
        if (origin) {
          applyOriginFrame(origin);
        } else if (viewerSettledRef.current) {
          applyCatalogueFrame();
        } else {
          // The first location attempt is still in flight — wait for its own
          // callback (success → local frame, failure → catalogue frame).
          return false;
        }
        if (cancelled || mapRef.current !== map) return false;
        if (!tileLayerRef.current) {
          tileLayerRef.current = L.tileLayer(OSM_TILE_URL, {
            attribution: OSM_ATTRIBUTION,
            // CALM BASEMAP (2026-10-21): OSM standard tiles are a single
            // rendered PNG per tile — there is no vector style, no layer list,
            // and no label switch to configure. This class is therefore the
            // ONLY styling hook the source offers: globals.css applies one
            // gentle, whole-raster tonal adjustment (less saturation, slightly
            // flatter contrast, a warm tint). It changes no tile URL, provider,
            // zoom, attribution, or interaction.
            className: "singgah-basemap",
            maxZoom: 19,
            noWrap: true,
            // Match the map's FINITE maxBounds: tiles stop at the ±180 world
            // edge instead of requesting wrapped/empty tiles outside it.
            bounds: [
              [-85, -180],
              [85, 180],
            ],
          }).addTo(map);
        }
        container.dataset.singgahMap = "ready";
        // WHICH frame the map opened on (presentation hook beside the existing
        // `data-singgah-map`): `origin` = the viewer's local area / searched
        // city, `catalogue` = the settled no-origin spread. It records the ONE
        // first-frame decision, so a regression back to "world frame first,
        // local frame a moment later" is observable instead of timing-dependent.
        container.dataset.singgahMapFrame = origin ? "origin" : "catalogue";
        initialFrameDoneRef.current = true;
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
        return true;
      };
      finalizeInitialFrameRef.current = finalizeInitialFrame;
      await finalizeInitialFrame();
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
            // A first frame held for an unmeasured container (or for the first
            // location outcome) is finished here, once the box is real.
            if (!initialFrameDoneRef.current) void finalizeInitialFrameRef.current?.();
            evaluateViewportStatus();
            reportViewportBounds();
          })
        : null;
    if (resizeObserver && containerRef.current) resizeObserver.observe(containerRef.current);
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      initialFrameDoneRef.current = false;
      finalizeInitialFrameRef.current = null;
      setReady(false);
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      if (viewportSettleTimer !== null) clearTimeout(viewportSettleTimer);
      if (locatePulseTimerRef.current !== null) clearTimeout(locatePulseTimerRef.current);
      locatePulseTimerRef.current = null;
      window.removeEventListener("resize", onWindowResize);
      resizeObserver?.disconnect();
      const container = containerRef.current;
      if (container) {
        container.dataset.singgahMap = "";
        container.dataset.singgahMapFrame = "";
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

  // HELD FIRST FRAME (root-cause fix, 2026-10-23). When the map was created
  // before the first location attempt settled AND no origin was known yet, the
  // lifecycle effect painted nothing (`finalizeInitialFrame` returns false) so
  // that a world-scale catalogue frame could never be replaced by the local one
  // afterwards. That frame is finished HERE, on the location outcome itself:
  // the fix → the local-area frame; a denial / timeout / unavailable → the
  // catalogue frame. It re-runs on the values the decision reads, so it can
  // never miss the transition, and once the frame is painted the ref makes
  // every later run a no-op.
  useEffect(() => {
    if (initialFrameDoneRef.current) return;
    const finalize = finalizeInitialFrameRef.current;
    if (!finalize) return;
    void finalize();
  }, [viewerSettled, viewerPosition, cameraCenter, searchCenter]);

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
  // The move goes through the shared camera transition
  // (`cameraAnimationOptions`, short 0.6 s ease, instant under
  // prefers-reduced-motion), and it flags itself as programmatic so its own
  // moveend/zoomend events can never be mistaken for a user interaction
  // (which would latch the camera).
  //
  // `maxZoom` is the ONLY per-path difference, and it is a zoom level rather
  // than a radius: it lets a caller stop an extremely tight box from becoming
  // a street-level frame. It can only widen the frame, so it can never drop a
  // candidate Place out of it.
  const fitCamera = useCallback(
    async (map: LeafletMap, candidatePlaces: HomeMapPlace[], maxZoom?: number) => {
      const L = (await loadLeaflet()).default;
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
      // ONE preset path for every distance tab (PO, 2026-09-29): each tab
      // applies through the same radiusZoom preset — a new preset always
      // applies (deterministic), manual pan/zoom in between is respected
      // (the latch re-arms only on a new explicit request). The apply goes
      // through the shared camera transition (`cameraAnimationOptions`, short
      // 0.6 s ease, instant under prefers-reduced-motion); the one-shot pin
      // pulse is the affirmative feedback on top of it (PO 2026-09-30).
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
  }, [ready, viewerPositionKey, cameraCenterKey, cameraRadiusMeters, viewerPosition, cameraCenter, cameraRequestNonce, focusUser, radiusZoom, fitCamera, pulsePinOnPresetChange, triggerLocatePulse]);

  // Render/update the user marker from the real geolocation fix. Camera
  // decisions live in the anchor effect above.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !viewerPosition) return;
    let cancelled = false;

    (async () => {
      const L = (await loadLeaflet()).default;
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
  // It applies through the shared camera transition (short 0.6 s ease,
  // instant under prefers-reduced-motion) and the one-shot pin pulse is the
  // affirmative feedback — never a long, attention-grabbing flight.
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
  // the camera frames the SPREAD of the Places relevant to the searched
  // region — chrome/control padding reserved, through the shared camera
  // transition — instead of only centering on the geocoder's city point, so
  // Places scattered across the searched region are all visible instead of
  // the ones near the midpoint.
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
  // dataset (`searchFitPlaces` / `locateFitPlaces`), which is the same canonical
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
      const L = (await loadLeaflet()).default;
      const map = mapRef.current;
      const layer = markerLayerRef.current;
      if (cancelled || !map || !layer) return;

      layer.clearLayers();
      markersByIdRef.current.clear();
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
      // LABEL DECLUTTER (2026-10-05; zoom-aware 2026-10-21): the chips are
      // decided ONCE PER MARKER REBUILD and again on every zoomend by the ONE
      // deterministic `applyPinLabelStates` pass, from projected boxes. Panning
      // and viewport reports cost nothing (relative boxes do not change), no
      // layout is ever measured, and past-budget / colliding chips keep their
      // DOM node and full text — only their paint state changes, and CSS
      // reveals them again on the existing hover/keyboard-focus state.
      if (currentPlaces.length === 0) {
        evaluateViewportStatus();
        return;
      }

      for (const place of currentPlaces) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        const position: [number, number] = [place.latitude, place.longitude];
        const live = liveByPlaceId.get(place.id);
        // CARD ↔ PIN HIGHLIGHT (2026-10-18): display only. The class and the
        // z-offset make the pin the one the pressed/selected card belongs to.
        const isHighlighted = highlightedPlaceId === place.id;

        // LIVE treatment on the SAME base pin shape: a clean live-red teardrop
        // with a white core, a small pulsing red dot on its corner, and the
        // "LIVE" chip — instantly readable, still compact, top z-priority,
        // navigating to /live/[sessionId]. The dot exists ONLY inside this
        // `if (live)` branch, i.e. it can never be painted from a guess: a
        // live session id from the canonical map is the only source.
        if (live) {
          L.marker(position, {
            icon: L.divIcon({
              className: `singgah-map-marker${isHighlighted ? " is-highlighted" : ""}`,
              iconSize: [0, 0],
              html: `<div role="img" aria-label="Live sekarang di ${escapeHtml(place.name)} — lihat proses produksi" class="singgah-pin singgah-pin--live" style="--pin-color:${BRAND_LIVE};">
                <span class="singgah-pin-art">
                  <span class="singgah-pin-head"><span class="singgah-pin-core" aria-hidden></span></span>
                  <span class="singgah-pin-live-dot singgah-live-pulse" aria-hidden></span>
                </span>
                <span class="singgah-pin-hit" aria-hidden></span>
                <span class="singgah-pin-badge" aria-hidden>LIVE</span>
              </div>`,
            }),
            zIndexOffset: isHighlighted ? 2600 : 1000,
            keyboard: true,
          })
            .addTo(layer)
            .on("click", () => router.push(`/live/${live.sessionId}`));
        }

        // THE base Place marker (PO, 2026-09-29; per-Place curated treatment,
        // 2026-09-30): one compact teardrop for every Place with exactly TWO
        // treatments — NORMAL (warm brown gradient + white core) and CURATED
        // (dark green + gold ✦ and a thin gold ring) — on the SAME shape, now
        // with a transparent 40×44 tap pad and a soft earth shadow. The
        // treatment follows the Place's own
        // canonical `is_curated` flag, NOT the mode: the curated map shows
        // curated and ordinary Places side by side, so a mode-level flag
        // could not tell them apart. Each pin carries its compact name chip
        // beneath the anchor (always-on since 2026-10-04, held to the
        // deterministic on-screen budget computed above); the hover/focus
        // tooltip still carries the full name. A Place that is Live keeps its
        // normal pin right next to its LIVE pin.
        const isCurated = place.isCurated === true;
        const pinColor = isCurated ? BRAND_CURATED : BRAND_BROWN;
        const pinTone = isCurated ? "curated" : "place";
        // DENSE-FRAME LABEL STATE (2026-10-05): `always` paints the compact
        // chip outright; `on-demand` keeps the same chip — same markup, same
        // truncation, same full text — and lets globals.css hold it back until
        // the pin is hovered or keyboard-focused. The accessible name, the
        // tooltip, the click target, and the marker order are identical in
        // both states, so nothing becomes unreachable.
        // Flipped to `always` by the zoom-aware pass below when this Place
        // earns a painted label at the current camera.
        const labelState = "on-demand";
        // PIN FACE (2026-10-22): ordinary = one small white core; Tempat
        // Pilihan = the gold ✦ on the same silhouette. Presentation only.
        const pinFace = isCurated
          ? `<span class="singgah-pin-star" aria-hidden>✦</span>`
          : `<span class="singgah-pin-core" aria-hidden></span>`;
        const placePin = `
          <div class="singgah-pin singgah-pin--${pinTone}" role="img" aria-label="Lihat ${escapeHtml(place.name)}" style="--pin-color:${pinColor};">
            <span class="singgah-pin-art">
              <span class="singgah-pin-head">${pinFace}</span>
            </span>
            <span class="singgah-pin-hit" aria-hidden></span>
            <span class="singgah-pin-label" ${PIN_LABEL_ON_DEMAND_ATTRIBUTE}="${labelState}" style="${PIN_LABEL_ANCHOR_STYLE}">${escapeHtml(place.name)}</span>
          </div>`;
        const marker = L.marker(position, {
          icon: L.divIcon({
            className: `singgah-map-marker${isHighlighted ? " is-highlighted" : ""}`,
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
          zIndexOffset: isHighlighted ? 2500 : isCurated ? 900 : live ? 0 : 500,
          keyboard: true,
        })
          .addTo(layer)
          // A base pin SELECTS its card (2026-10-18). The card remains the
          // navigation target; without a caller-provided selector the legacy
          // direct navigation is preserved.
          .on("click", () =>
            onSelectPlace ? onSelectPlace(place.id) : router.push(`/places/${place.id}`),
          );
        // Name tooltip on hover/focus/selection ONLY (curated and normal) —
        // Leaflet opens it on hover and keyboard focus; click still navigates
        // to the Place, so 20–50 dense pins never stack name labels.
        marker.bindTooltip(escapeHtml(place.name), {
          direction: "top",
          offset: [0, -40],
          opacity: 1,
        });
        const element = marker.getElement();
        if (element) markersByIdRef.current.set(place.id, element);
      }
      // Every chip starts held back, then the ONE projected pass paints the
      // labels this camera can carry — selected first, then curated, Live, and
      // canonical order, skipping any box that would collide.
      applyPinLabelStates(map, currentPlaces, liveByPlaceId, highlightedPlaceId);
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
    // would rebuild identical markers on unrelated state updates. The
    // highlight is part of the marker PAINT, so it must rebuild when it
    // changes; the callback is stable in the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, markerKey, highlightedPlaceId, onSelectPlace]);

  return (
    <div
      className="relative h-full w-full"
      style={
        { "--singgah-sheet-inset": `${Math.max(0, bottomInset)}px` } as React.CSSProperties
      }
    >
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
    </div>
  );
}
