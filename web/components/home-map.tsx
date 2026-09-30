"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CircleMarker, LayerGroup, Map as LeafletMap, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";

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
 * - Camera authority (PO, 2026-09-29 + 2026-09-30 map-coverage fix): ONE
 *   deterministic preset mechanism — every mode (1 km / 5 km / 10 km+ /
 *   "Tempat Pilihan") is a radius preset: the camera moves INSTANTLY (setView,
 *   animate: false — no animation) so the frame covers exactly that radius
 *   around the real Current Location. Preset radii are
 *   strictly ordered (1 < 5 < 12 < 50 km), so the derived zoom is strictly
 *   ordered the opposite way and is NEVER derived from the current zoom. A
 *   newly chosen preset always applies (deterministic refocus); manual pan/zoom
 *   wins between choices;
 *     · marker refreshes/API polling never move the camera;
 *     · the viewport is ALWAYS bounded to the chosen radius preset — the old
 *       one-shot marker fitBounds (which zoomed to a world view when no
 *       Current Location existed yet and the demo marker set was spread out)
 *       was REMOVED. With no real fix the map keeps the neutral world
 *       overview and NEVER auto-fits to the marker list.
 * - One container = one Leaflet instance: the container is claimed
 *   synchronously before the async import resolves (Strict Mode double-mount
 *   and fast route transitions cannot initialize twice), and teardown fully
 *   removes listeners, layers, and the map itself. invalidateSize() runs on
 *   init and window resize so mobile remounts never leave stacked tiles.
 * - Marker system (PO, 2026-09-29): ONE compact teardrop base pin for every
 *   Place. Modes are treatments of that base, never different models:
 *   Place biasa (brown) → Tempat Pilihan (secondary green + ✦ accent) →
 *   LIVE (live red, pulsing core, small LIVE chip, top z-priority, navigates
 *   to /live/[sessionId]). No emoji glyphs, no always-on name labels — names
 *   appear in hover/focus tooltips so dense maps stay readable.
 */
export type HomeMapPlace = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
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
   * THE camera preset (PO, 2026-09-29): when set, the camera moves
   * instantly so the frame covers exactly this radius around the real
   * Current Location —
   * through ONE deterministic radiusZoom mechanism shared by every mode
   * (1 km / 5 km / 10 km+ tabs and "Tempat Pilihan" 50 km). Strictly ordered
   * radii produce strictly ordered zoom levels, independent of the current
   * zoom. It is a CAMERA value only — the marker set is decided upstream and
   * this radius never filters Places.
   */
  cameraRadiusMeters?: number | null;
  /** "Tempat Pilihan" treatment on the SAME base Place marker. */
  curatedMarkers?: boolean;
  /**
   * Short one-shot focus pulse on the EXISTING Current Location pin when a
   * preset applies (instant-camera rule, PO 2026-09-30): the camera itself
   * moves instantly with NO animation, so entering "Tempat Pilihan" is made
   * visually obvious by this ~450 ms pin pulse instead. No new marker, no
   * marker redesign, no map animation; prefers-reduced-motion disables it.
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
};

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

const BRAND_BROWN = "var(--brand-accent)";
const BRAND_LIVE = "var(--live)";
const BRAND_PIN = "var(--brand-primary-deep)";
// Marker system colors (PO, 2026-09-29): ONE base Place pin (brand brown)
// with per-mode treatments — "Tempat Pilihan" uses the secondary brand
// green, LIVE uses the live red, and the Current Location disc keeps the
// deep brand green (BRAND_PIN) so the user marker never looks like a Place.
const BRAND_SECONDARY = "var(--brand-secondary)";

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
  curatedMarkers = false,
  pulsePinOnPresetChange = false,
  onViewportHasPlaces,
}: HomeMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  // The single OSM basemap — removed explicitly in teardown so no orphaned
  // tile layer can ever survive a remount (repeated/stale-tile guard).
  const tileLayerRef = useRef<TileLayer | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const userLayerRef = useRef<LayerGroup | null>(null);
  // Short pin focus feedback (instant-camera rule, PO 2026-09-30): refs for
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
  const lastViewportHasPlacesRef = useRef(false);

  const router = useRouter();
  const [ready, setReady] = useState(false);

  const viewerPositionKey = viewerPosition ? `${viewerPosition.lat},${viewerPosition.lng}` : "";

  // Every render, the LATEST callback is mirrored into the ref (in an effect,
  // never during render) so the map's long-lived moveend/zoomend listeners
  // can never capture a stale closure.
  useEffect(() => {
    onViewportHasPlacesRef.current = onViewportHasPlaces ?? null;
  }, [onViewportHasPlaces]);

  // Stable signature of the marker set (place ids + live session ids), so
  // the marker effect only re-runs when the set actually changes (the
  // discovery feed re-polls every 15 s).
  const markerKey = useMemo(
    () =>
      places
        .map((place) => `${place.id}:${liveByPlaceId.get(place.id)?.sessionId ?? ""}`)
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
    // Report ONLY on change — dedupes the burst of moveend/zoomend events a
    // gesture/flight can emit and prevents re-render storms.
    if (hasPlaces !== lastViewportHasPlacesRef.current) {
      lastViewportHasPlacesRef.current = hasPlaces;
      report(hasPlaces);
    }
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
    const element = userPinRef.current?.getElement?.();
    if (!element) return;
    locatePulseUntilRef.current = Date.now() + 450;
    if (locatePulseTimerRef.current !== null) clearTimeout(locatePulseTimerRef.current);
    element.classList.remove("singgah-locate-pulse");
    // Force a reflow so a pulse restarted mid-cycle runs completely.
    void element.getBoundingClientRect();
    element.classList.add("singgah-locate-pulse");
    locatePulseTimerRef.current = setTimeout(() => {
      locatePulseTimerRef.current = null;
      userPinRef.current?.getElement?.()?.classList.remove("singgah-locate-pulse");
    }, 450);
  }, []);

  // Jump to the real user position WITHOUT changing the frame width —
  // INSTANTLY (setView with animate: false; no duration/easing/animation).
  // Used ONLY by the no-preset paths (cameraRadiusMeters === null, which no
  // Home mode reaches): the one-shot focus and its locate recenter. With a
  // preset active, "Lokasi Saya" recentres through radiusZoom instead (see
  // the locate effect) so the ACTIVE preset radius stays the camera
  // authority. The pin pulse marks the focus point either way.
  const focusUser = useCallback(
    (map: LeafletMap, position: { lat: number; lng: number }) => {
      programmaticMoveRef.current = true;
      map.setView([position.lat, position.lng], Math.max(map.getZoom(), 15), { animate: false });
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
      // and touch zoom (single basemap, no layer selector).
      L.control.zoom({ position: "topright" }).addTo(map);

      map.on("moveend", () => {
        programmaticMoveRef.current = false;
        // Viewport-aware empty state (PO, 2026-09-30): every FINISHED move —
        // two-finger pan, pinch zoom, zoom control, or a programmatic preset
        // flight — re-evaluates whether a Place sits in the viewport.
        // Leaflet fires moveend once per gesture, never continuously during
        // it, so updates stay cheap. zoomend arrives right after moveend for
        // zooms (idempotent: it reports only on change).
        evaluateViewportStatus();
      });
      map.on("zoomend", evaluateViewportStatus);
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
        }
      }, 150);
    })();

    const onWindowResize = () => {
      const map = mapRef.current;
      if (map) invalidate(map);
      // Resize changes the visible viewport without any map move —
      // re-evaluate (evaluateViewportStatus is stable, [] deps).
      evaluateViewportStatus();
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      setReady(false);
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      if (locatePulseTimerRef.current !== null) clearTimeout(locatePulseTimerRef.current);
      locatePulseTimerRef.current = null;
      window.removeEventListener("resize", onWindowResize);
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

  // Camera anchor: Current Location is the map's center. EVERY mode is a
  // cameraRadiusMeters preset (distance tabs from CAMERA_PRESET_RADIUS_M,
  // "Tempat Pilihan" = curated 50 km): a new preset ALWAYS refocuses
  // deterministically through the one radiusZoom mechanism — zoom is derived
  // from the preset radius, never from the current zoom, and the frame is
  // ALWAYS bounded to that preset (never fit to the marker list). Manual
  // pan/zoom wins between choices (latch re-arms on each new preset choice).
  // Without a preset (no Home mode produces this) the one-shot focus on the
  // real fix keeps its behavior; markers never drive the viewport.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !viewerPosition) return;
    if (userInteractedRef.current && lastRadiusRef.current === cameraRadiusMeters) return;

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
        if (radiusChanged) userInteractedRef.current = false;
        const zoom = await radiusZoom(map, viewerPosition, cameraRadiusMeters);
        if (cancelled || mapRef.current !== map || userInteractedRef.current) return;
        programmaticMoveRef.current = true;
        map.setView([viewerPosition.lat, viewerPosition.lng], Math.max(2, zoom), { animate: false });
        if (radiusChanged && pulsePinOnPresetChange) triggerLocatePulse();
        return;
      }
      // No preset at all (cameraRadiusMeters === null): focus the actual
      // location once — no radius re-zoom, and marker refreshes never
      // re-center afterwards.
      if (!autoFocusedRef.current) {
        autoFocusedRef.current = true;
        focusUser(map, viewerPosition);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, viewerPositionKey, cameraRadiusMeters, viewerPosition, focusUser, radiusZoom, pulsePinOnPresetChange, triggerLocatePulse]);

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
      const accuracy = viewerPosition.accuracy ?? 0;
      if (Number.isFinite(accuracy) && accuracy > 0) {
        L.circle([viewerPosition.lat, viewerPosition.lng], {
          radius: accuracy,
          color: BRAND_BROWN,
          weight: 1,
          fillColor: BRAND_BROWN,
          fillOpacity: 0.12,
        }).addTo(layer);
      }
      // Current Location marker — unmistakably the USER's position and never
      // mistakable for a Place pin: a white-core dot in a deep brand-green
      // disc with a white ring (Place pins are the inverse: brown disc, emoji
      // glyph, name label; LIVE pins are the red badge). No click behavior —
      // it is not a navigation target.
      userPinRef.current = L.circleMarker([viewerPosition.lat, viewerPosition.lng], {
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

  // "Lokasi Saya": explicit recenter on the latest fix. When a preset is
  // active (EVERY Home mode: 1 km / 5 km / 10 km+ / Tempat Pilihan), the
  // recenter applies through the SAME canonical radiusZoom mechanism — the
  // ACTIVE preset radius stays the camera authority, so the frame keeps
  // covering exactly that radius around the newest real fix. The camera
  // application is INSTANT (setView, animate: false — no duration, no
  // easing, no animation); the action is visually confirmed by the one-shot
  // pin pulse, never by animating the map. The old arbitrary
  // Math.max(getZoom(), 15) zoom broke the active preset (e.g. it shattered
  // Tempat Pilihan's 50 km frame). No marker fitBounds, no mode/filter
  // change, no invented position. Only the null-preset path (no Home mode
  // reaches it) keeps the existing zoom-preserving focus. If the fix has not
  // arrived yet, the request stays pending and resolves in the anchor effect
  // above once geolocation returns.
  useEffect(() => {
    const map = mapRef.current;
    if (!locateNonce || lastLocateNonceRef.current === locateNonce) return;
    lastLocateNonceRef.current = locateNonce;
    locatePendingRef.current = true;
    if (!ready || !map || !viewerPosition) return;
    locatePendingRef.current = false;
    if (cameraRadiusMeters !== null) {
      let cancelled = false;
      (async () => {
        const zoom = await radiusZoom(map, viewerPosition, cameraRadiusMeters);
        if (cancelled || mapRef.current !== map) return;
        programmaticMoveRef.current = true;
        map.setView([viewerPosition.lat, viewerPosition.lng], Math.max(2, zoom), { animate: false });
        triggerLocatePulse();
      })();
      return () => {
        cancelled = true;
      };
    }
    focusUser(map, viewerPosition);
  }, [locateNonce, ready, viewerPosition, cameraRadiusMeters, focusUser, radiusZoom, triggerLocatePulse]);

  // Rebuild markers whenever the filtered marker set changes. Camera note:
  // the viewport is NEVER driven by the marker set — no marker fitBounds
  // exists anywhere in this component (map-coverage fix, 2026-09-30). When no
  // Current Location fix exists yet the map stays on the neutral world
  // overview until the real fix arrives; with a fix the bounded radius
  // preset owns the camera. Marker refreshes (markerKey effect) never move
  // the camera at all.
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

        // THE base Place marker (PO, 2026-09-29): one compact teardrop for
        // every Place — brown in normal mode, with the "Tempat Pilihan"
        // treatment (secondary green + ✦ accent) on the SAME shape. No emoji,
        // no always-on name label: the name appears in a tooltip on
        // hover/focus/selection (decluttered dense maps). A Place that is
        // Live keeps its normal pin right next to its LIVE pin.
        const pinColor = curatedMarkers ? BRAND_SECONDARY : BRAND_BROWN;
        const accent = curatedMarkers
          ? `<span style="transform:rotate(45deg);color:#fff;font-size:13px;line-height:1;">✦</span>`
          : "";
        const placePin = `
          <div role="img" aria-label="Lihat ${escapeHtml(place.name)}" style="transform:translate(-50%,-100%);width:28px;height:36px;filter:drop-shadow(0 2px 3px rgb(0 0 0 / 0.3));">
            <div style="position:absolute;left:50%;top:0;transform:translateX(-50%) rotate(-45deg);width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:9999px 9999px 9999px 0;border:2px solid #fff;background:${pinColor};">
              ${accent}
            </div>
            <div style="position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:5px;height:5px;border-radius:9999px;background:${pinColor};box-shadow:0 0 0 2px rgb(255 255 255 / 0.9);"></div>
          </div>`;
        const marker = L.marker(position, {
          icon: L.divIcon({
            className: "singgah-map-marker",
            iconSize: [0, 0],
            html: placePin,
          }),
          zIndexOffset: live ? 0 : 500,
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
          root cause of tiles covering the empty-state card on mobile drag. */}
      <div
        ref={containerRef}
        className="relative z-0 h-full w-full touch-none"
        aria-label="Peta Tempat"
      />
      {/* Map UI overlays ride ABOVE Leaflet's documented z-index ceiling
          (max control z-index = 1000): 1100+ keeps the React layer strictly
          on top in any drag/zoom state. */}
      <button
        type="button"
        onClick={onRequestLocate}
        className="absolute right-3 top-[76px] z-[1100] inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2.5 text-xs font-bold text-brand-ink shadow-lg ring-1 ring-brand-ink/10 transition hover:bg-brand-cream"
        aria-label="Kembali ke lokasi aktual saya"
      >
        <span aria-hidden className="h-2 w-2 rounded-full bg-brand-accent" />
        Lokasi Saya
      </button>
    </div>
  );
}
