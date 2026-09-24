"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LayerGroup, Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";

/**
 * Real interactive map for Home discovery (replaces the CSS mock map).
 * - Tiles: OpenStreetMap (attribution required).
 * - Markers come ONLY from canonical Place lat/lng — a Place without
 *   coordinates never receives a marker (fail-closed, no invented position).
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

type HomeMapProps = {
  places: HomeMapPlace[];
  liveByPlaceId: Map<string, HomeMapLive>;
};

const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

const BRAND_BROWN = "--brand-accent";
const BRAND_LIVE = "--live";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export default function HomeMap({ places, liveByPlaceId }: HomeMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerLayerRef = useRef<LayerGroup | null>(null);
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

  // Create the map once. Leaflet touches window, so it is imported
  // dynamically inside the effect (safe for SSR of this client component).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, {
        // Neutral overview until markers define the viewport; never a
        // Place coordinate — Places without coordinates stay unmarked.
        center: [-2.5, 118],
        zoom: 5,
        zoomControl: false,
        scrollWheelZoom: false,
        attributionControl: true,
      });
      L.tileLayer(OSM_TILE_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19 }).addTo(map);

      mapRef.current = map;
      markerLayerRef.current = L.layerGroup().addTo(map);
      setReady(true);
    })();

    return () => {
      cancelled = true;
      setReady(false);
      markerLayerRef.current?.remove();
      markerLayerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // Rebuild markers whenever the filtered marker set changes.
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
              <div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:9999px;background:#fff;padding:4px 10px;font-size:11px;font-weight:700;color:--brand-ink;box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.2);">${escapeHtml(place.name)}</div>
            </div>`,
          }),
          zIndexOffset: live ? 0 : 500,
          keyboard: true,
        })
          .addTo(layer)
          .on("click", () => router.push(`/places/${place.id}`));
      }

      if (points.length > 0) {
        map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 16 });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, markerKey, places, liveByPlaceId, router]);

  return <div ref={containerRef} className="h-full w-full" aria-label="Peta Place" />;
}
