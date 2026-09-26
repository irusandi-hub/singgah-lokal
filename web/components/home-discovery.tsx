"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import HomeMap, { type HomeMapPlace } from "@/components/home-map";
import SiteNav from "@/components/site-nav";
import VisitedLink from "@/components/visited-link";
import type { Place } from "@/lib/places";
import { CURATED_COLLECTIONS } from "@/lib/places";
import {
  DISTANCE_FILTERS,
  buildDirectionsUrl,
  distanceMeters,
  formatDistance,
  liveDurationLabel,
  matchesDistance,
  stopNestedCardAction,
  DISTANCE_FILTER_RADIUS_M,
  type DistanceFilter,
  type LiveDiscoveryItem,
} from "@/lib/live/ui";

// Home discovery (Map-first) — rendered by the / route (app/page.tsx,
// force-dynamic server wrapper). It must stay a CLIENT component here so the
// route segment config in the wrapper takes effect: as a top-level "use
// client" page the shell was statically prerendered and served with a
// year-long s-maxage, freezing the signed-out header for logged-in users.
// Performance (PO 2026-09-26): the public discovery data is passed in from
// the server wrapper (sessionless fetch, safe inside the dynamic shell) —
// the client no longer re-fetches /api/places after hydration.
export default function HomeDiscovery({ initialPlaces = [] }: { initialPlaces?: Place[] }) {
  // Places come from the server wrapper (initialPlaces) and never change
  // client-side — no setter, no post-hydration fetch, no stale client copy.
  const [places] = useState<Place[]>(initialPlaces);
  // Home filter bar — ONE row on mobile (PO 2026-09-26): LIVE leftmost,
  // "Tempat Pilihan" beside it, then the distance tabs. Default = "1 km":
  // the smallest remaining bounded radius anchors on the real Current
  // Location (PO: Current Location is the map center; no invented viewport).
  // Dapur, Kopi, and Teh are the curated collections inside "Tempat
  // Pilihan" (mapped to canonical Place categories — NOT nearby-view
  // categories, NOT a "lokal" grouping). It does NOT replace "Tempat di
  // sekitar", which still appears whenever a bounded radius is active.
  const [distanceFilter, setDistanceFilter] = useState<DistanceFilter>("1 km");
  const [curatedOnly, setCuratedOnly] = useState(false);
  // Active curated collection (key of CURATED_COLLECTIONS); null resolves to
  // the first collection when the layer is opened.
  const [curatedCollectionKey, setCuratedCollectionKey] = useState<string | null>(null);
  const [liveOnly, setLiveOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
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
  // Which Place card currently shows the "not Live" notice (pressed state of
  // the permanent LIVE indicator). Live state itself is never invented — the
  // canonical liveByPlaceId feed is the only source.
  const [nonLiveNoticePlaceId, setNonLiveNoticePlaceId] = useState<string | null>(null);
  const router = useRouter();

  // LIVE discovery feed (canonical live_sessions, published Places only).
  // Performance rule (PO, 2026-09-25): the 15-second poll runs ONLY while
  // the LIVE tab is actually active — distance/curated modes must not pay
  // for continuous Live polling. Initial load + refresh happen when the tab
  // is opened; the interval is torn down on every mode exit (tab switch off,
  // Tempat Pilihan, unmount/route change), so leaving LIVE mode always
  // stops the polling. LIVE badges (liveByPlaceId) stay correct for a full
  // poll cycle after leaving the tab and never invent Live state.
  useEffect(() => {
    if (!liveOnly) return;

    const load = () =>
      fetch("/api/live/discovery")
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Live discovery unavailable"))))
        .then((payload: { live: LiveDiscoveryItem[] }) => setLiveItems(payload.live ?? []))
        .catch(() => setLiveItems([]));

    load();
    const interval = window.setInterval(load, 15000);
    return () => window.clearInterval(interval);
  }, [liveOnly]);

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

  // Active curated collection (null when the radius/live layer is active).
  const activeCollection = curatedOnly
    ? CURATED_COLLECTIONS.find((collection) => collection.key === curatedCollectionKey) ??
      CURATED_COLLECTIONS[0]
    : null;

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
    // "Tempat Pilihan" (curated layer, PO request 2026-09-25) shows the
    // active collection's Places — the unbounded set, independent of the
    // radius; the canonical Place category drives membership.
    if (curatedOnly && activeCollection) {
      return searchFiltered.filter((place) => place.category === activeCollection.category);
    }
    let result = distanceFiltered;
    if (liveOnly) result = result.filter((place) => liveByPlaceId.has(place.id));
    return result;
  }, [places, searchQuery, distanceFilter, liveOnly, curatedOnly, activeCollection, liveByPlaceId, viewerPosition]);

  const liveCards = useMemo(() => {
    if (liveItems.length === 0) return [];
    const visibleIds = new Set(visiblePlaces.map((place) => place.id));
    return liveItems.filter((item) => visibleIds.has(item.placeId));
  }, [liveItems, visiblePlaces]);

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

        {/* Home filter bar — ONE row on mobile (PO 2026-09-26, amending the
            2026-09-20 locked set): LIVE leftmost, "Tempat Pilihan" directly
            beside it, then the distance tabs (the smallest legacy radius is
            fully removed). All controls
            share the row via grid columns — no wrap, no second row, no
            horizontal overflow at 360 px. Compact text [11px]/padding/gap
            keeps everything visible on the smallest supported viewport;
            labels keep the master copy. Dapur/Kopi/Teh stay INSIDE the
            Tempat Pilihan layer (secondary row), never as primary tabs. */}
        <div className="mb-5 grid grid-cols-[auto_auto_1fr_1fr_1fr] gap-1.5 pb-1">
          <button
            onClick={() => setLiveOnly((value) => !value)}
            aria-pressed={liveOnly}
            className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 py-2 text-[11px] font-semibold tracking-wide transition sm:px-4 sm:text-xs ${
              liveOnly
                ? "bg-live text-white"
                : "border border-live/40 bg-white text-live"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${liveOnly ? "bg-white" : "bg-live"}`} />
            LIVE
          </button>
          <button
            onClick={() => {
              setCuratedOnly(true);
              setLiveOnly(false);
            }}
            aria-pressed={curatedOnly}
            className={`whitespace-nowrap rounded-full px-2 py-2 text-[11px] font-bold transition sm:px-4 sm:text-xs ${
              curatedOnly
                ? "bg-brand-ink text-white"
                : "border border-brand-ink/25 bg-white text-brand-ink/70"
            }`}
          >
            Tempat Pilihan
          </button>
          {DISTANCE_FILTERS.map((filter) => (
            <button
              key={filter}
              onClick={() => {
                setDistanceFilter(filter);
                setCuratedOnly(false);
              }}
              className={`whitespace-nowrap rounded-full px-1 py-2 text-center text-[11px] font-bold transition sm:px-4 sm:text-xs ${
                distanceFilter === filter && !curatedOnly
                  ? "bg-brand-accent text-white"
                  : "border border-black/10 bg-white text-black/65"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* Curated collections — visible ONLY inside the Tempat Pilihan
            layer. Dapur/Kopi/Teh are the collections from the mockup, mapped
            to canonical Place categories; the radius/LIVE bar stays untouched. */}
        {curatedOnly && (
          <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Koleksi Tempat Pilihan">
            {CURATED_COLLECTIONS.map((collection) => {
              const active = activeCollection?.key === collection.key;
              return (
                <button
                  key={collection.key}
                  onClick={() => setCuratedCollectionKey(collection.key)}
                  role="tab"
                  aria-selected={active}
                  className={`whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-bold transition ${
                    active
                      ? "bg-brand-accent text-white"
                      : "border border-black/10 bg-white text-black/65"
                  }`}
                >
                  {collection.label}
                </button>
              );
            })}
          </div>
        )}

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

        {/* LIVE SEKARANG cards — hidden inside the Tempat Pilihan layer
            (the curated layer is discovery of collections, not Live state). */}
        {!curatedOnly && liveCards.length > 0 && (
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
            radiusMeters={curatedOnly ? null : DISTANCE_FILTER_RADIUS_M[distanceFilter]}
          />

          {/* Clear empty state when no visible Place carries canonical
              coordinates — positions are never invented. OVERLAY_LADDER:
              Leaflet's highest documented z-index is 1000 (zoom control);
              z-[1100] pins this card strictly above every Leaflet pane
              (tile 200, map pane 400, tooltip 650, control 1000) in any
              drag/zoom state — the visual fix for the mobile drag bug. */}
          {mapPlaces.length === 0 && (
            <div className="absolute inset-x-6 top-1/2 z-[1100] -translate-y-1/2 rounded-2xl bg-white/95 p-4 text-center shadow-md">
              <p className="text-sm font-bold">Belum ada Place dengan koordinat di peta</p>
              <p className="mt-1 text-xs text-black/55">
                Peta hanya menampilkan Place dengan koordinat resmi. Place lain tetap ada di daftar.
              </p>
            </div>
          )}

          {/* Radius/status badge — OVERLAY_LADDER above the Leaflet ceiling. */}
          <div className="absolute left-5 top-5 z-[1100] rounded-full bg-white/90 px-4 py-2 text-xs font-bold shadow-sm">
            {liveOnly ? "LIVE • " : ""}
            {curatedOnly ? "Tempat Pilihan" : distanceFilter}
          </div>

          {/* No Place card/preview may cover the map surface (PO decision,
              2026-09-25): the map frame stays fully visible from top to
              bottom. Place detail stays in the proximity results section
              below the map. */}
        </section>

        {/* Place results — same canonical visiblePlaces used by map and filters. */}
        <section className="mt-6" aria-labelledby="place-results-heading">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">
                Hasil
              </p>
              <h2 id="place-results-heading" className="mt-1 text-xl font-semibold">
                {searchQuery.trim()
                  ? `Hasil untuk “${searchQuery.trim()}”`
                  : curatedOnly
                    ? activeCollection?.label ?? "Tempat Pilihan"
                    : "Tempat di sekitar"}
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
                // Direction target from the REAL canonical coordinates —
                // null when the Place has none (safe disabled control).
                const directionsUrl = buildDirectionsUrl(place);
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
                    className="group flex flex-col rounded-2xl border border-black/10 bg-white p-4 shadow-sm transition hover:shadow-md"
                    visitedClassName={live ? "border-live/60 bg-[#fdf6f2]" : "border-brand-accent/35 bg-[#faf6ee]"}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-brand-accent">
                          {place.category}
                        </p>
                        <h3 className="mt-1 text-base font-semibold">{place.name}</h3>
                      </div>
                      {live ? (
                        <span className="shrink-0 rounded-full bg-live px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-white">
                          LIVE
                        </span>
                      ) : (
                        // Mockup affordance: a right-side chevron invites the
                        // tap-through to the Place (visual only — navigation
                        // already happens through the card link).
                        <span
                          aria-hidden
                          className="shrink-0 self-center text-lg font-bold text-brand-accent transition group-hover:translate-x-0.5"
                        >
                          ›
                        </span>
                      )}
                    </div>

                    <p className="mt-2 text-xs text-black/55">
                      {place.area} · {place.type === "production" ? "Produksi" : "Experience"}
                    </p>

                    <p className="mt-2 line-clamp-2 text-sm leading-5 text-black/65">
                      {live?.processTitle ?? place.shortDescription}
                    </p>

                    {/* Card meta row (PO 2026-09-26): real distance (only
                        when the real viewer fix exists) + Direction from the
                        Place's canonical coordinates. No operating-hours
                        status: the Place model has no operating-hours field
                        yet (DATA GAP), and no hours are ever invented. */}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      {distance && (
                        <span className="text-[11px] font-bold text-brand-accent">{distance}</span>
                      )}
                      {directionsUrl ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            stopNestedCardAction(event);
                            window.open(directionsUrl, "_blank", "noopener,noreferrer");
                          }}
                          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-accent/40 px-3 py-1.5 text-[11px] font-bold text-brand-accent transition hover:bg-brand-accent/10"
                          aria-label={`Petunjuk arah ke ${place.name} di aplikasi peta`}
                        >
                          <span aria-hidden>➤</span> Direction
                        </button>
                      ) : (
                        // Fail-closed: no canonical coordinates → no
                        // navigation target is ever invented.
                        <span
                          aria-disabled="true"
                          title="Koordinat Place belum tersedia"
                          className="ml-auto inline-flex shrink-0 cursor-not-allowed items-center gap-1 rounded-full border border-black/10 px-3 py-1.5 text-[11px] font-bold text-black/35"
                        >
                          <span aria-hidden>➤</span> Direction
                        </span>
                      )}
                    </div>

                    {/* Permanent Live identity (PO 2026-09-26): every Place
                        card carries its own LIVE affordance in BOTH states.
                        With an active session it opens the existing
                        /live/[sessionId] flow; without one it shows the
                        honest not-live status when pressed. Live state is
                        never invented — liveByPlaceId (canonical
                        live_sessions feed) is the only source. */}
                    <div className="mt-2">
                      {live ? (
                        <button
                          type="button"
                          onClick={(event) => {
                            stopNestedCardAction(event);
                            router.push(`/live/${live.sessionId}`);
                          }}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-live px-3 py-2 text-[11px] font-bold text-white transition hover:opacity-90"
                          aria-label={`Buka Live di ${place.name}`}
                        >
                          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                          LIVE — Lihat proses sekarang
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-pressed={nonLiveNoticePlaceId === place.id}
                            onClick={(event) => {
                              stopNestedCardAction(event);
                              setNonLiveNoticePlaceId((current) => (current === place.id ? null : place.id));
                            }}
                            className="inline-flex w-full items-center justify-center gap-1.5 rounded-full border border-live/40 bg-white px-3 py-2 text-[11px] font-bold text-live transition hover:bg-live/10"
                            aria-label={`Status Live ${place.name}`}
                          >
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-live/60" />
                            LIVE — Belum berlangsung
                          </button>
                          {nonLiveNoticePlaceId === place.id && (
                            <p
                              role="status"
                              className="mt-1.5 rounded-lg bg-live/10 px-3 py-1.5 text-[11px] font-semibold text-live"
                            >
                              {place.name} sedang tidak Live. Place ini dapat memulai Live kapan saja.
                            </p>
                          )}
                        </>
                      )}
                    </div>
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
