"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import HomeMap, { type HomeMapPlace } from "@/components/home-map";
import type { Place } from "@/lib/places";
import {
  DISTANCE_FILTERS,
  distanceMeters,
  formatDistance,
  liveDurationLabel,
  matchesDistance,
  type DistanceFilter,
  type LiveDiscoveryItem,
} from "@/lib/live/ui";

export default function Home() {
  // Locked Home filter bar (PO decision 2026-09-20, Policy §12.5 #1):
  // LIVE first/leftmost, then distance radii only. LIVE is a process/status
  // filter (Places with a live session), not a time or category filter.
  // Default = the unbounded filter so nothing is hidden on first load.
  const [distanceFilter, setDistanceFilter] = useState<DistanceFilter>("10 km+");
  const [liveOnly, setLiveOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [liveItems, setLiveItems] = useState<LiveDiscoveryItem[]>([]);
  // Viewer position (card distance only — PO item 7: distance "bila
  // tersedia"). Geolocation is optional and silently absent when denied.
  const [viewerPosition, setViewerPosition] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    fetch("/api/places")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Places could not be loaded"))))
      .then((loadedPlaces: Place[]) => setPlaces(loadedPlaces))
      .catch(() => setPlaces([]));
  }, []);

  // LIVE discovery feed (canonical live_sessions, published Places only).
  useEffect(() => {
    const load = () =>
      fetch("/api/live/discovery")
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Live discovery unavailable"))))
        .then((payload: { live: LiveDiscoveryItem[] }) => setLiveItems(payload.live ?? []))
        .catch(() => setLiveItems([]));

    load();
    const interval = window.setInterval(load, 15000);
    return () => window.clearInterval(interval);
  }, []);

  // Real viewer position when permission is granted; no fallback point is
  // ever invented — without a position (or Place coordinates) no distance
  // label is shown (PO: no fake positions).
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setViewerPosition({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => undefined,
      { timeout: 8000 },
    );
  }, []);

  const liveByPlaceId = useMemo(() => {
    const map = new Map<string, LiveDiscoveryItem>();
    liveItems.forEach((item) => {
      if (!map.has(item.placeId)) map.set(item.placeId, item);
    });
    return map;
  }, [liveItems]);

  const visiblePlaces = useMemo(() => {
    // Distance filter first (same gate for markers, Place list, and LIVE).
    // Bounded radii match only on viewerPosition + canonical Place lat/lng
    // (PO item 6): without a real position or coordinates the Place stays
    // visible only under the unbounded filter — a position is never invented.
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase("id-ID");

    const searchFiltered = places.filter((place) => {
      if (!normalizedQuery) return true;

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

    const distanceFiltered = searchFiltered.filter((place) =>
      matchesDistance(
        distanceFilter,
        viewerPosition,
        place.latitude !== null && place.longitude !== null
          ? { lat: place.latitude, lng: place.longitude }
          : null,
      ),
    );
    // LIVE filter second: a process/status filter — only Places with an
    // active session, further narrowed by the same distance gate above.
    if (liveOnly) return distanceFiltered.filter((place) => liveByPlaceId.has(place.id));
    return distanceFiltered;
  }, [places, searchQuery, distanceFilter, liveOnly, liveByPlaceId, viewerPosition]);

  const liveCards = useMemo(
    () => liveItems.filter((item) => visiblePlaces.some((place) => place.id === item.placeId)),
    [liveItems, visiblePlaces],
  );

  // Map markers come ONLY from canonical Place coordinates — a Place
  // without lat/lng is never invented onto the map (fail-closed).
  const mapPlaces = useMemo<HomeMapPlace[]>(
    () =>
      visiblePlaces.flatMap((place) =>
        place.latitude !== null && place.longitude !== null
          ? [{ id: place.id, name: place.name, latitude: place.latitude, longitude: place.longitude }]
          : [],
      ),
    [visiblePlaces],
  );

  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#20231f]">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-black/5 bg-[#f7f5ef]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div>
            <div className="text-xl font-black tracking-tight">
              SINGGAH<span className="text-[#7b5b38]"> LOKAL</span>
            </div>
            <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-black/45">
              Temukan cerita di balik tempat
            </div>
          </div>

        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pb-10 pt-4">
        {/* Search */}
        <div className="relative mb-4">
          <div className="flex items-center gap-3 rounded-2xl border border-black/10 bg-white px-4 py-4 shadow-sm">
            <span className="text-lg">⌕</span>
            <input
              className="w-full bg-transparent text-sm outline-none placeholder:text-black/40"
              placeholder="Cari tempat, cerita, produksi..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Cari tempat, cerita, produksi"
            />
          </div>
        </div>

        {/* Home filter bar — locked set (PO 2026-09-20, Policy §12.5 #1):
            LIVE first/leftmost (process/status filter), then distance only. */}
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setLiveOnly((value) => !value)}
            aria-pressed={liveOnly}
            className={`mr-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-black tracking-wide transition ${
              liveOnly
                ? "bg-[#b3261e] text-white"
                : "border border-[#b3261e]/40 bg-white text-[#b3261e]"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${liveOnly ? "bg-white" : "bg-[#b3261e]"}`} />
            LIVE
          </button>
          {DISTANCE_FILTERS.map((filter) => (
            <button
              key={filter}
              onClick={() => setDistanceFilter(filter)}
              className={`whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-bold transition ${
                distanceFilter === filter
                  ? "bg-[#7b5b38] text-white"
                  : "border border-black/10 bg-white text-black/65"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* LIVE SEKARANG cards */}
        {liveCards.length > 0 && (
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {liveCards.map((item) => {
              const place = places.find((candidate) => candidate.id === item.placeId);
              // Distance from the REAL viewer position to canonical Place
              // coordinates only (PO item 7). Omitted when either side is
              // unavailable — never computed from an invented reference point.
              const distance =
                viewerPosition && place?.latitude != null && place?.longitude != null
                  ? formatDistance(distanceMeters(viewerPosition, { lat: place.latitude, lng: place.longitude }))
                  : null;
              return (
                <Link
                  key={item.sessionId}
                  href={`/live/${item.sessionId}`}
                  className="group rounded-2xl border border-[#b3261e]/30 bg-white p-4 shadow-sm transition hover:shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-[#b3261e] px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-white">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                      Live Sekarang
                    </span>
                    <span className="text-[10px] font-bold text-black/45">
                      {liveDurationLabel(item.startedAt)} • {item.viewerPeak}/100
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-black">{item.processTitle ?? "Proses produksi"}</p>
                  <p className="mt-0.5 text-xs text-black/55">
                    {place?.name ?? item.placeName} • {place?.area ?? ""}
                  </p>
                  <p className="mt-2 text-[11px] font-bold text-[#7b5b38]">
                    {distance ? `${distance} • ` : ""}
                    {place?.type === "production" ? "Sedang berproduksi" : "Sedang aktif"}
                  </p>
                </Link>
              );
            })}
          </div>
        )}

        {/* Map-first discovery — real interactive Leaflet map (OpenStreetMap).
            isolate keeps Leaflet panes contained below the UI overlays. */}
        <section className="relative isolate h-[58vh] min-h-[430px] overflow-hidden rounded-[28px] border border-black/10 bg-[#d9dfd2] shadow-sm">
          <HomeMap places={mapPlaces} liveByPlaceId={liveByPlaceId} />

          {/* Clear empty state when no visible Place carries canonical
              coordinates — positions are never invented. */}
          {mapPlaces.length === 0 && (
            <div className="absolute inset-x-6 top-1/2 z-10 -translate-y-1/2 rounded-2xl bg-white/95 p-4 text-center shadow-md">
              <p className="text-sm font-bold">Belum ada Place dengan koordinat di peta</p>
              <p className="mt-1 text-xs text-black/55">
                Peta hanya menampilkan Place dengan koordinat resmi. Place lain tetap ada di daftar.
              </p>
            </div>
          )}

          <div className="absolute left-5 top-5 z-10 rounded-full bg-white/90 px-4 py-2 text-xs font-bold shadow-sm">
            {liveOnly ? "LIVE • " : ""}
            {distanceFilter}
          </div>

          {/* Location button */}
          <button className="absolute bottom-[190px] right-5 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-white text-lg shadow-lg">
            ◎
          </button>

          {/* Bottom sheet */}
          {visiblePlaces[0] && (
            <div className="absolute bottom-0 left-0 right-0 z-20 rounded-t-[28px] bg-white p-5 shadow-[0_-10px_30px_rgba(0,0,0,0.12)]">
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-black/15" />

              <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">
                Tempat pilihan
              </div>

              <h2 className="text-2xl font-black tracking-tight">
                {visiblePlaces[0].name}
              </h2>

              <p className="mt-1 text-sm text-black/55">
                {visiblePlaces[0].type} • {visiblePlaces[0].area}
              </p>

              <p className="mt-3 text-sm leading-6 text-black/70">
                Kenali tempat, lihat bagaimana sesuatu dibuat, lalu tentukan
                apakah kamu ingin singgah.
              </p>

              {liveByPlaceId.has(visiblePlaces[0].id) && (
                <Link
                  href={`/live/${liveByPlaceId.get(visiblePlaces[0].id)!.sessionId}`}
                  className="mt-4 block w-full rounded-2xl bg-[#b3261e] py-4 text-center text-sm font-bold text-white"
                >
                  Lihat Live Sekarang
                </Link>
              )}

              <Link href={`/places/${visiblePlaces[0].id}`} className="mt-3 block w-full rounded-2xl bg-[#20231f] py-4 text-center text-sm font-bold text-white">
                Lihat Tempat
              </Link>
            </div>
          )}
        </section>

        {/* Intro */}
        <section className="px-1 pb-4 pt-8">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#7b5b38]">
            SINGGAH LOKAL
          </p>
          <h1 className="mt-2 max-w-xl text-3xl font-black leading-tight tracking-tight sm:text-4xl">
            Jangan hanya datang.
            <br />
            Kenali ceritanya.
          </h1>
        </section>
      </section>
    </main>
  );
}
