"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker } from "leaflet";
import "leaflet/dist/leaflet.css";

type Props = {
  latitude: string;
  longitude: string;
  onChange: (latitude: string, longitude: string) => void;
};

const DEFAULT_CENTER: [number, number] = [-2.5, 118];

export default function PlaceLocationPicker({ latitude, longitude, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const changeRef = useRef(onChange);

  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;

      const hasCoordinates =
        Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude));

      const center: [number, number] = hasCoordinates
        ? [Number(latitude), Number(longitude)]
        : DEFAULT_CENTER;

      const map = L.map(containerRef.current, {
        center,
        zoom: hasCoordinates ? 16 : 5,
        scrollWheelZoom: true,
      });

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);

      const setMarker = (lat: number, lng: number) => {
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        if (!markerRef.current) {
          markerRef.current = L.marker([lat, lng], { draggable: true }).addTo(map);
          markerRef.current.on("dragend", () => {
            const position = markerRef.current?.getLatLng();
            if (!position) return;
            changeRef.current(position.lat.toString(), position.lng.toString());
          });
        } else {
          markerRef.current.setLatLng([lat, lng]);
        }
      };

      if (hasCoordinates) setMarker(Number(latitude), Number(longitude));

      map.on("click", (event) => {
        setMarker(event.latlng.lat, event.latlng.lng);
        changeRef.current(event.latlng.lat.toString(), event.latlng.lng.toString());
      });

      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    if (!markerRef.current) {
      import("leaflet").then(({ default: L }) => {
        if (!mapRef.current || markerRef.current) return;
        markerRef.current = L.marker([lat, lng], { draggable: true }).addTo(map);
        markerRef.current.on("dragend", () => {
          const position = markerRef.current?.getLatLng();
          if (!position) return;
          changeRef.current(position.lat.toString(), position.lng.toString());
        });
      });
      return;
    }

    const current = markerRef.current.getLatLng();
    if (current.lat !== lat || current.lng !== lng) {
      markerRef.current.setLatLng([lat, lng]);
    }
  }, [latitude, longitude]);

  return (
    <div className="grid gap-2">
      <div
        ref={containerRef}
        className="h-72 w-full overflow-hidden rounded-xl border border-black/10"
        aria-label="Pilih lokasi Place pada peta"
      />
      <p className="text-xs text-black/55">
        Klik peta atau geser marker untuk menentukan koordinat Place.
      </p>
    </div>
  );
}
