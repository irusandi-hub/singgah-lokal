"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import HomeMap, { type HomeMapPlace } from "@/components/home-map";
import SiteNav from "@/components/site-nav";
import VisitedLink from "@/components/visited-link";
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
  // Viewer position — Current Location. Geolocation is the primary map
  // anchor: when available the Home Map centers on it and shows the user
  // marker. Silently absent when denied; no fallback point is ever invented.
  const [viewerPosition, setViewerPosition] = useState<{
    lat: number;
    lng: number;
    accuracy?: number;
  } | null>(null);
  // Explicit "Lokasi Saya" requests bump this nonce so the map re-centers on
  // the latest fix on demand.
  const [locateNonce, setLocateNonce] = useState(0);

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
        setViewerPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
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
    <main className="min-h-screen bg-brand-cream text-brand-ink">
      {/* Header + auth entry (Masuk / Sign out) + URL-derived active tabs */}
      <SiteNav />

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
            className={`mr-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-semibold tracking-wide transition ${
              liveOnly
                ? "bg-live text-white"
                : "border border-live/40 bg-white text-live"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${liveOnly ? "bg-white" : "bg-live"}`} />
            LIVE
          </button>
          {DISTANCE_FILTERS.map((filter) => (
            <button
              key={filter}
              onClick={() => setDistanceFilter(filter)}
              className={`whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-bold transition ${
                distanceFilter === filter
                  ? "bg-brand-accent text-white"
                  : "border border-black/10 bg-white text-black/65"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* LIVE filter empty state — a clear notice instead of an empty
            screen. Based only on canonical discovery data; no fake Live. */}
        {liveOnly && liveItems.length === 0 && (
          <div className="mb-5 rounded-2xl border border-live/30 bg-white p-6 text-center shadow-sm">
            <p className="text-sm font-bold">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className="mt-1 text-xs text-black/55">
              Ketika sebuah Place memulai Live, proses produksinya otomatis muncul di sini.
            </p>
            <button
              type="button"
              onClick={() => setLiveOnly(false)}
              className="mt-4 inline-flex rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white"
            >
              Lihat Semua Place
            </button>
          </div>
        )}

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
                <VisitedLink
                  key={item.sessionId}
                  href={`/live/${item.sessionId}`}
                  className="group rounded-2xl border border-live/30 bg-white p-4 shadow-sm transition hover:shadow-md"
                  visitedClassName="border-live/60 bg-[#fdf6f2]"
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-white">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                      Live Sekarang
                    </span>
                    <span className="text-[10px] font-bold text-black/45">
                      {liveDurationLabel(item.startedAt)} • {item.viewerPeak}/100
                    </span>
                  </div>
                  <p className="mt-3 text-sm font-semibold">{item.processTitle ?? "Proses produksi"}</p>
                  <p className="mt-0.5 text-xs text-black/55">
                    {place?.name ?? item.placeName} • {place?.area ?? ""}
                  </p>
                  <p className="mt-2 text-[11px] font-bold text-brand-accent">
                    {distance ? `${distance} • ` : ""}
                    {place?.type === "production" ? "Sedang berproduksi" : "Sedang aktif"}
                  </p>
                </VisitedLink>
              );
            })}
          </div>
        )}

        {/* Map-first discovery — real interactive Leaflet map (OpenStreetMap).
            isolate keeps Leaflet panes contained below the UI overlays. */}
        <section className="relative isolate h-[58vh] min-h-[430px] overflow-hidden rounded-[28px] border border-black/10 bg-[#d9dfd2] shadow-sm">
          <HomeMap
            places={mapPlaces}
            liveByPlaceId={liveByPlaceId}
            viewerPosition={viewerPosition}
            locateNonce={locateNonce}
            onRequestLocate={() => setLocateNonce((nonce) => nonce + 1)}
          />

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

          {/* Bottom sheet */}
          {visiblePlaces[0] && (
            <div className="absolute bottom-0 left-0 right-0 z-20 rounded-t-[28px] bg-white p-5 shadow-[0_-10px_30px_rgba(0,0,0,0.12)]">
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-black/15" />

              <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">
                Tempat pilihan
              </div>

              <h2 className="text-2xl font-semibold tracking-tight">
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
                  className="mt-4 block w-full rounded-2xl bg-live py-4 text-center text-sm font-bold text-white"
                >
                  Lihat Live Sekarang
                </Link>
              )}

              <VisitedLink
                href={`/places/${visiblePlaces[0].id}`}
                className="mt-3 block w-full rounded-2xl bg-brand-primary py-4 text-center text-sm font-bold text-white"
                visitedClassName="bg-[#4a4d44]"
              >
                Lihat Tempat
              </VisitedLink>
            </div>
          )}
        </section>

        {/* Place results — same canonical visiblePlaces used by map and filters. */}
        <section className="mt-6" aria-labelledby="place-results-heading">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">
                Hasil
              </p>
              <h2 id="place-results-heading" className="mt-1 text-xl font-semibold">
                {searchQuery.trim() ? `Hasil untuk “${searchQuery.trim()}”` : "Tempat pilihan"}
              </h2>
            </div>
            <span className="text-xs font-bold text-black/45">
              {visiblePlaces.length} Place
            </span>
          </div>

          {visiblePlaces.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visiblePlaces.map((place) => {
                const live = liveByPlaceId.get(place.id);
                const distance =
                  viewerPosition && place.latitude != null && place.longitude != null
                    ? formatDistance(
                        distanceMeters(viewerPosition, {
                          lat: place.latitude,
                          lng: place.longitude,
                        }),
                      )
                    : null;

                return (
                  <VisitedLink
                    key={place.id}
                    href={live ? `/live/${live.sessionId}` : `/places/${place.id}`}
                    className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm transition hover:shadow-md"
                    visitedClassName={live ? "border-live/60 bg-[#fdf6f2]" : "border-brand-accent/35 bg-[#faf6ee]"}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-accent">
                          {place.category}
                        </p>
                        <h3 className="mt-1 text-base font-semibold">{place.name}</h3>
                      </div>
                      {live && (
                        <span className="shrink-0 rounded-full bg-live px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-white">
                          LIVE
                        </span>
                      )}
                    </div>

                    <p className="mt-2 text-xs text-black/55">
                      {place.area} · {place.type === "production" ? "Produksi" : "Experience"}
                    </p>

                    <p className="mt-2 line-clamp-2 text-sm leading-5 text-black/65">
                      {live?.processTitle ?? place.shortDescription}
                    </p>

                    {distance && (
                      <p className="mt-3 text-[11px] font-bold text-brand-accent">
                        {distance}
                      </p>
                    )}
                  </VisitedLink>
                );
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-black/10 bg-white p-6 text-center">
              <p className="text-sm font-bold">Place tidak ditemukan</p>
              <p className="mt-1 text-xs text-black/55">
                Coba kata kunci atau radius yang berbeda.
              </p>
            </div>
          )}
        </section>

        {/* Intro */}
        <section className="px-1 pb-4 pt-8">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand-accent">
            SINGGAH LOKAL
          </p>
          <h1 className="mt-2 max-w-xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Jangan hanya datang.
            <br />
            Kenali ceritanya.
          </h1>
        </section>
      </section>
    </main>
  );
}
