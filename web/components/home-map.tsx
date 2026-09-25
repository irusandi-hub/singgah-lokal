"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Real interactive map for Home discovery.
 * - Tiles: OpenStreetMap (attribution required). ONE basemap — no
 *   terrain/satellite/layer selector; pan, +/- zoom, scroll and touch zoom
 *   are all functional.
 * - Markers come ONLY from canonical Place lat/lng — a Place without
 *   coordinates never receives a marker (fail-closed, no invented position).
 * - Current Location is a first-class function: the real browser geolocation
 *   position is shown as a user marker and the map centers on it. The
 *   neutral Indonesia-overview center is viewport-only fallback — it is
 *   never treated as the user's position.
 * - Camera authority: automatic marker refreshes and the initial fitBounds
 *   never move the map again after the user pans/zooms or presses
 *   "Lokasi Saya" (programmatic flights are excluded from that rule).
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
}: HomeMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
  const userLayerRef = useRef<LayerGroup | null>(null);
  // Camera authority refs. After a real user pan/zoom — or an explicit
  // "Lokasi Saya" flight — automatic refreshes/fitBounds never move the map
  // again. Programmatic camera moves set programmaticMoveRef so they are not
  // mistaken for user interaction.
  const userInteractedRef = useRef(false);
  const programmaticMoveRef = useRef(false);
  const cameraDecidedRef = useRef(false);
  const locatePendingRef = useRef(false);
  const lastLocateNonceRef = useRef(0);
  const router = useRouter();
  const [ready, setReady] = useState(false);

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

  // Create the map once. Leaflet touches window, so it is imported
  // dynamically inside the effect (safe for SSR of this client component).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, {
        // Neutral overview until markers/user position define the viewport;
        // NEVER a stand-in for the user's position.
        center: [-2.5, 118],
        zoom: 5,
        zoomControl: false,
        scrollWheelZoom: true,
        attributionControl: true,
      });
      L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);

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
      setReady(true);
    })();

    return () => {
      cancelled = true;
      setReady(false);
      markerLayerRef.current?.remove();
      markerLayerRef.current = null;
      userLayerRef.current?.remove();
      userLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Current Location: render/update the user marker from the real
  // geolocation fix and center the map on it while the user has not taken
  // over the camera. A pending "Lokasi Saya" request always wins.
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

      if (locatePendingRef.current) {
        locatePendingRef.current = false;
        flyToUser(map, viewerPosition);
      } else if (!userInteractedRef.current) {
        flyToUser(map, viewerPosition);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, viewerPosition, flyToUser]);

  // "Lokasi Saya": explicit recenter on the latest fix. If the fix has not
  // arrived yet, the request stays pending and resolves in the effect above
  // once geolocation returns.
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
  // fitBounds is a one-shot initial overview — it never runs again after
  // the user position centered the map or the user moved the camera.
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

      if (points.length > 0 && !cameraDecidedRef.current && !userInteractedRef.current) {
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
      <div ref={containerRef} className="h-full w-full" aria-label="Peta Place" />
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
