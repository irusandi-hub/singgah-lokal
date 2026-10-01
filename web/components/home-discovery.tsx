"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import HomeMap, { type HomeMapPlace } from "@/components/home-map";
import PlaceFollowButton from "@/components/place-follow-button";
import SiteNav from "@/components/site-nav";
import VisitedLink from "@/components/visited-link";
import type { Place } from "@/lib/places";
import type { DiscoveryViewModel } from "@/lib/discovery/view-model";
import {
  CAMERA_PRESET_RADIUS_M,
  CURATED_CAMERA_RADIUS_M,
  CURATED_MAP_COVERAGE_RADIUS_M,
  DISTANCE_FILTERS,
  buildDirectionsUrl,
  distanceMeters,
  formatDistance,
  liveDurationLabel,
  matchesDistance,
  stopNestedCardAction,
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
//
// Stage 3: the `discovery` prop carries the server-built view model from the
// canonical Discovery engine (stars + rank only — the numeric score never
// leaves the server). The client NEVER recomputes eligibility, score, stars,
// or ranking; it only joins card data by id and renders the engine order.
export default function HomeDiscovery({
  initialPlaces = [],
  discovery,
}: {
  initialPlaces?: Place[];
  discovery?: DiscoveryViewModel;
}) {
  // Places come from the server wrapper (initialPlaces) and never change
  // client-side — no setter, no post-hydration fetch, no stale client copy.
  const [places] = useState<Place[]>(initialPlaces);
  // Home filter bar — ONE row on mobile (PO 2026-09-26): LIVE leftmost,
  // "Tempat Pilihan" beside it, then the distance tabs. Default = "1 km":
  // the smallest remaining bounded radius anchors on the real Current
  // Location (PO: Current Location is the map center; no invented viewport).
  // "Tempat Pilihan" is ONE curated discovery layer (PO 2026-09-26): it
  // carries NO category tabs/chips — Place categories (Kopi/Teh/Kuliner)
  // stay internal data, never a Home filter UI. It does NOT replace
  // "Tempat di sekitar", which still appears whenever a bounded radius is
  // active.
  const [distanceFilter, setDistanceFilter] = useState<DistanceFilter>("1 km");
  const [curatedOnly, setCuratedOnly] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [liveItems, setLiveItems] = useState<LiveDiscoveryItem[]>([]);
  // Viewer position — Current Location. Geolocation is the primary map
  // anchor: when available the Home Map centers on it and shows the user
  // marker. Silently absent when denied; no fallback point is ever invented.
  // Default = "1 km": the tightest camera preset anchors on the real Current
  // Location (PO: Current Location is the map center; no invented viewport).
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
  // Viewport-aware map empty state (PO, 2026-09-30): the MAP decides from the
  // REAL Leaflet viewport whether a Place is currently visible — evaluated on
  // readiness and on every FINISHED move/zoom (moveend/zoomend). Three
  // situations stay distinct:
  //   1. the dataset itself is empty (mapPlaces.length === 0) → overlay on;
  //   2. the dataset has Places but none sits in the current viewport →
  //      overlay on — and it disappears/appears again as the user pans/zooms
  //      between populated and empty areas without any dataset change;
  //   3. a Place sits in the viewport → no overlay.
  // viewportHasPlaces only becomes meaningful once the map has reported
  // (reportedViewportRef), so the first paint before Leaflet is ready never
  // shows a wrong status.
  // MOCKUP §16 (2026-10-01): the 5-slot star row reads ONLY the canonical
  // engine output — the `stars` field of the server view model (stars alone;
  // the numeric score never leaves the server, contract §3). A Place the
  // engine did not rank (e.g. Live cards) renders five EMPTY slots. Never a
  // rating number, never a review count — no such data exists in the product.
  const starsByPlaceId = useMemo(() => {
    const map = new Map<string, number>();
    (discovery?.discovery ?? []).forEach((entry) => {
      if (!map.has(entry.placeId)) map.set(entry.placeId, entry.stars);
    });
    return map;
  }, [discovery]);
  const [viewportHasPlaces, setViewportHasPlaces] = useState(false);
  const [viewportReported, setViewportReported] = useState(false);
  const reportedViewportRef = useRef(false);
  const handleViewportHasPlaces = useCallback((hasPlaces: boolean) => {
    setViewportHasPlaces(hasPlaces);
    if (!reportedViewportRef.current) {
      reportedViewportRef.current = true;
      setViewportReported(true);
    }
  }, []);
  const router = useRouter();

  // Stage 3: server-built Discovery view model (engine output) + the
  // Tempat Pilihan flag ids (migration 0035, read through the canonical
  // repository). Both are lookup-only here — no curation or score logic.
  const curatedIdSet = useMemo(
    () => new Set(discovery?.curatedPlaceIds ?? []),
    [discovery],
  );
  const placeById = useMemo(() => new Map(places.map((place) => [place.id, place])), [places]);



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
  // label is shown (PO: no fake positions). The SAME handler serves the
  // initial mount fix and the explicit "Lokasi Saya" presses: a press always
  // asks the browser for a FRESH position (locate-refresh fix, 2026-09-30).
  const requestViewerPosition = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setViewerPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        // Recentre ONLY after the fresh position is committed to state —
        // the locate effect (locateNonce) then flies to the ACTIVE preset
        // radius around this newest fix. Never flies to a stale one.
        setLocateNonce((nonce) => nonce + 1);
      },
      // Denial/failure is silent: the camera stays exactly where it is —
      // no fallback coordinate, no default location, no dataset change.
      () => undefined,
      { timeout: 8000 },
    );
  }, []);

  // Initial mount fix — the same fresh-position request path.
  useEffect(() => {
    requestViewerPosition();
  }, [requestViewerPosition]);

  // "Lokasi Saya" press (locate-refresh regression fix, 2026-09-30): the
  // recenter must NOT depend on the fresh request succeeding. The press
  // bumps the locate nonce IMMEDIATELY — with a valid fix the map recentres
  // to it through the ACTIVE preset right away (a denied/timed-out fresh
  // request can no longer swallow the press); with no fix yet the existing
  // pending latch resolves on the first real one. The fresh request then
  // runs: on success it updates viewerPosition and bumps the nonce again so
  // the camera follows the newest fix; on failure the camera simply stays
  // where the immediate recenter put it. No fallback coordinate is ever
  // invented in any branch.
  const handleLocatePress = useCallback(() => {
    setLocateNonce((nonce) => nonce + 1);
    requestViewerPosition();
  }, [requestViewerPosition]);

  const liveByPlaceId = useMemo(() => {
    const map = new Map<string, LiveDiscoveryItem>();
    liveItems.forEach((item) => {
      if (!map.has(item.placeId)) map.set(item.placeId, item);
    });
    return map;
  }, [liveItems]);

  // CONTENT FILTER (PO, 2026-09-29): search, LIVE, and the curated layer —
  // the filters that decide WHAT content exists. The distance tabs are NOT
  // part of this pipeline anymore: 1 km / 5 km / 10 km+ are CAMERA PRESETS,
  // and the map dataset must never shrink because a radius tab was chosen
  // (zooming out would otherwise never reveal Places that an upstream
  // radius filter had already discarded).
  //
  // Search is extracted as its own step so EVERY layer (existing results,
  // the Tempat Pilihan row, and the Discovery rows) applies the exact same
  // query semantics — one search behavior, no second implementation.
  const searchFiltered = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase("id-ID");
    if (!normalizedQuery) return places;
    return places.filter((place) => {
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
  }, [places, searchQuery, liveByPlaceId]);

  const searchFilteredIds = useMemo(
    () => new Set(searchFiltered.map((place) => place.id)),
    [searchFiltered],
  );

  const visiblePlaces = useMemo(() => {
    // "Tempat Pilihan" is ONE curated discovery layer (PO 2026-09-26), backed
    // by the canonical is_curated flag (PO Stage 3, migration 0035): published
    // + curated only. The flag arrives through the server view model — the
    // client computes no curation and no score.
    //
    // An EMPTY curated set is a real empty state, never a fallback: showing
    // every published Place would silently disguise missing curation data as
    // "Tempat Pilihan" and would blur the two independent layers. There is no
    // category selection inside the layer — the canonical Place category never
    // filters the curated layer.
    if (curatedOnly) {
      return searchFiltered.filter((place) => curatedIdSet.has(place.id));
    }
    // LIVE: a process/status filter — only Places with an active session.
    let result = searchFiltered;
    if (liveOnly) result = result.filter((place) => liveByPlaceId.has(place.id));
    return result;
  }, [searchFiltered, liveOnly, curatedOnly, curatedIdSet, liveByPlaceId]);

  // LIST-ONLY radius gate (PO, 2026-09-29): the Place results below the map
  // keep their existing proximity semantics — a bounded radius narrows the
  // list (viewerPosition + canonical lat/lng, fail-closed, a position is
  // never invented), and "10 km+"/curated show everything. The MAP dataset
  // is deliberately independent: see mapPlaces below.
  const listedPlaces = useMemo(() => {
    if (curatedOnly || distanceFilter === "10 km+") return visiblePlaces;
    return visiblePlaces.filter((place) =>
      matchesDistance(
        distanceFilter,
        viewerPosition,
        place.latitude !== null && place.longitude !== null
          ? { lat: place.latitude, lng: place.longitude }
          : null,
      ),
    );
  }, [visiblePlaces, curatedOnly, distanceFilter, viewerPosition]);

  const liveCards = useMemo(() => {
    if (liveItems.length === 0) return [];
    const listedIds = new Set(listedPlaces.map((place) => place.id));
    return liveItems.filter((item) => listedIds.has(item.placeId));
  }, [liveItems, listedPlaces]);

  // DISCOVERY PLACE ROW (canonical engine output). INTEGRITY (P0): this row is
  // BUILT FROM the canonical `discovery.discovery` result — its ids ARE the
  // eligibility set, produced by the engine from the canonical publication +
  // readiness rules. The row is never rebuilt from the published place list
  // and never re-sorted: ranking rank is presentation, not eligibility, so a
  // published-but-ineligible Place can never enter this row by having its
  // rank appended as a fallback. Search and the list radius gate narrow the
  // canonical set; they can only remove entries, never add one. Never
  // deduplicated against the curated row: a Place in both layers appears in
  // both rows (OVERLAP rule).
  const discoveryRowPlaces = useMemo(() => {
    const canonical = (discovery?.discovery ?? []).flatMap((entry) => {
      const place = placeById.get(entry.placeId);
      return place && searchFilteredIds.has(place.id) ? [place] : [];
    });
    if (curatedOnly || distanceFilter === "10 km+") return canonical;
    return canonical.filter((place) =>
      matchesDistance(
        distanceFilter,
        viewerPosition,
        place.latitude !== null && place.longitude !== null
          ? { lat: place.latitude, lng: place.longitude }
          : null,
      ),
    );
  }, [discovery, placeById, searchFilteredIds, curatedOnly, distanceFilter, viewerPosition]);

  // TEMPAT PILIHAN ROW (Baris 1): published + is_curated only, through the
  // same search gate (unbounded in the curated layer), server order —
  // curation is Admin-promoted, never engine-ranked. Empty when nothing is
  // curated; the row then renders nothing and Baris 2 stands alone.
  const curatedListed = useMemo(
    () => visiblePlaces.filter((place) => curatedIdSet.has(place.id)),
    [visiblePlaces, curatedIdSet],
  );

  // MAP DATASET — normal modes (PO, 2026-09-29): every content-filtered Place
  // with canonical coordinates, independent of the camera radius. Zooming out
  // after choosing 1 km/5 km now reveals Places that were simply outside
  // the frame — nothing is discarded upstream. Leaflet's viewport decides
  // which markers are visually on screen; a Place without lat/lng is still
  // never invented onto the map (fail-closed).
  //
  // "Tempat Pilihan" MAP (PO, 2026-09-30): the curated map shows BOTH layers —
  //   1. every curated published Place (canonical `places.is_curated` only —
  //      the SAME set the curated LIST renders), and
  //   2. the NORMAL, non-curated published Places that sit inside the 10 km
  //      coverage around the real Current Location (CURATED_MAP_COVERAGE_RADIUS_M).
  // The second group is a MAP COVERAGE rule only: those Places keep their
  // ordinary marker treatment, never become curated, never enter the curated
  // LIST, and never touch Discovery. Curated membership is still read only
  // from the canonical curated ids — there is no "empty curated set → show
  // everything" fallback for the list, and Discovery is never used as one.
  // Without a real Current Location fix there is no coverage to measure, so
  // the curated map simply shows every published Place with coordinates.
  const curatedCoveragePlaces = useMemo(() => {
    if (!curatedOnly) return [];
    const nonCurated = searchFiltered.filter((place) => !curatedIdSet.has(place.id));
    if (!viewerPosition) return nonCurated;
    return nonCurated.filter(
      (place) =>
        place.latitude !== null &&
        place.longitude !== null &&
        distanceMeters(viewerPosition, { lat: place.latitude, lng: place.longitude }) <=
          CURATED_MAP_COVERAGE_RADIUS_M,
    );
  }, [curatedOnly, searchFiltered, curatedIdSet, viewerPosition]);

  const mapPlaces = useMemo<HomeMapPlace[]>(() => {
    // Curated Places first (they are the point of the layer), then the
    // ordinary Places inside coverage; a Place can only appear once.
    const source = curatedOnly ? [...visiblePlaces, ...curatedCoveragePlaces] : visiblePlaces;
    const seen = new Set<string>();
    return source.flatMap((place) => {
      if (seen.has(place.id)) return [];
      seen.add(place.id);
      if (place.latitude === null || place.longitude === null) return [];
      return [
        {
          id: place.id,
          name: place.name,
          latitude: place.latitude,
          longitude: place.longitude,
          // Per-Place curated flag: the marker treatment follows canonical
          // membership, never the whole mode (the curated map mixes both
          // kinds, so a mode-level flag could not tell them apart). Outside
          // the curated layer every Place keeps the ordinary treatment.
          isCurated: curatedOnly && curatedIdSet.has(place.id),
        },
      ];
    });
  }, [visiblePlaces, curatedCoveragePlaces, curatedOnly, curatedIdSet]);

  // Viewport-aware empty state (PO, 2026-09-30): overlay when the DATASET is
  // empty, or when the map has reported and NO Place sits in the REAL
  // viewport (that report flips live with pan/zoom — see HomeMap's
  // moveend/zoomend evaluation). Before the first report (Leaflet not ready
  // yet) only the dataset rule decides — no premature overlay, no stale one.
  const mapEmptyStateVisible =
    mapPlaces.length === 0 || (viewportReported && !viewportHasPlaces);

  // MOCKUP §8/§9: the coverage box and the scale label mirror the ACTIVE
  // camera radius so the copy stays truthful — the exact preset that owns
  // the camera (1 km / 5 km / 10 km; "Tempat Pilihan" and "Lokasi Saya" =
  // 10 km). Display only; never an invented state.
  const activeRadiusMeters = curatedOnly
    ? CURATED_CAMERA_RADIUS_M
    : CAMERA_PRESET_RADIUS_M[distanceFilter];
  const activeRadiusLabel =
    activeRadiusMeters >= 1000 ? `${activeRadiusMeters / 1000} km` : `${activeRadiusMeters} m`;

  // ONE card renderer for every row: the existing card design verbatim; the
  // only addition is the optional "✦ Tempat Pilihan" marker so an overlap
  // Place stays recognizable inside the Discovery row. No numeric score is
  // ever rendered anywhere.
  const renderPlaceCard = (place: Place, isCurated: boolean) => {
    const live = liveByPlaceId.get(place.id);
    // Star slots (MOCKUP §16): canonical engine stars only (1–4). Anything
    // else renders five empty slots — never a fabricated rating.
    const stars = starsByPlaceId.get(place.id) ?? 0;
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
        className="group flex w-full flex-col overflow-hidden rounded-[18px] border border-black/10 bg-white shadow-sm transition hover:shadow-md"
        visitedClassName={live ? "border-live/60 bg-[#fdf6f2]" : "border-brand-accent/35 bg-[#faf6ee]"}
      >
        {/* CARD IMAGE — MOCKUP §13: every card carries an image area. When
            the Place has no canonical cover yet, a NEUTRAL DUMMY area keeps
            the mockup composition (visual placeholder only — no data change,
            no invented imagery, and the canonical cover still wins when it
            exists). */}
        <div className="relative h-36 w-full shrink-0 overflow-hidden bg-[#ece7db] sm:h-40">
          {place.coverImageUrl ? (
            // External producer-supplied image URL; next/image would require
            // host allowlisting that producers cannot configure. Same
            // rationale and pattern as the Place detail hero.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={place.coverImageUrl}
              alt={`Gambar sampul ${place.name}`}
              className="h-full w-full object-cover transition group-hover:scale-[1.03]"
              loading="lazy"
            />
          ) : (
            // Dummy visual for the mockup's always-present image area —
            // decorative, aria-hidden, and derived only from canonical
            // category text. Nothing is uploaded, stored, or faked as data.
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[#b3a88d]" aria-hidden>
              <span className="text-2xl leading-none">⌂</span>
              <span className="text-[9px] font-bold uppercase tracking-[0.16em]">
                {place.category}
              </span>
            </div>
          )}

          {/* CARD OVERLAYS — MOCKUP §14: curated badge top-left, decorative
              heart top-right, REAL distance bottom-right. The distance stays
              fail-closed: it renders ONLY when the real fix and canonical
              Place coordinates both exist — never a fabricated number. */}
          {isCurated && (
            <span className="absolute left-2 top-2 rounded-full bg-brand-secondary px-2 py-1 text-[10px] font-bold text-white shadow-sm">
              ✦ Tempat Pilihan
            </span>
          )}
          {/* No favorite feature exists in the MVP — the heart is DECORATIVE
              (aria-hidden, non-interactive) exactly as drawn in the mockup.
              It must never read as a saved-state control. */}
          <span
            aria-hidden
            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-sm text-brand-ink shadow-sm"
          >
            ♡
          </span>
          {distance && (
            <span className="absolute bottom-2 right-2 rounded-full bg-brand-ink/70 px-2 py-1 text-[11px] font-bold text-white">
              {distance}
            </span>
          )}
        </div>

        {/* CARD TEXT — MOCKUP §15/§17: name, short description, then the
            5-slot star row. Stars come ONLY from the canonical Discovery
            engine output (stars alone — the numeric score never leaves the
            server); a Place outside the engine (e.g. Live cards) shows five
            empty slots. NEVER a rating number, NEVER a review count — no
            such data exists in this product. */}
        <div className="flex flex-1 flex-col p-3.5">
          <h3 className="text-base font-bold leading-tight">{place.name}</h3>
          <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-black/55">
            {live?.processTitle ?? place.shortDescription}
          </p>
          <p className="mt-2 flex items-center gap-0.5" aria-hidden>
            {[1, 2, 3, 4, 5].map((slot) => (
              <span
                key={slot}
                className={`singgah-star ${slot <= stars ? "singgah-star-active" : "singgah-star-empty"}`}
              >
                ★
              </span>
            ))}
          </p>

        {/* Card meta row (PO 2026-09-26): real distance (only
            when the real viewer fix exists) + Direction from the
            Place's canonical coordinates. No operating-hours
            status: the Place model has no operating-hours field
            yet (DATA GAP), and no hours are ever invented.
            MOCKUP §8 moved the distance and the curated badge ONTO the cover
            image, so they are no longer repeated here — the same canonical
            values, shown once, and still only when they really exist. */}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {/* Follow control (User → Place follow foundation for
              MASTER 10 notifications): server-derived state only
              — Follow / Following, signed-out → /auth. Sits next
              to Direction; card navigation/design untouched. */}
          {!live && <PlaceFollowButton placeId={place.id} />}
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
              title="Koordinat Tempat belum tersedia"
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
                  {place.name} sedang tidak Live. Tempat ini dapat memulai Live kapan saja.
                </p>
              )}
            </>
          )}
        </div>
        </div>
      </VisitedLink>
    );
  };

  return (
    <main className="min-h-screen bg-brand-cream text-brand-ink">
      {/* Header + auth entry (Masuk / Sign out) + URL-derived active tabs */}
      <SiteNav />

      <section className="mx-auto max-w-6xl px-4 pb-8 pt-3">
        {/* Search — MOCKUP §2: wide white rounded bar, search icon LEFT and
            the settings/sliders control icon RIGHT. The right icon is
            DECORATIVE ONLY (mockup chrome — aria-hidden, non-interactive):
            no search-settings feature exists, and none is invented. Copy,
            input, and search behavior untouched (ONE search implementation). */}
        <div className="relative mb-3">
          <div className="flex items-center gap-3 rounded-[20px] border border-black/10 bg-white px-4 py-3 shadow-sm">
            <span className="text-lg" aria-hidden>⌕</span>
            <input
              className="w-full bg-transparent text-sm outline-none placeholder:text-black/40"
              placeholder="Cari tempat, cerita, produksi..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Cari tempat, cerita, produksi"
            />
            {/* Settings/sliders icon — mockup visual only, never a button. */}
            <span aria-hidden className="shrink-0 text-lg text-black/45">⚙</span>
          </div>
        </div>

        {/* Home filter bar — ONE row on mobile (PO 2026-09-26, amending the
            2026-09-20 locked set): LIVE leftmost, "Tempat Pilihan" directly
            beside it, then the distance tabs (the smallest legacy radius is
            fully removed). All controls
            share the row via grid columns — no wrap, no second row, no
            horizontal overflow at 360 px. Compact text [11px]/padding/gap
            keeps everything visible on the smallest supported viewport;
            labels keep the master copy. "Tempat Pilihan" opens ONE curated
            discovery layer with no category tabs/chips. */}
        <div className="mb-4 grid grid-cols-[auto_auto_1fr_1fr_1fr] gap-1.5 pb-1">
          <button
            onClick={() => setLiveOnly((value) => !value)}
            aria-pressed={liveOnly}
            className={`inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-[16px] px-2 py-2 text-[11px] font-semibold tracking-wide transition sm:px-4 sm:text-xs ${
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
            className={`whitespace-nowrap rounded-[16px] px-2 py-2 text-[11px] font-bold transition sm:px-4 sm:text-xs ${
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
              className={`whitespace-nowrap rounded-[16px] px-1 py-2 text-center text-[11px] font-bold transition sm:px-4 sm:text-xs ${
                distanceFilter === filter && !curatedOnly
                  ? "bg-brand-accent text-white"
                  : "border border-black/10 bg-white text-black/65"
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* "Tempat Pilihan" is ONE curated discovery layer (PO 2026-09-26):
            no category chips and no secondary category row — Place
            categories stay internal data, never a Home filter UI. */}

        {/* LIVE filter empty state — a clear notice instead of an empty
            screen. Based only on canonical discovery data; no fake Live. */}
        {liveOnly && liveItems.length === 0 && (
          <div className="mb-5 rounded-2xl border border-live/30 bg-white p-6 text-center shadow-sm">
            <p className="text-sm font-bold">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className="mt-1 text-xs text-black/55">
              Ketika sebuah Tempat memulai Live, proses produksinya otomatis muncul di sini.
            </p>
            <button
              type="button"
              onClick={() => setLiveOnly(false)}
              className="mt-4 inline-flex rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white"
            >
              Lihat Semua Tempat
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
            isolate keeps Leaflet panes contained below the UI overlays.
            MAP-FIRST FRAME (PO, 2026-09-30 UI polish): the map is the primary
            visual element of Home — ~64vh tall, clamped between ~480px and
            ~760px, ~24px radius, subtle border, light shadow. This is
            presentation ONLY: camera values, coverage, marker model, controls,
            and the overlay z-index ladder are unchanged. The min/max clamp
            also keeps the map dominant and overflow-free at 360px and at
            1280px desktop. */}
        <section className="relative isolate h-[64vh] min-h-[480px] max-h-[760px] overflow-hidden rounded-[24px] border border-black/10 bg-[#d9dfd2] shadow-sm">
          <HomeMap
            places={mapPlaces}
            liveByPlaceId={liveByPlaceId}
            viewerPosition={viewerPosition}
            locateNonce={locateNonce}
            onRequestLocate={handleLocatePress}
            /* ONE deterministic camera preset for every mode (PO,
               2026-09-29; coverage unified by the product decision of
               2026-09-30): distance tabs map to their ordered preset radii
               (1 < 5 < 10 km) and "Tempat Pilihan" frames the SAME 10 km
               coverage. CAMERA-ONLY — the curated membership (canonical
               is_curated) and the curated LIST below stay independent of
               this value. */
            cameraRadiusMeters={
              curatedOnly ? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M[distanceFilter]
            }
            /* Instant-camera rule (PO, 2026-09-30): the camera itself applies
               with no animation at all, so entering "Tempat Pilihan" is made
               visually obvious by a SHORT (~450 ms) one-shot focus pulse on
               the EXISTING Current Location pin — no new marker, no map
               animation. */
            pulsePinOnPresetChange={curatedOnly}
            onViewportHasPlaces={handleViewportHasPlaces}
          />

          {/* Viewport-aware map empty state (PO, 2026-09-30): shown when the
              mode's dataset is empty OR when no Place currently sits in the
              REAL Leaflet viewport — it disappears/appears live as the user
              pans/zooms between populated and empty areas. Markers only ever
              come from canonical coordinates; none are invented, and the
              overlay never pretends a hidden Place is on the map.
              OVERLAY_LADDER: Leaflet's highest documented z-index is 1000
              (zoom control); z-[1100] pins this card strictly above every
              Leaflet pane (tile 200, map pane 400, tooltip 650, control
              1000) in any drag/zoom state — the visual fix for the mobile
              drag bug. */}
          {mapEmptyStateVisible && (
            <div className="absolute inset-x-6 top-1/2 z-[1100] -translate-y-1/2 rounded-2xl bg-white/95 p-4 text-center shadow-lg ring-1 ring-brand-ink/10">
              <p className="text-sm font-bold">
                {curatedOnly
                  ? "Belum ada Tempat Pilihan di sekitar area ini"
                  : "Belum ada Tempat Terdaftar di sekitar area ini"}
              </p>
              <p className="mt-1 text-xs text-black/55">
                Geser peta dengan dua jari untuk melihat area lain.
              </p>
            </div>
          )}

          {/* MOCKUP §8: coverage box, bottom-left of the map — white,
              rounded, compact, with a target icon and the ACTIVE camera
              radius in the copy (truthful label, never an invented state). */}
          <div className="absolute bottom-6 left-4 z-[1100] flex max-w-[70%] items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-md ring-1 ring-black/10">
            <span aria-hidden className="shrink-0 text-sm text-brand-ink">⌖</span>
            <p className="text-[11px] font-semibold leading-4 text-brand-ink">
              Menampilkan tempat dalam radius {activeRadiusLabel} dari lokasi Anda
            </p>
          </div>

          {/* MOCKUP §9: scale, bottom-right of the map — the label follows
              the ACTIVE camera radius (same truthful rule as the coverage
              box) and the line is the mockup's scale bar. React overlay at
              z-[1100] (above Leaflet's control ceiling), static composition. */}
          <div className="absolute bottom-6 right-4 z-[1100] flex flex-col items-end gap-1">
            <span className="text-[11px] font-bold text-brand-ink">{activeRadiusLabel}</span>
            <span aria-hidden className="block h-0.5 w-16 border-x-2 border-b-2 border-brand-ink/70" />
          </div>

          {/* Radius/status badge — OVERLAY_LADDER above the Leaflet ceiling.
              Color treatment (PO 2026-09-26): deep brand green fill keeps
              the badge readable on light/busy tiles; the accent ring
              reiterates the brand hierarchy without moving anything. */}
          <div className="absolute left-5 top-5 z-[1100] rounded-full bg-brand-primary px-4 py-2 text-xs font-bold text-white shadow-lg ring-2 ring-brand-accent/70">
            {liveOnly ? "LIVE • " : ""}
            {curatedOnly ? "Tempat Pilihan" : distanceFilter}
          </div>

          {/* No Place card/preview may cover the map surface (PO decision,
              2026-09-25): the map frame stays fully visible from top to
              bottom. Place detail stays in the proximity results section
              below the map. */}
        </section>

        {/* Place results — the DISCOVERY PLACE row is always built from the
            canonical `discovery.discovery` result (eligible Places only, in
            engine order), narrowed by search and the list radius. Inside the
            Tempat Pilihan layer the results render as TWO ordered rows —
            Baris 1: Tempat Pilihan, Baris 2: Discovery Place — while every
            other mode renders that single canonical row. No layer ever
            deduplicates the other: a Place in both layers appears in both
            rows (OVERLAP rule).

            MOCKUP §10/§11 (2026-10-01): the results are a WHITE PANEL with
            rounded top corners and a small centered handle that VISUALLY
            MERGES with the map above it (a small negative margin tucks it
            under the map frame). It is still a normal section in the page
            flow — the map keeps its full height and clipping boundary, and
            nothing ever covers the map surface (locked by
            tests/map-stacking.test.ts). The count line doubles as the
            mockup's "{n} tempat pilihan di sekitar Anda" subtitle. */}
        <section
          className="relative z-10 -mt-5 rounded-t-[24px] bg-brand-cream pb-2 pt-3"
          aria-labelledby="place-results-heading"
        >
          {/* Panel handle — small centered bar, mockup §10 (visual only). */}
          <span
            aria-hidden
            className="mx-auto mb-2.5 block h-1.5 w-12 rounded-full bg-black/15"
          />
          <div className="mb-3 flex items-end justify-between gap-3 px-1">
            <div>
              <h2 id="place-results-heading" className="text-xl font-bold">
                {searchQuery.trim()
                  ? `Hasil untuk “${searchQuery.trim()}”`
                  : curatedOnly
                    ? "Tempat Pilihan"
                    : "Discovery Place"}
              </h2>
              <p className="mt-1 text-xs font-semibold text-black/50">
                {/* Count semantics (PO, 2026-09-30): each layer counts ONLY
                    its own rows — the Tempat Pilihan header counts the
                    curated selection (Baris 1), never the Discovery Place row
                    beneath it; normal modes keep the Discovery Place count. */}
                {curatedOnly
                  ? `${curatedListed.length} tempat pilihan di sekitar Anda`
                  : `${discoveryRowPlaces.length} tempat di sekitar Anda`}
              </p>
            </div>
            {/* "Lihat semua" — non-inventive affordance: there is NO separate
                all-results page in the MVP (only /places/[id] exists), so the
                link scrolls to the rows themselves instead of inventing a
                destination. */}
            <a
              href="#place-results-heading"
              className="inline-flex shrink-0 items-center gap-0.5 text-xs font-bold text-brand-ink/80 transition hover:text-brand-ink"
            >
              Lihat semua <span aria-hidden>›</span>
            </a>
          </div>

          {/* Baris 1 (curated layer only): the Admin-promoted selection.
              Renders nothing when no Place is curated — the curated layer
              never substitutes the full published set.
              MOCKUP §12 (2026-10-01): the row is a HORIZONTAL STRIP at every
              viewport (mobile swipe AND desktop 1280) — same dataset, same
              order, same cards; presentation only. */}
          {curatedOnly && curatedListed.length > 0 && (
            <>
              <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-brand-ink/70">
                Tempat Pilihan
              </p>
              <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
                {curatedListed.map((place) => (
                  <div key={place.id} className="w-[70vw] max-w-[300px] shrink-0 snap-start">
                    {renderPlaceCard(place, place.isCurated)}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Baris 2 (curated layer) / the single row everywhere else: the
              canonical Discovery result — engine order, stars only, no
              numeric score. Source of eligibility is the engine's own
              discovery.discovery ids, never the published place list. */}
          {discoveryRowPlaces.length > 0 ? (
            <>
              {curatedOnly && (
                <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-brand-ink/70">
                  Discovery Place
                </p>
              )}
              {/* MOCKUP §12 (2026-10-01): horizontal strip at EVERY viewport
                  — the same snap-strip pattern as Baris 1. Same dataset, same
                  order, same cards (presentation only). */}
              <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
                {discoveryRowPlaces.map((place) =>
                  renderPlaceCard(place, curatedIdSet.has(place.id)),
                )}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-black/10 bg-white p-6 text-center">
              {searchQuery.trim() ? (
                <>
                  <p className="text-sm font-bold">Tempat tidak ditemukan</p>
                  <p className="mt-1 text-xs text-black/55">
                    Coba kata kunci atau radius yang berbeda.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-bold">Belum ada Discovery Place</p>
                  <p className="mt-1 text-xs text-black/55">
                    Tempat yang siap tayang akan muncul di sini secara otomatis.
                  </p>
                </>
              )}
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
