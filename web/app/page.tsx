"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Place } from "@/lib/places";
import {
  DISTANCE_FILTERS,
  distanceMeters,
  formatDistance,
  liveDurationLabel,
  type DistanceFilter,
  type LiveDiscoveryItem,
} from "@/lib/live/ui";

const filters = ["SEKARANG", "HARI INI", "BESOK", "PILIH WAKTU"];

// Map positions are demo placeholders keyed by Place id (canonical geocoords
// are pending per PO decision); LIVE pins use the same map so distances are
// computed from canonical lat/lng only — never from these layout positions.
const mapPositionByPlaceId: Record<string, string> = {
  "kopi-dari-kebun": "left-[22%] top-[34%]",
  "rumah-teh-lokal": "left-[62%] top-[27%]",
  "dapur-rasa": "left-[48%] top-[57%]",
};

type DiscoveryPlace = Place & { position: string };

export default function Home() {
  const [activeFilter, setActiveFilter] = useState("SEKARANG");
  const [distanceFilter, setDistanceFilter] = useState<DistanceFilter>("Di sekitar saya");
  const [liveOnly, setLiveOnly] = useState(false);
  const [places, setPlaces] = useState<DiscoveryPlace[]>([]);
  const [liveItems, setLiveItems] = useState<LiveDiscoveryItem[]>([]);

  useEffect(() => {
    fetch("/api/places")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Places could not be loaded"))))
      .then((loadedPlaces: Place[]) =>
        setPlaces(
          loadedPlaces.map((place) => ({
            ...place,
            position: mapPositionByPlaceId[place.id] ?? "left-1/2 top-1/2",
          })),
        ),
      )
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

  const liveByPlaceId = useMemo(() => {
    const map = new Map<string, LiveDiscoveryItem>();
    liveItems.forEach((item) => {
      if (!map.has(item.placeId)) map.set(item.placeId, item);
    });
    return map;
  }, [liveItems]);

  const visiblePlaces = useMemo(() => {
    if (liveOnly) return places.filter((place) => liveByPlaceId.has(place.id));
    // Radii filters use canonical lat/lng (PO item 6). With no coordinates the
    // Place stays visible only for the two unbounded filters (Policy §12.3 #2:
    // "Di sekitar saya" stays inert; bounded radii never hide by assumption).
    if (distanceFilter === "Di sekitar saya" || distanceFilter === "10 km+") return places;
    return places.filter((place) => place.latitude !== null && place.longitude !== null);
  }, [places, distanceFilter, liveOnly, liveByPlaceId]);

  const liveCards = useMemo(
    () => liveItems.filter((item) => places.some((place) => place.id === item.placeId)),
    [liveItems, places],
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

          <button className="rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-semibold shadow-sm">
            Jakarta
          </button>
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
            />
          </div>
        </div>

        {/* Time filters (existing, preserved) */}
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {filters.map((filter) => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              className={`whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-bold transition ${
                activeFilter === filter
                  ? "bg-[#20231f] text-white"
                  : "border border-black/10 bg-white text-black/65"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* Distance filters (locked set, policy §9) + LIVE filter */}
        <div className="mb-5 flex gap-2 overflow-x-auto pb-1">
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
          <button
            onClick={() => setLiveOnly((value) => !value)}
            aria-pressed={liveOnly}
            className={`ml-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-black tracking-wide transition ${
              liveOnly
                ? "bg-[#b3261e] text-white"
                : "border border-[#b3261e]/40 bg-white text-[#b3261e]"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${liveOnly ? "bg-white" : "bg-[#b3261e]"}`} />
            LIVE
          </button>
        </div>

        {/* LIVE SEKARANG cards */}
        {liveCards.length > 0 && (
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {liveCards.map((item) => {
              const place = places.find((candidate) => candidate.id === item.placeId);
              // Distance from canonical Place coordinates only (PO item 7):
              // shown when available, omitted otherwise — never invented.
              const distance =
                place?.latitude != null && place?.longitude != null
                  ? formatDistance(distanceMeters({ lat: -6.2, lng: 106.816 }, { lat: place.latitude, lng: place.longitude }))
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

        {/* Map-first discovery */}
        <section className="relative h-[58vh] min-h-[430px] overflow-hidden rounded-[28px] border border-black/10 bg-[#d9dfd2] shadow-sm">
          {/* Map-like background */}
          <div className="absolute inset-0 opacity-60">
            <div className="absolute left-[12%] top-[-10%] h-[125%] w-8 rotate-[22deg] bg-white/70" />
            <div className="absolute left-[42%] top-[-10%] h-[125%] w-5 rotate-[-35deg] bg-white/70" />
            <div className="absolute left-[75%] top-[-10%] h-[125%] w-10 rotate-[48deg] bg-white/60" />
            <div className="absolute left-[-10%] top-[35%] h-8 w-[120%] rotate-[8deg] bg-white/60" />
            <div className="absolute left-[-10%] top-[72%] h-5 w-[120%] rotate-[-12deg] bg-white/60" />
          </div>

          <div className="absolute left-5 top-5 z-10 rounded-full bg-white/90 px-4 py-2 text-xs font-bold shadow-sm">
            {liveOnly ? `LIVE • ${activeFilter}` : activeFilter} • {distanceFilter}
          </div>

          {/* LIVE markers — the pin occupies the SAME map position as its
              Place pin (a live-state overlay on the Place, not a fabricated
              coordinate). Until canonical lat/lng exist (PO item 6), Places
              without a demo map position get no pin; nothing is invented. */}
          {liveItems.map((item) => {
            const place = places.find((candidate) => candidate.id === item.placeId);
            if (!place) return null;
            const position = mapPositionByPlaceId[place.id];
            if (!position) return null;
            return (
              <Link
                key={`live-${item.sessionId}`}
                href={`/live/${item.sessionId}`}
                aria-label={`Lihat Live di ${place.name}`}
                className={`absolute ${position} z-20 -translate-x-1/2 -translate-y-1/2`}
              >
                <div className="flex h-12 w-12 animate-pulse items-center justify-center rounded-full border-4 border-white bg-[#b3261e] text-[10px] font-black text-white shadow-lg">
                  LIVE
                </div>
                <div className="mt-1 whitespace-nowrap rounded-full bg-[#b3261e] px-3 py-1.5 text-[11px] font-bold text-white shadow-md">
                  {item.processTitle ?? place.name}
                </div>
              </Link>
            );
          })}

          {/* Place markers */}
          {visiblePlaces.map((place) => (
            <Link
              key={place.id}
              href={`/places/${place.id}`}
              aria-label={`Lihat ${place.name}`}
              className={`absolute ${place.position} z-10 -translate-x-1/2 -translate-y-1/2`}
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-full border-4 border-white bg-[#7b5b38] text-lg shadow-lg">
                📍
              </div>
              <div className="mt-1 whitespace-nowrap rounded-full bg-white px-3 py-1.5 text-[11px] font-bold shadow-md">
                {place.name}
              </div>
            </Link>
          ))}

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
