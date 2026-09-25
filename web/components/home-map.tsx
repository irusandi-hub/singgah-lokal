"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LayerGroup, Map as LeafletMap, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Real interactive map for Home discovery.
 * - Tiles: OpenStreetMap (attribution required). ONE basemap — no
 *   terrain/satellite/layer selector; pan, +/- zoom, scroll and touch zoom
 *   are all functional.
 * - Markers come ONLY from canonical Place lat/lng — a Place without
 *   coordinates never receives a marker (fail-closed, no invented position).
 * - Current Location is the map's anchor: the real browser geolocation fix
 *   becomes the camera center. There is NO fallback viewport and NO invented
 *   user position — before the first real fix the map starts on the neutral
 *   world overview (fitWorld), never on a stand-in country view.
 * - Camera authority:
 *     · when a bounded distance filter is active (500 m / 1 km / 5 km) the
 *       zoom is derived from the filter radius around Current Location;
 *     · "10 km+" is unbounded and never re-zooms the camera;
 *     · marker refreshes/API polling never move the camera;
 *     · the one-shot marker fitBounds runs ONLY while no Current Location
 *       exists and is re-checked after its async import so it can never race
 *       (or override) the real user fix.
 * - One container = one Leaflet instance: the container is claimed
 *   synchronously before the async import resolves (Strict Mode double-mount
 *   and fast route transitions cannot initialize twice), and teardown fully
 *   removes listeners, layers, and the map itself. invalidateSize() runs on
 *   init and window resize so mobile remounts never leave stacked tiles.
 * - Marker click navigates to /places/[id]; a Place with an active Live
 *   session shows a LIVE overlay pin that navigates to /live/[sessionId].
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
  /** Active distance-filter radius in meters; null = unbounded ("10 km+"). */
  radiusMeters: number | null;
};

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

const BRAND_BROWN = "var(--brand-accent)";
const BRAND_LIVE = "var(--live)";

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
  radiusMeters,
}: HomeMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  // The single OSM basemap — removed explicitly in teardown so no orphaned
  // tile layer can ever survive a remount (repeated/stale-tile guard).
  const tileLayerRef = useRef<TileLayer | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const userLayerRef = useRef<LayerGroup | null>(null);
  // Camera authority refs. After a real user pan/zoom automatic refreshes
  // never move the map again; programmatic flights set programmaticMoveRef so
  // they are not mistaken for user interaction. cameraDecidedRef latches the
  // first automatic camera decision (user fix or marker fitBounds).
  const userInteractedRef = useRef(false);
  const programmaticMoveRef = useRef(false);
  const cameraDecidedRef = useRef(false);
  const locatePendingRef = useRef(false);
  const lastLocateNonceRef = useRef(0);
  // Latest fix readable from async callbacks (fitBounds race guard).
  const viewerPositionRef = useRef<HomeMapViewer | null>(null);
  const router = useRouter();
  const [ready, setReady] = useState(false);

  const viewerPositionKey = viewerPosition ? `${viewerPosition.lat},${viewerPosition.lng}` : "";

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

  // Fly to the real user position. Marks the camera as decided so marker
  // refreshes cannot take the viewport back afterwards.
  const flyToUser = useCallback((map: LeafletMap, position: { lat: number; lng: number }) => {
    programmaticMoveRef.current = true;
    cameraDecidedRef.current = true;
    map.flyTo([position.lat, position.lng], Math.max(map.getZoom(), 15), { duration: 0.8 });
  }, []);

  // Zoom that fits a distance-filter radius around Current Location.
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

  // Radius refocus (500 m / 1 km / 5 km): ALWAYS re-derives the camera from
  // the filter radius around the real Current Location — every tab switch to
  // a bounded radius refocuses (no one-shot latch), unless the user has
  // interacted since the last filter change (their pan/zoom wins until the
  // next explicit filter choice). "10 km+" is unbounded and never re-zooms.
  const lastRadiusRef = useRef<number | null>(null);

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

      const map = L.map(container, {
        // Neutral world overview until the real Current Location fix (or, in
        // its absence, the one-shot marker fitBounds) defines the viewport.
        // There is deliberately NO country fallback and NO invented position.
        zoomControl: false,
        scrollWheelZoom: true,
        attributionControl: true,
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
      });
      map.on("dragstart", () => {
        if (!programmaticMoveRef.current) userInteractedRef.current = true;
      });
      map.on("zoomstart", () => {
        if (!programmaticMoveRef.current) userInteractedRef.current = true;
      });

      mapRef.current = map;
      markerLayerRef.current = L.layerGroup().addTo(map);
      userLayerRef.current = L.layerGroup().addTo(map);
      container.dataset.singgahMap = "ready";
      setReady(true);

      // Mobile layout timing: panes can measure before the section settles.
      // invalidateSize() after init (and on every window resize) prevents
      // visually stacked tiles/layers on phones.
      invalidateTimer = setTimeout(() => {
        if (mapRef.current === map) invalidate(map);
      }, 150);
    })();

    const onWindowResize = () => {
      const map = mapRef.current;
      if (map) invalidate(map);
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      setReady(false);
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      window.removeEventListener("resize", onWindowResize);
      const container = containerRef.current;
      if (container) container.dataset.singgahMap = "";
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
  }, []);

  // Camera anchor: Current Location is the map's center. A bounded radius
  // (500 m / 1 km / 5 km) refocuses on EVERY change of the filter radius —
  // the camera is re-derived from the filter around the real fix. "10 km+"
  // focuses once (unbounded — no radius re-zoom). Automatic moves never
  // steal the camera after real user interaction, and interactions are
  // re-armed when a new radius is chosen so the next bounded tab can
  // refocus. One-shot overviews (fitBounds / 10 km+ focus) stay one-shot via
  // cameraDecidedRef.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !viewerPosition) return;
    if (userInteractedRef.current && lastRadiusRef.current === radiusMeters) return;

    const radiusChanged = lastRadiusRef.current !== radiusMeters;
    lastRadiusRef.current = radiusMeters;

    let cancelled = false;
    (async () => {
      if (radiusMeters !== null) {
        if (radiusChanged) userInteractedRef.current = false;
        const zoom = await radiusZoom(map, viewerPosition, radiusMeters);
        if (cancelled || mapRef.current !== map || userInteractedRef.current) return;
        programmaticMoveRef.current = true;
        cameraDecidedRef.current = true;
        map.flyTo([viewerPosition.lat, viewerPosition.lng], Math.max(3, zoom), { duration: 0.8 });
        return;
      }
      // Unbounded ("10 km+"): focus the actual location once — no radius
      // re-zoom, and marker refreshes never re-center afterwards.
      if (!cameraDecidedRef.current) {
        flyToUser(map, viewerPosition);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, viewerPositionKey, radiusMeters, viewerPosition, flyToUser, radiusZoom]);

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
      L.circleMarker([viewerPosition.lat, viewerPosition.lng], {
        radius: 9,
        color: "#ffffff",
        weight: 3,
        fillColor: BRAND_BROWN,
        fillOpacity: 1,
      })
        .addTo(layer)
        .bindTooltip("Lokasi Anda", { direction: "top", offset: [0, -10] });
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, viewerPosition]);

  // "Lokasi Saya": explicit recenter on the latest fix. If the fix has not
  // arrived yet, the request stays pending and resolves in the anchor effect
  // above once geolocation returns.
  useEffect(() => {
    const map = mapRef.current;
    if (!locateNonce || lastLocateNonceRef.current === locateNonce) return;
    lastLocateNonceRef.current = locateNonce;
    locatePendingRef.current = true;
    if (ready && map && viewerPosition) {
      locatePendingRef.current = false;
      flyToUser(map, viewerPosition);
    }
  }, [locateNonce, ready, viewerPosition, flyToUser]);

  // Rebuild markers whenever the filtered marker set changes. Camera note:
  // fitBounds is a one-shot initial overview that runs ONLY while no Current
  // Location exists. The condition is re-checked after the async import so a
  // fix that arrives in between can never race it; after the first automatic
  // decision (or any user interaction) it never runs again.
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
      if (currentPlaces.length === 0) return;

      const points: [number, number][] = [];

      for (const place of currentPlaces) {
        if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
        const position: [number, number] = [place.latitude, place.longitude];
        points.push(position);
        const live = liveByPlaceId.get(place.id);

        // LIVE overlay pin — a live-state badge on the same canonical
        // Place coordinate, never a fabricated position.
        if (live) {
          const liveTitle = escapeHtml(live.processTitle ?? place.name);
          L.marker(position, {
            icon: L.divIcon({
              className: "singgah-map-marker",
              iconSize: [0, 0],
              html: `<div role="img" aria-label="Lihat Live di ${escapeHtml(place.name)}" style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:4px;">
                <div style="display:flex;height:48px;width:48px;align-items:center;justify-content:center;border-radius:9999px;border:4px solid #fff;background:${BRAND_LIVE};color:#fff;font-size:10px;font-weight:900;letter-spacing:0.05em;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.3);">LIVE</div>
                <div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:9999px;background:${BRAND_LIVE};padding:4px 10px;color:#fff;font-size:11px;font-weight:700;box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.2);">${liveTitle}</div>
              </div>`,
            }),
            zIndexOffset: 1000,
            keyboard: true,
          })
            .addTo(layer)
            .on("click", () => router.push(`/live/${live.sessionId}`));
        }

        // Place pin → /places/[id].
        L.marker(position, {
          icon: L.divIcon({
            className: "singgah-map-marker",
            iconSize: [0, 0],
            html: `<div role="img" aria-label="Lihat ${escapeHtml(place.name)}" style="transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:4px;">
              <div style="display:flex;height:48px;width:48px;align-items:center;justify-content:center;border-radius:9999px;border:4px solid #fff;background:${BRAND_BROWN};font-size:18px;box-shadow:0 10px 15px -3px rgb(0 0 0 / 0.3);">📍</div>
              <div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:9999px;background:#fff;padding:4px 10px;font-size:11px;font-weight:700;color:var(--brand-ink);box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.2);">${escapeHtml(place.name)}</div>
            </div>`,
          }),
          zIndexOffset: live ? 0 : 500,
          keyboard: true,
        })
          .addTo(layer)
          .on("click", () => router.push(`/places/${place.id}`));
      }

      if (
        points.length > 0 &&
        !viewerPositionRef.current &&
        !cameraDecidedRef.current &&
        !userInteractedRef.current
      ) {
        cameraDecidedRef.current = true;
        programmaticMoveRef.current = true;
        map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 16 });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, markerKey, places, liveByPlaceId, router]);

  return (
    <div className="relative h-full w-full">
      {/* touch-none keeps drag/pinch inside the map container so page
          scroll/navigation never hijacks a map gesture. */}
      <div ref={containerRef} className="h-full w-full touch-none" aria-label="Peta Place" />
      <button
        type="button"
        onClick={onRequestLocate}
        className="absolute right-3 top-[76px] z-[800] inline-flex items-center gap-1.5 rounded-full bg-white/95 px-4 py-2.5 text-xs font-bold text-brand-ink shadow-md transition hover:bg-white"
        aria-label="Kembali ke lokasi aktual saya"
      >
        <span aria-hidden className="h-2 w-2 rounded-full bg-brand-accent" />
        Lokasi Saya
      </button>
    </div>
  );
}
