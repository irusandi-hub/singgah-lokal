import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AREA_COVERAGE_CAPTION,
  CAMERA_PRESET_RADIUS_M,
  CURATED_CAMERA_RADIUS_M,
  LOCAL_AREA_SEPARATION_RATIO,
  MAP_SCALE_MAX_BAR_PX,
  NO_ORIGIN_AREA_LABEL,
  boundsOfPoints,
  collectGeoPoints,
  describeCoverageCaption,
  describeNearOrigin,
  distanceMeters,
  narrowToViewport,
  resolveActiveCenter,
  resolveCameraFitPadding,
  resolveLocalAreaCoverage,
  resolveMapScale,
  type MapViewport,
} from "../lib/live/ui";

/**
 * LOCAL AREA COVERAGE + TRUTHFUL OVERLAYS (correction of 2026-10-03)
 *
 * Root cause this suite locks shut: after the auto-fit change the bounds
 * dataset handed to the camera was the ENTIRE content-filtered Place list, so
 * one focus ("Lokasi Saya" / "Tempat Pilihan") could frame West Java and Riyadh
 * in a single fit — a world view in which the viewer's own neighbourhood was a
 * couple of pixels wide. There was also no trusted local-area boundary anywhere
 * in the product to frame instead.
 *
 * The camera is now bounded by GEOGRAPHY, not by a radius: the viewer's LOCAL
 * AREA comes from the anchor Place's own canonical ISO country + subdivision,
 * or — where that data is absent — from a documented, scale-free separation
 * rule over the real Place distances. Nothing here is a fixed 10 km cap, an
 * arbitrary replacement radius, or a fallback to the whole database.
 *
 * The ten acceptance rules of this correction:
 *   1. no far-away global Place is framed with the local ones;
 *   2. every relevant Place of the determined local area is covered;
 *   3. no fixed 10 km cap bounds the camera;
 *   4. no Place is missing merely because the camera had not framed it;
 *   5. no recenter loop when markers or the viewport update;
 *   6. manual pan/zoom is respected until the user asks for a refocus;
 *   7. the Riyadh rendering is unchanged;
 *   8. the results panel is more compact without cutting content;
 *   9. the caption and the scale bar are accurate;
 *  10. no product boundary was crossed.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const mapCode = stripComments(homeMap);
const pageCode = stripComments(homeDiscovery);

type Row = {
  id: string;
  latitude: number;
  longitude: number;
  countryCode: string | null;
  regionName: string | null;
};

/** The ten real Riyadh DEV fixtures (migration 0040), verbatim coordinates. */
const RIYADH_PLACES: Row[] = [
  ["dummy-riyadh-olaya", 24.6937, 46.6853],
  ["dummy-riyadh-king-fahd", 24.7136, 46.6753],
  ["dummy-riyadh-malaz", 24.6895, 46.7211],
  ["dummy-riyadh-nakheel", 24.8325, 46.64],
  ["dummy-riyadh-kafd", 24.7152, 46.6801],
  ["dummy-riyadh-yasmin", 24.7058, 46.6918],
  ["dummy-riyadh-sulaymaniyah", 24.7089, 46.679],
  ["dummy-riyadh-umm-al-hamam", 24.7833, 46.6661],
  ["dummy-riyadh-al-izza", 24.8241, 46.6432],
  ["dummy-riyadh-tahlia", 24.7247, 46.6823],
].map(([id, latitude, longitude]) => ({
  id: id as string,
  latitude: latitude as number,
  longitude: longitude as number,
  countryCode: "SA",
  regionName: "Ash Sharqiyah",
}));

/** The West Java DEV fixtures — a different country AND subdivision. */
const WEST_JAVA_PLACES: Row[] = [
  ["kopi-dari-kebun", -6.8214, 107.5849],
  ["lembang", -6.8325, 107.6181],
  ["toko-kopi", -6.9115, 107.6098],
  ["ciwidey", -6.9497, 107.6161],
].map(([id, latitude, longitude]) => ({
  id: id as string,
  latitude: latitude as number,
  longitude: longitude as number,
  countryCode: "ID",
  regionName: "Jawa Barat",
}));

const WORLD = [...WEST_JAVA_PLACES, ...RIYADH_PLACES];
const RIYADH_CENTER = { lat: 24.7136, lng: 46.6753 };
const BANDUNG = { lat: -6.9, lng: 107.61 };
/** The widest possible "visible area" — used to prove the gates still drop. */
const WORLD_VIEWPORT: MapViewport = { north: 85, south: -85, east: 180, west: -180 };

function widestSpan(places: Row[]): number {
  const lats = places.map((place) => place.latitude);
  const lngs = places.map((place) => place.longitude);
  return Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs));
}

function withoutGeography(places: Row[]): Row[] {
  return places.map((place) => ({ ...place, countryCode: null, regionName: null }));
}

function distance(origin: { lat: number; lng: number }, place: Row): number {
  return distanceMeters(origin, { lat: place.latitude, lng: place.longitude });
}

// ---------------------------------------------------------------------------
// 1. No far-away global Place is framed together with the local ones.
// ---------------------------------------------------------------------------

test("AC 1: Lokasi Saya can no longer frame a far-away global Place with the local ones", () => {
  for (const origin of [RIYADH_CENTER, BANDUNG]) {
    const coverage = resolveLocalAreaCoverage({ origin, places: WORLD });
    assert.equal(coverage.basis, "region");
    assert.ok(coverage.places.length > 0);
    const excluded = WORLD.filter((candidate) => !coverage.places.includes(candidate));
    // Nothing from the other side of the world may be in the frame, and every
    // framed Place is genuinely local to the fix.
    assert.ok(excluded.length > 0);
    for (const place of coverage.places) {
      assert.ok(distance(origin, place) < 1_000_000);
    }
    for (const place of excluded) {
      assert.ok(distance(origin, place) > 1_000_000);
    }
    // Executable form of the reported bug: the framed set is a fraction of the
    // dataset and its geographic spread is local, never intercontinental.
    assert.ok(coverage.places.length < WORLD.length);
    assert.ok(widestSpan(coverage.places) < 1);
    assert.ok(widestSpan(WORLD) > 30);
  }
  // And the component really feeds the camera THAT set, resolved around the
  // active center (the searched city, else the real fix).
  assert.match(pageCode, /resolveLocalAreaCoverage\(\{\s*\n\s*origin: searchCenter \?\? viewerPosition,\s*\n\s*places: candidates,/);
  assert.match(mapCode, /const applied = await fitCamera\(map, fitPlacesRef\.current\)/);
});

test("AC 1: no usable user location keeps the safe fallback — never a global fit", () => {
  // Geolocation denied and nothing searched: there is no origin, so there is no
  // area, so the camera keeps its current view instead of framing everything.
  for (const origin of [null, { lat: Number.NaN, lng: 0 }, { lat: 0, lng: Number.POSITIVE_INFINITY }]) {
    const coverage = resolveLocalAreaCoverage({ origin, places: WORLD });
    assert.equal(coverage.basis, "none");
    assert.deepEqual(coverage.places, []);
    assert.equal(coverage.anchorId, null);
  }
  // A Place without canonical coordinates never defines an area either.
  const coordinateLess = resolveLocalAreaCoverage({
    origin: BANDUNG,
    places: [
      { id: "a", latitude: null, longitude: null, countryCode: "ID", regionName: "Jawa Barat" },
      { id: "b", latitude: Number.NaN, longitude: 0, countryCode: "ID", regionName: "Jawa Barat" },
    ],
  });
  assert.equal(coordinateLess.basis, "none");
  assert.deepEqual(coordinateLess.places, []);
  assert.equal(coordinateLess.consideredCount, 0);
});

// ---------------------------------------------------------------------------
// 2. The whole local area is covered, as completely as the data allows.
// ---------------------------------------------------------------------------

test("AC 2: every Place of the viewer's own area is framed", () => {
  const riyadh = resolveLocalAreaCoverage({ origin: RIYADH_CENTER, places: WORLD });
  assert.deepEqual(riyadh.places.map((place) => place.id), RIYADH_PLACES.map((place) => place.id));
  const bandung = resolveLocalAreaCoverage({ origin: BANDUNG, places: WORLD });
  assert.deepEqual(bandung.places.map((place) => place.id), WEST_JAVA_PLACES.map((place) => place.id));
  // The area really is the subdivision, not one Place: the whole Riyadh spread
  // (~15 km) and the whole West Java spread (~12 km) are inside it.
  assert.ok(widestSpan(riyadh.places) > 0.1);
  assert.ok(widestSpan(bandung.places) > 0.05);
});

test("AC 2: canonical Place order is preserved, whatever the area is", () => {
  const shuffled = [WORLD[7], WORLD[0], WORLD[9], WORLD[3], WORLD[11], WORLD[5]];
  const coverage = resolveLocalAreaCoverage({ origin: BANDUNG, places: shuffled });
  assert.deepEqual(
    coverage.places.map((place) => place.id),
    shuffled.filter((place) => place.countryCode === "ID").map((place) => place.id),
  );
});

test("AC 2: without trusted geography the adaptive rule keeps a compact local cluster", () => {
  const dataset = withoutGeography(WORLD);
  const riyadh = resolveLocalAreaCoverage({ origin: RIYADH_CENTER, places: dataset });
  assert.equal(riyadh.basis, "proximity");
  assert.ok(riyadh.places.length > 0);
  // The cluster is a genuine PREFIX of the distance ordering: every framed
  // Place is nearer than every excluded one, so the band around the fix can
  // never contain a hole and can never jump continents.
  const byDistance = [...dataset].sort((a, b) => distance(RIYADH_CENTER, a) - distance(RIYADH_CENTER, b));
  const lastFramed = Math.max(...riyadh.places.map((place) => distance(RIYADH_CENTER, place)));
  const firstExcluded = Math.min(
    ...dataset.filter((place) => !riyadh.places.includes(place)).map((place) => distance(RIYADH_CENTER, place)),
  );
  assert.ok(lastFramed <= firstExcluded);
  assert.deepEqual(
    riyadh.places.map((place) => place.id),
    byDistance.filter((place) => distance(RIYADH_CENTER, place) <= lastFramed).map((place) => place.id),
  );
  // Nothing on the other continent survives the rule.
  for (const place of riyadh.places) {
    assert.equal(place.countryCode, null);
    assert.ok(distance(RIYADH_CENTER, place) < 1_000_000);
  }
  // A Place sitting exactly ON the fix is not a separation on its own.
  const onTop = resolveLocalAreaCoverage({
    origin: BANDUNG,
    places: [
      { id: "here", latitude: BANDUNG.lat, longitude: BANDUNG.lng, countryCode: null, regionName: null },
      { id: "same", latitude: BANDUNG.lat, longitude: BANDUNG.lng, countryCode: null, regionName: null },
      { id: "far", latitude: 24.7136, longitude: 46.6753, countryCode: null, regionName: null },
    ],
  });
  assert.deepEqual(onTop.places.map((place) => place.id), ["here", "same"]);
  // The rule is scale-free: the same shape passes at neighbourhood scale and
  // at country scale, and it is NOT a distance in metres.
  assert.ok(LOCAL_AREA_SEPARATION_RATIO >= 2);
  const distances = [
    distance(BANDUNG, { id: "a", latitude: -6.9115, longitude: 107.6098, countryCode: null, regionName: null }),
    distance(BANDUNG, { id: "b", latitude: -6.9497, longitude: 107.6161, countryCode: null, regionName: null }),
    distance(BANDUNG, { id: "c", latitude: -6.8325, longitude: 107.6181, countryCode: null, regionName: null }),
  ];
  assert.ok(distances[1] >= distances[0] * LOCAL_AREA_SEPARATION_RATIO);
});

// ---------------------------------------------------------------------------
// 3. No fixed 10 km cap; the camera is bounded by the area, not by metres.
// ---------------------------------------------------------------------------

test("AC 3: a Place 25 km away is framed, a Place 400 km away is not", () => {
  const local: Row[] = [
    { id: "near", latitude: -6.9, longitude: 107.61, countryCode: "ID", regionName: "Jawa Barat" },
    { id: "far-in-region", latitude: -6.66, longitude: 107.9, countryCode: "ID", regionName: "Jawa Barat" },
  ];
  const span = distance(BANDUNG, local[1]);
  assert.ok(span > 25_000, `fixture must exceed 10 km (got ${Math.round(span / 1000)} km)`);
  const coverage = resolveLocalAreaCoverage({ origin: BANDUNG, places: [...local, ...RIYADH_PLACES] });
  assert.deepEqual(coverage.places.map((place) => place.id), ["near", "far-in-region"]);

  // The old 10 km cap is not what bounds the frame any more, and the curated
  // display radius never reaches the camera as a cap.
  const fitBranch = mapCode.slice(
    mapCode.indexOf("if (fitChanged) {"),
    mapCode.indexOf("const anchor = cameraCenter ?? viewerPosition;"),
  );
  assert.doesNotMatch(fitBranch, /radiusZoom|10_000|10000|LAT_M/);
  assert.doesNotMatch(pageCode, /resolveLocalAreaCoverage\(\{[^}]*10000/);
  // The distance tabs keep their own ordered presets — untouched by this rule.
  assert.equal(CAMERA_PRESET_RADIUS_M["10 km+"], 10_000);
  assert.equal(CURATED_CAMERA_RADIUS_M, 10_000);
  assert.ok(CAMERA_PRESET_RADIUS_M["1 km"] < CAMERA_PRESET_RADIUS_M["5 km"]);
  assert.ok(CAMERA_PRESET_RADIUS_M["5 km"] < CAMERA_PRESET_RADIUS_M["10 km+"]);
});

// ---------------------------------------------------------------------------
// 4. No Place is missing merely because the camera had not framed it yet.
// ---------------------------------------------------------------------------

test("AC 4: the bounds dataset is still un-narrowed by the viewport", () => {
  // The local-area resolver reads the CONTENT filter one step before the
  // viewport gate, so a Place outside the current frame is still inside the
  // area. Since the 2026-10-03 correction #2 the curated camera pool is the
  // SELECTED Places only (`visiblePlaces` already resolves curated membership);
  // the ordinary remainder stays a marker-layer decision.
  assert.match(pageCode, /const source = visiblePlaces;/);
  const fitPool = pageCode.slice(
    pageCode.indexOf("const cameraFitPlaces"),
    pageCode.indexOf("const searchFitPlaces"),
  );
  // The ordinary remainder is still a MARKER-layer decision (`mapPlaces`, §15
  // item 2) — it must not appear in the CAMERA pool.
  assert.doesNotMatch(fitPool, /const source = curatedOnly \?|curatedCoverageSource/);
  assert.match(pageCode, /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoveragePlaces\] : visiblePlaces;/);
  const fitDataset = pageCode.slice(
    pageCode.indexOf("const cameraFitPlaces"),
    pageCode.indexOf("const searchFitPlaces"),
  );
  assert.doesNotMatch(fitDataset, /mapViewport|coverageViewport|visibleMapPlaces|narrowToViewport/);
  assert.match(mapCode, /const fitPlacesRef = useRef<HomeMapPlace\[\]>\(fitPlaces\);/);
  // Membership is untouched: the resolver narrows GEOMETRY only, and no Place is
  // added to or removed from any row by it.
  assert.match(
    pageCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
});

// ---------------------------------------------------------------------------
// 5. No recenter loop.
// ---------------------------------------------------------------------------

test("AC 5: the frame an explicit request produced stays; nothing re-arms it", () => {
  // Every explicit request is recorded ONCE, before every early return, so it
  // can never be replayed later by an unrelated readiness or fix change.
  assert.match(mapCode, /const requestChanged = cameraRequestNonce !== lastRequestNonceRef\.current;/);
  assert.match(mapCode, /lastRequestNonceRef\.current = cameraRequestNonce;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // And the frame it produced is latched, so the NEXT geolocation fix cannot
  // re-frame the map to a radius preset the user did not ask for.
  const fitBranch = mapCode.slice(
    mapCode.indexOf("if (fitChanged) {"),
    mapCode.indexOf("const anchor = cameraCenter ?? viewerPosition;"),
  );
  assert.match(fitBranch, /userInteractedRef\.current = true;/);
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse]);"),
  );
  assert.match(locateEffect, /userInteractedRef\.current = true;/);
  // The radius path is guarded by the latch UNCONDITIONALLY (fix, 2026-10-03).
  // It used to compare the radius too, so ANY change of the radius value
  // re-armed the preset — leaving "Tempat Pilihan" through the LIVE toggle
  // silently snapped the camera back to a distance frame. Every explicit tab
  // choice bumps the request nonce above, so nothing legitimate is lost.
  assert.match(mapCode, /if \(userInteractedRef\.current\) return;/);
  assert.doesNotMatch(mapCode, /if \(radiusChanged\) userInteractedRef\.current = false;/);
  // No timer, debounce, or interval was introduced anywhere in the camera.
  assert.doesNotMatch(mapCode, /setInterval|setTimeout\([^)]*fit/);
});

// ---------------------------------------------------------------------------
// 6. Manual pan/zoom is respected until an explicit refocus.
// ---------------------------------------------------------------------------

test("AC 6: only the three hand-driven camera actions bump the request nonce", () => {
  assert.equal((pageCode.match(/setCameraRequestNonce\(\(nonce\) => nonce \+ 1\)/g) ?? []).length, 3);
  const tabHandler = pageCode.slice(
    pageCode.indexOf("setDistanceFilter(filter);"),
    pageCode.indexOf("setDistanceFilter(filter);") + 400,
  );
  assert.match(tabHandler, /setCameraRequestNonce/);
  const curatedHandler = pageCode.slice(
    pageCode.indexOf("const next = activateCuratedFilter();"),
    pageCode.indexOf("const next = activateCuratedFilter();") + 500,
  );
  assert.match(curatedHandler, /setCameraRequestNonce/);
  const locatePress = pageCode.slice(
    pageCode.indexOf("const handleLocatePress"),
    pageCode.indexOf("const liveByPlaceId"),
  );
  assert.match(locatePress, /setCameraRequestNonce/);
  // A real user gesture still latches the camera the same way.
  assert.match(mapCode, /if \(!programmaticMoveRef\.current\) userInteractedRef\.current = true;/);
  // Nothing automatic carries a request: no marker feed, viewport report, or
  // discovery poll may re-frame the map.
  assert.equal((pageCode.match(/setFitNonce\(\(nonce\) => nonce \+ 1\)/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// 7. Riyadh is unchanged.
// ---------------------------------------------------------------------------

test("AC 7: a searched city still frames its own Places through the untouched path", () => {
  // The search mechanism, its state, and its dataset are byte-for-byte the
  // pre-existing ones: the ±0.05° coverage box of the SEARCHED region.
  assert.match(pageCode, /const searchFitPlaces = useMemo<HomeMapPlace\[\]>\(\(\) => \{\s*if \(!searchViewport\) return \[\];\s*return narrowToViewport\(visiblePlaces, searchViewport\)/);
  assert.match(mapCode, /const applied = await fitCamera\(map, searchFitPlacesRef\.current\);/);
  assert.match(mapCode, /if \(cancelled \|\| applied\) return;/);
  // The search answer is untouched: same debounce, same route, same guards.
  assert.match(pageCode, /setTimeout\(\(\) => \{\s*runSearch\(searchQuery\);/);
  assert.match(pageCode, /fetch\(`\/api\/geocode\?q=\$\{encodeURIComponent\(trimmed\)\}`/);
  // The whole Riyadh dataset survives the local-area resolver intact, so a
  // viewer there gets the same complete result set as before.
  const riyadh = resolveLocalAreaCoverage({ origin: RIYADH_CENTER, places: WORLD });
  assert.equal(riyadh.places.length, RIYADH_PLACES.length);
  assert.equal(riyadh.consideredCount, WORLD.length);
});

// ---------------------------------------------------------------------------
// 7b. "My Location" REALLY refits — the whole 0/1/many/denied matrix.
//
// This block exists because the first version of the local-area work left
// "Lokasi Saya" as a bare recentre at the previous zoom. The requested
// behaviour is that the press FRAMES the eligible local distribution, so the
// component is asserted for each case explicitly, and the fit bounds are
// computed here with the SAME helpers the camera uses.
// ---------------------------------------------------------------------------

/** The exact bounds `fitCamera` would build for a candidate list. */
function fitBoundsOf(candidates: Row[]): MapViewport | null {
  const points = collectGeoPoints(
    candidates.map((place) => ({ latitude: place.latitude, longitude: place.longitude })),
  );
  return boundsOfPoints(points);
}

test("AC 1: \"My Location\" refits the local distribution instead of recentring at the previous zoom", () => {
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera]);"),
  );
  // It is NOT a bare setView at the current zoom: the frame comes from the
  // local-area candidates through the shared fit mechanism.
  assert.match(locateEffect, /await fitCamera\(map, candidates, LOCATE_FIT_MAX_ZOOM\)/);
  assert.doesNotMatch(locateEffect, /Math\.max\(map\.getZoom\(\), LOCATE_MIN_ZOOM\),\s*\{ animate: false \}\);\s*return;/);
  // It reuses the ONE fit mechanism — no second camera system was added.
  assert.equal((mapCode.match(/const fitCamera = useCallback/g) ?? []).length, 1);
  // The page hands it the local-area dataset under its own prop and trigger.
  assert.match(pageCode, /locateFitPlaces=\{locateFitPlaces\}/);
  assert.match(pageCode, /const locateFitPlaces = cameraFitPlaces;/);
  assert.match(mapCode, /locateFitPlaces = \[\],/);
});

test("AC 2: all eligible local candidates contribute, including ones outside the viewport", () => {
  // A 25 km spread inside one trusted subdivision: every candidate is in the
  // bounds, none of them is filtered by what happens to be on screen.
  const spread: Row[] = [
    { id: "near", latitude: -6.9115, longitude: 107.6098, countryCode: "ID", regionName: "Jawa Barat" },
    { id: "far", latitude: -6.66, longitude: 107.9, countryCode: "ID", regionName: "Jawa Barat" },
    { id: "distant", latitude: 24.7136, longitude: 46.6753, countryCode: "SA", regionName: "Ash Sharqiyah" },
  ];
  const coverage = resolveLocalAreaCoverage({ origin: BANDUNG, places: spread });
  assert.deepEqual(coverage.places.map((place) => place.id), ["near", "far"]);
  const bounds = fitBoundsOf(coverage.places);
  assert.ok(bounds);
  // The frame is the WHOLE local distribution — it zooms out far enough.
  assert.ok(bounds.north - bounds.south > 0.2, "the fit covers the 25 km spread");
  assert.equal(coverage.places.includes(spread[2]), false, "the Riyadh Place never enters the local bounds");
});

test("AC 3: ONE local Place + the user is focused sensibly, with no radius", () => {
  const single = resolveLocalAreaCoverage({
    origin: BANDUNG,
    places: [
      { id: "only", latitude: -6.9115, longitude: 107.6098, countryCode: "ID", regionName: "Jawa Barat" },
    ],
  });
  assert.deepEqual(single.places.map((place) => place.id), ["only"]);
  // The camera adds the user's own coordinate, so the frame is the pair — a
  // real neighbourhood frame, never a street-level jump and never a 10 km cap.
  const bounds = fitBoundsOf([
    ...single.places,
    { id: "__viewer_position__", latitude: BANDUNG.lat, longitude: BANDUNG.lng, countryCode: null, regionName: null },
  ]);
  assert.ok(bounds);
  assert.ok(bounds.north - bounds.south > 0.002 && bounds.north - bounds.south < 0.1);
  // The fit's ceiling is a ZOOM LEVEL that can only widen the frame.
  assert.match(mapCode, /const LOCATE_FIT_MAX_ZOOM = (\d+);/);
  assert.match(mapCode, /\.\.\.\(typeof maxZoom === "number" \? \{ maxZoom \} : \{\}\),/);
});

test("AC 3: NO local Place focuses the user's coordinate alone — never a distant Place", () => {
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera]);"),
  );
  // The component-level rule is what matters: with NO eligible local Place the
  // fit candidate list is EMPTY (the user's own point is not faked into a
  // Place), so the fit refuses to move and the fallback focuses the user.
  assert.match(locateEffect, /localPlaces\.length > 0/);
  assert.match(locateEffect, /: \[\];/);
  assert.match(locateEffect, /map\.setView\(\[viewerPosition\.lat, viewerPosition\.lng\]/);
  // ...and with no fix at all there is NO camera move whatsoever.
  // Executable proof of the empty case: no candidate, no bounds, no move.
  assert.equal(boundsOfPoints(collectGeoPoints([])), null);
});

test("AC 3: denied geolocation performs NO fit at all", () => {
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera]);"),
  );
  // The request stays PENDING and resolves on the first real fix; the dataset
  // is empty without one, so a global fit is impossible by construction.
  assert.match(locateEffect, /locatePendingRef\.current = true;/);
  assert.match(locateEffect, /locatePendingRef\.current = false;/);
  assert.equal(resolveLocalAreaCoverage({ origin: null, places: WORLD }).places.length, 0);
  assert.equal(resolveLocalAreaCoverage({ origin: { lat: Number.NaN, lng: 1 }, places: WORLD }).places.length, 0);
  assert.match(pageCode, /\(\) => undefined,\s*\{\s*timeout: 8000\s*\}/);
});

test("AC 3: the frame is applied once and then left alone", () => {
  // Unsolicited geolocation updates, marker refreshes, and viewport reports
  // cannot re-fit: the locate fit is keyed on the nonce alone and latched.
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera]);"),
  );
  assert.match(
    mapCode,
    /if \(!locateNonce \|\| lastLocateNonceRef\.current === locateNonce\) return;/,
    "the locate fit is keyed on the nonce alone, so it can never re-run on its own",
  );
  assert.match(locateEffect, /userInteractedRef\.current = true;/);
  assert.match(mapCode, /if \(userInteractedRef\.current\) return;/);
  // A radius preset that DID apply latches too (fix, 2026-10-03), so a later
  // geolocation fix cannot silently re-derive the frame underneath a pan.
  const presetBranch = mapCode.slice(
    mapCode.indexOf("if (cameraRadiusMeters !== null) {"),
    mapCode.indexOf("// No preset at all (cameraRadiusMeters === null)"),
  );
  assert.match(
    presetBranch,
    /map\.setView\(\[anchor\.lat, anchor\.lng\], Math\.max\(2, zoom\), \{ animate: false \}\);\s*userInteractedRef\.current = true;/,
  );
  // Manual pan/zoom survives until an explicit request releases the latch.
  assert.match(mapCode, /if \(!programmaticMoveRef\.current\) userInteractedRef\.current = true;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // And only the three hand-driven actions can produce that request.
  assert.equal((pageCode.match(/setCameraRequestNonce\(\(nonce\) => nonce \+ 1\)/g) ?? []).length, 3);
});

test("CHANGE B: Selected Places fit the eligible SELECTED distribution, not the whole layer", () => {
  const fitPool = pageCode.slice(
    pageCode.indexOf("const cameraFitPlaces"),
    pageCode.indexOf("const searchFitPlaces"),
  );
  // The camera pool is the SELECTED places `visiblePlaces` resolves from the
  // canonical curated ids — the ordinary remainder is a marker-layer rule.
  assert.match(fitPool, /const source = visiblePlaces;/);
  assert.doesNotMatch(fitPool, /curatedCoverageSource/);
  assert.match(
    pageCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
  // Eligible-but-not-curated Places can therefore never steer that camera,
  // while the curated MAP still shows both layers.
  assert.match(pageCode, /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoveragePlaces\] : visiblePlaces;/);
  // Two selected Places ~25 km apart: the fit must span both, which no 10 km
  // circle could ever contain.
  const selected: Row[] = [
    { id: "sel-a", latitude: -6.9115, longitude: 107.6098, countryCode: "ID", regionName: "Jawa Barat" },
    { id: "sel-b", latitude: -6.66, longitude: 107.9, countryCode: "ID", regionName: "Jawa Barat" },
  ];
  const bounds = fitBoundsOf(resolveLocalAreaCoverage({ origin: BANDUNG, places: selected }).places);
  assert.ok(bounds && bounds.north - bounds.south > 0.2);
  // The curated list, its membership, and the counts are untouched.
  assert.match(
    pageCode,
    /const curatedListed = useMemo\(\s*\(\) => narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
});

// ---------------------------------------------------------------------------
// 8. The results panel is more compact without cutting content.
// ---------------------------------------------------------------------------

test("AC 8: the panel and the map window above it are more compact", () => {
  // MOBILE MAP BUDGET (fix, 2026-10-03): the map window's FLOOR is now sized
  // from the floating control ladder, because at 240px the section ended above
  // the bottom of the zoom control and clipped it on an ordinary phone.
  assert.match(pageCode, /h-\[42vh\] min-h-\[440px\] max-h-\[560px\] sm:h-\[46vh\]/);
  assert.doesNotMatch(pageCode, /min-h-\[240px\]|sm:h-\[38vh\]/);
  // ...and the panel's own padding went with it.
  assert.match(
    pageCode,
    /<section\s*\n\s*className="relative z-10 -mt-5 rounded-t-\[24px\] bg-brand-cream pb-1 pt-2/,
  );
  assert.match(pageCode, /mx-auto mb-1\.5 block h-1\.5 w-12 rounded-full bg-black\/15/);
  assert.match(pageCode, /mb-2 flex items-end justify-between gap-3 px-1/);
  // NOTHING important was cut: the title, the count, the "Ke hasil" link, the
  // category labels, both strips, and both carousel frames are all still there.
  assert.match(pageCode, /id="place-results-heading"/);
  assert.match(pageCode, /\{curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\}`/);
  assert.match(pageCode, /Ke hasil <span aria-hidden>›<\/span>/);
  assert.match(pageCode, />\s*Tempat Pilihan\s*\n\s*<\/p>/);
  assert.match(pageCode, />\s*Discovery Place\s*\n\s*<\/p>/);
  assert.equal((pageCode.match(/-mx-4 overflow-hidden border-y border-black\/10 bg-white\/70 py-1\.5"/g) ?? []).length, 2);
  assert.equal(
    (pageCode.match(/-mx-4 flex snap-x snap-mandatory gap-2\.5 overflow-x-auto px-4 pb-1"/g) ?? []).length,
    2,
  );
  assert.equal(
    (pageCode.match(/w-\[46vw\] max-w-\[200px\] min-w-\[132px\] shrink-0 snap-start/g) ?? []).length,
    2,
  );
  // The results panel still tucks under the map by the same small margin, so it
  // never covers more of the Place cards than before.
  assert.match(pageCode, /relative z-10 -mt-5 rounded-t-\[24px\]/);
});

// ---------------------------------------------------------------------------
// 9. The overlay caption and the scale bar are accurate.
// ---------------------------------------------------------------------------

test("AC 9: the caption names a radius only while a radius preset owns the frame", () => {
  // The neutral wording: no distance, no radius, no invented state.
  assert.equal(AREA_COVERAGE_CAPTION, "Menampilkan tempat di area peta");
  assert.doesNotMatch(AREA_COVERAGE_CAPTION, /km|m\b|radius/);
  assert.match(pageCode, /const coverageCaption = describeCoverageCaption\(\{/);
  assert.match(pageCode, /hasCenter: hasActiveCenter,/);
  assert.match(pageCode, /text-brand-ink">\{coverageCaption\}<\/p>/);
  // Which rule owns the frame is set by the SAME handlers that move the camera —
  // never inferred afterwards, and never from the radius constant.
  const locatePress = pageCode.slice(
    pageCode.indexOf("const handleLocatePress"),
    pageCode.indexOf("const liveByPlaceId"),
  );
  assert.match(locatePress, /setCameraCoverage\("area"\)/);
  const curatedHandler = pageCode.slice(
    pageCode.indexOf("const next = activateCuratedFilter();"),
    pageCode.indexOf("const next = activateCuratedFilter();") + 500,
  );
  assert.match(curatedHandler, /setCameraCoverage\("area"\)/);
  const tabHandler = pageCode.slice(
    pageCode.indexOf("setDistanceFilter(filter);"),
    pageCode.indexOf("setDistanceFilter(filter);") + 400,
  );
  assert.match(tabHandler, /setCameraCoverage\("radius"\)/);
});

test("AC 9: the scale bar is measured from the real viewport, never from a radius", () => {
  // The chip is gone as a radius readout: the label is the measured scale and
  // the bar is drawn at that distance's exact pixel length.
  assert.doesNotMatch(pageCode, /\{activeRadiusLabel\}/);
  assert.match(pageCode, /\{mapScale\.label\}/);
  assert.match(pageCode, /style=\{\{ width: mapScale\.barPx \}\}/);
  // Measured from THIS map's own bounds and width, reported on the same events
  // as the viewport, and deduped so a settled viewport never re-renders.
  assert.match(mapCode, /const scale = resolveMapScale\(\{ bounds: viewport, widthPx: map\.getSize\(\)\.x \}\);/);
  assert.match(mapCode, /onScaleChangeRef\.current\?\.\(scale\);/);
  assert.match(mapCode, /if \(scaleKey !== lastScaleRef\.current\)/);
  assert.match(pageCode, /onScaleChange=\{handleScaleChange\}/);
});

test("AC 9: the scale resolver is a real, fail-closed measurement", () => {
  const viewport: MapViewport = { north: 24.75, south: 24.68, east: 46.73, west: 46.63 };
  const scale = resolveMapScale({ bounds: viewport, widthPx: 360 });
  assert.ok(scale);
  // ~10 km across a 360 px map, so the bar must state a round distance that
  // really fits the viewport at that ground resolution.
  assert.ok(scale.metersPerPixel > 20 && scale.metersPerPixel < 40);
  assert.equal(scale.label, "1 km");
  assert.ok(scale.barPx <= MAP_SCALE_MAX_BAR_PX);
  assert.ok(Math.abs(scale.barPx - Math.round(scale.meters / scale.metersPerPixel)) <= 1);
  // Zooming IN must shorten the resolution and lengthen the bar for the same
  // label — a radius readout could not do that.
  const zoomedIn = resolveMapScale({ bounds: { ...viewport, north: 24.72, south: 24.71, east: 46.69, west: 46.68 }, widthPx: 360 });
  assert.ok(zoomedIn);
  assert.ok(zoomedIn.metersPerPixel < scale.metersPerPixel);
  // Fail-closed: an unmeasured container or a degenerate box yields NO scale,
  // and the caller then draws none at all.
  assert.equal(resolveMapScale({ bounds: viewport, widthPx: 0 }), null);
  assert.equal(resolveMapScale({ bounds: viewport, widthPx: Number.NaN }), null);
  assert.equal(resolveMapScale({ bounds: { north: 1, south: 1, east: 1, west: 1 }, widthPx: 360 }), null);
  assert.equal(
    resolveMapScale({ bounds: { north: Number.NaN, south: 0, east: 1, west: 0 }, widthPx: 360 }),
    null,
  );
  // Every bar stays inside the budget, at every realistic viewport width.
  for (const widthPx of [320, 360, 390, 430, 1280]) {
    for (const span of [0.001, 0.05, 1, 20, 180, 360]) {
      const drawn = resolveMapScale({
        bounds: { north: 0 + span / 2, south: 0 - span / 2, east: span, west: 0 },
        widthPx,
      });
      if (!drawn) continue;
      assert.ok(drawn.barPx <= MAP_SCALE_MAX_BAR_PX, `bar ${drawn.barPx}px overflows the budget`);
      assert.ok(drawn.barPx >= 1);
      assert.match(drawn.label, /^(\d+ m|\d+ km)$/);
    }
  }
});

// ---------------------------------------------------------------------------
// 10. No product boundary was crossed.
// ---------------------------------------------------------------------------

test("AC 10: membership, data, eligibility, and the distance tabs are untouched", () => {
  for (const forbidden of [/checkout/i, /payment/i, /wallet|escrow|settlement/i, /keranjang|cart/i]) {
    assert.doesNotMatch(pageCode, forbidden);
    assert.doesNotMatch(mapCode, forbidden);
  }
  // No backend / database / RLS / Place-status surface was touched.
  assert.equal(/supabase|from\("places"\)|publication_status|admin/i.test(mapCode), false);
  assert.equal(/supabase|from\("places"\)|publication_status|RLS|policy/i.test(pageCode), false);
  // Curated MEMBERSHIP still comes only from the canonical `places.is_curated`
  // ids, and the Discovery engine is never consulted by the camera.
  assert.match(pageCode, /const curatedIdSet = useMemo\(/);
  assert.equal(/discovery\b/.test(pageCode.slice(pageCode.indexOf("const cameraFitPlaces"), pageCode.indexOf("const searchFitPlaces"))), false);
  // The resolver only reads canonical, already-stored geography.
  assert.match(pageCode, /countryCode: place\.countryCode,\s*\n\s*regionName: place\.regionName,/);
  assert.equal(/countryCode\s*:\s*"(ID|SA)"|regionName\s*:\s*"(Jawa Barat|Ash Sharqiyah)"/.test(pageCode), false);
  // No Place coordinate is invented, defaulted, or rounded anywhere.
  assert.equal(/Math\.random|Date\.now\(\)\s*%\s*90|toFixed\(\d\)\s*as number/.test(pageCode), false);
});
// ---------------------------------------------------------------------------
// 10. NO-ORIGIN CAMERA SCOPE (fix, 2026-10-03)
//
// ROOT CAUSE THIS SECTION LOCKS SHUT: the camera has exactly ONE anchor — the
// active center, i.e. the searched city or the REAL device fix. When neither
// exists (geolocation denied/never granted and nothing searched),
// `resolveActiveCenter` answers `center: null`, so the distance preset has no
// anchor and the anchor effect returned before it could move anything. The map
// therefore stayed on the neutral `fitWorld()` overview, the viewport then
// admitted the WHOLE canonical dataset, and the coverage box still claimed
// "… dari lokasi Anda" about a world-scale frame.
//
// The three properties held below:
//   · no origin  -> NO radius claim anywhere (map caption AND results count),
//     and no camera move is invented to satisfy the claim;
//   · an origin  -> the radius preset is applied once, centred on the ACTIVE
//     center (searched city first, else the device fix), and then LATCHED;
//   · the camera is moved ONLY by an explicit request — a marker refresh, a
//     discovery poll, a viewport report, a later geolocation fix, or a mode
//     switch that silently changes the radius value may never move it.
// ---------------------------------------------------------------------------

const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("10.1 the caption names a radius ONLY with a real origin behind it", () => {
  // The full truth table. "coverage" answers "does a distance preset really own
  // the frame"; "hasCenter" answers "is there anything to measure a radius
  // from". Both must be true before a radius may be printed.
  const radius = { radiusLabel: "1 km", mode: "device_location", placeName: null } as const;
  assert.equal(describeCoverageCaption({ ...radius, coverage: "radius", hasCenter: true }), "Menampilkan tempat dalam radius 1 km dari lokasi Anda");
  assert.equal(describeCoverageCaption({ ...radius, coverage: "area", hasCenter: true }), AREA_COVERAGE_CAPTION);
  // THE BUG: no origin at all -> the radius claim is dropped.
  assert.equal(describeCoverageCaption({ ...radius, coverage: "radius", hasCenter: false }), AREA_COVERAGE_CAPTION);
  assert.equal(describeCoverageCaption({ ...radius, coverage: "area", hasCenter: false }), AREA_COVERAGE_CAPTION);
  // The searched city keeps naming ITSELF, never the device.
  const city = describeCoverageCaption({
    radiusLabel: "10 km",
    mode: "city_search",
    placeName: "Riyadh",
    coverage: "radius",
    hasCenter: true,
  });
  assert.ok(city.includes("Riyadh"));
  assert.equal(city.includes("lokasi Anda"), false);
  // The neutral caption is the same one the local-area modes use: no distance,
  // no radius, no origin invented.
  assert.equal(AREA_COVERAGE_CAPTION, "Menampilkan tempat di area peta");
  assert.doesNotMatch(AREA_COVERAGE_CAPTION, /km|m\b|radius|lokasi/i);
});

test("10.2 the results count never claims an origin that does not exist", () => {
  // Existing Master/MOCKUP §11 wording is preserved VERBATIM whenever there
  // IS an origin — this fix changes nothing about the normal case.
  assert.equal(describeNearOrigin({ mode: "device_location", placeName: null }), "di sekitar Anda");
  assert.equal(describeNearOrigin({ mode: "device_location", placeName: null, hasCenter: true }), "di sekitar Anda");
  assert.equal(describeNearOrigin({ mode: "city_search", placeName: "Riyadh" }), "di sekitar pusat pencarian Riyadh");
  // No origin: the count describes the visible map area instead, using the
  // same wording as the caption so the two can never contradict each other.
  assert.equal(describeNearOrigin({ mode: "device_location", placeName: null, hasCenter: false }), NO_ORIGIN_AREA_LABEL);
  assert.equal(describeNearOrigin({ mode: "city_search", placeName: "Riyadh", hasCenter: false }), NO_ORIGIN_AREA_LABEL);
  assert.equal(/Anda/.test(NO_ORIGIN_AREA_LABEL), false);
});

test("10.3 a denied location yields NO center, and never a fabricated one", () => {
  // The three real states of the world, run through the ONE resolver.
  assert.deepEqual(resolveActiveCenter({ searchCenter: null, viewerPosition: null }), {
    mode: "device_location",
    center: null,
  });
  assert.deepEqual(resolveActiveCenter({ searchCenter: null, viewerPosition: BANDUNG }), {
    mode: "device_location",
    center: BANDUNG,
  });
  assert.deepEqual(resolveActiveCenter({ searchCenter: RIYADH_CENTER, viewerPosition: BANDUNG }), {
    mode: "city_search",
    center: RIYADH_CENTER,
  });
  // A non-finite "fix" is not a fix — it can never become a camera anchor.
  assert.equal(resolveActiveCenter({ searchCenter: null, viewerPosition: { lat: Number.NaN, lng: 0 } }).center, null);
  // An unusable SEARCH answer falls back to the device fix — it never becomes
  // a camera anchor of its own, and never blanks a real one.
  assert.deepEqual(resolveActiveCenter({ searchCenter: { lat: 0, lng: Number.NaN }, viewerPosition: BANDUNG }).center, BANDUNG);

  // And the camera really does bail out before it could invent a frame.
  assert.match(mapCode, /const anchor = cameraCenter \?\? viewerPosition;/);
  assert.match(mapCode, /if \(!ready \|\| !map \|\| !anchor\) return;/);
  // The ONLY place this component creates a coordinate out of nothing is the
  // neutral init overview, which is deliberately the whole world — never a
  // default city, country, or Place coordinate.
  assert.match(mapCode, /map\.fitWorld\(\);/);
  assert.equal(/-6\.9|107\.6|24\.71|46\.67/.test(mapCode), false);
});

test("10.4 a radius preset is centred on the ACTIVE center and applied once", () => {
  const anchorEffect = mapCode.slice(
    mapCode.indexOf("const cameraCenterKey"),
    mapCode.indexOf("// Render/update the user marker"),
  );
  // The searched city wins over the device fix while a search is active.
  assert.match(anchorEffect, /const anchor = cameraCenter \?\? viewerPosition;/);
  // The zoom comes from the RADIUS ALONE, never from the Place set and never
  // from the current zoom — so a far-away Place cannot widen the frame.
  assert.match(anchorEffect, /const zoom = await radiusZoom\(map, anchor, cameraRadiusMeters\);/);
  assert.equal(/radiusZoom\(map, anchor, cameraRadiusMeters/.test(mapCode), true);
  // Applied exactly once, then LATCHED: the frame it produced stays.
  assert.match(
    anchorEffect,
    /map\.setView\(\[anchor\.lat, anchor\.lng\], Math\.max\(2, zoom\), \{ animate: false \}\);\s*userInteractedRef\.current = true;/,
  );
  // The caller wires the preset and the active center; the tabs own the radius.
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
  assert.match(pageCode, /cameraCenter=\{activeCenter\}/);
  assert.equal(CAMERA_PRESET_RADIUS_M["1 km"] < CAMERA_PRESET_RADIUS_M["5 km"], true);
  assert.equal(CAMERA_PRESET_RADIUS_M["5 km"] < CAMERA_PRESET_RADIUS_M["10 km+"], true);
});

test("10.5 only an EXPLICIT request may move the camera", () => {
  // Three hand-driven actions, and nothing else, bump the request nonce.
  assert.equal((pageCode.match(/setCameraRequestNonce\(\(nonce\) => nonce \+ 1\)/g) ?? []).length, 3);
  // The guard is UNCONDITIONAL: a frame the user (or an applied preset) owns is
  // never re-derived. The old radius comparison let a silent mode switch — the
  // LIVE toggle leaving "Tempat Pilihan", which changes the radius value with
  // no request at all — snap the camera back to a distance frame.
  assert.match(mapCode, /if \(userInteractedRef\.current\) return;/);
  assert.equal(/if \(userInteractedRef\.current && lastRadiusRef\.current === cameraRadiusMeters\) return;/.test(mapCode), false);
  assert.equal(/if \(radiusChanged\) userInteractedRef\.current = false;/.test(mapCode), false);
  // Manual pan/zoom is what arms it, and only an explicit request disarms it.
  assert.match(mapCode, /if \(!programmaticMoveRef\.current\) userInteractedRef\.current = true;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // Marker refreshes and viewport reports carry NO nonce of any kind.
  const markerEffect = mapCode.slice(
    mapCode.indexOf("}, [ready, markerKey]);") - 4000,
    mapCode.indexOf("}, [ready, markerKey]);"),
  );
  assert.equal(/setView|fitBounds|flyTo/.test(markerEffect), false);
  assert.match(mapCode, /reportViewportBounds/);
  const reportViewport = mapCode.slice(
    mapCode.indexOf("const reportViewportBounds = useCallback"),
    mapCode.indexOf("const triggerLocatePulse"),
  );
  assert.equal(/setView|fitBounds|flyTo/.test(reportViewport), false);
  // The whole component stays animation-free.
  assert.equal(/flyTo\(|setTimeout\([^)]*duration/.test(mapCode), false);
});

test("10.6 widely spread Places can never widen a LOCAL-AREA frame", () => {
  // The real two-continent DEV dataset: West Java and Riyadh together.
  for (const origin of [BANDUNG, RIYADH_CENTER]) {
    const bounded = resolveLocalAreaCoverage({ origin, places: WORLD }).places;
    assert.ok(bounded.length > 0);
    // A world-scale frame is the failure this closes: the bounded set is
    // orders of magnitude tighter than the whole dataset.
    assert.ok(
      widestSpan(bounded) * 20 < widestSpan(WORLD),
      `the local area must be far tighter than the dataset (origin ${origin.lat})`,
    );
    // Every selected Place is genuinely local to the origin...
    const localIds = new Set(bounded.map((place) => place.id));
    const foreign = WORLD.filter((place) => !localIds.has(place.id));
    for (const place of foreign) {
      assert.ok(distance(origin, place) > 1000, "a far-away Place must not join the frame");
    }
    // ...and it is a real subdivision, not a truncated list.
    assert.equal(new Set(bounded.map((place) => place.countryCode)).size, 1);
    // The proximity fallback bounds it too, even with no trusted geography.
    const fallback = resolveLocalAreaCoverage({
      origin,
      places: withoutGeography(WORLD),
    }).places;
    assert.ok(fallback.length > 0);
    assert.ok(widestSpan(fallback) * 20 < widestSpan(WORLD));
  }
  // And with no origin at all the camera dataset is EMPTY — never the world.
  const none = resolveLocalAreaCoverage({ origin: null, places: WORLD });
  assert.equal(none.basis, "none");
  assert.deepEqual(none.places, []);
});

test("10.7 a dataset with no valid coordinates keeps the current center", () => {
  const coordinateFree = WORLD.map(({ id }) => ({
    id,
    latitude: null,
    longitude: null,
    countryCode: "ID",
    regionName: "Jawa Barat",
  }));
  // The local-area resolver drops every Place it cannot place.
  assert.deepEqual(resolveLocalAreaCoverage({ origin: BANDUNG, places: coordinateFree }).places, []);
  // The coverage gate drops them too, so neither markers nor rows can claim a
  // Place the map cannot show.
  assert.deepEqual(narrowToViewport(coordinateFree, WORLD_VIEWPORT), []);
  // The camera never invents a coordinate out of an empty dataset...
  assert.equal(boundsOfPoints(collectGeoPoints(coordinateFree)), null);
  assert.equal(collectGeoPoints(coordinateFree).length, 0);
  // ...and a non-finite coordinate is treated exactly like a missing one.
  const broken = [{ id: "x", latitude: Number.NaN, longitude: 0 }];
  assert.deepEqual(collectGeoPoints(broken), []);
  assert.equal(boundsOfPoints(collectGeoPoints(broken)), null);
});

test("10.8 the map is never covered by its own overlays on a phone", () => {
  // The floating control ladder is a FIXED slice of the stage height, and the
  // section clips its overflow — so the map window's FLOOR has to clear all of
  // it. This is the arithmetic the previous 240px minimum violated: the zoom
  // stack alone ends at 354px, so the "+/-" control was cut off.
  const RE_CENTER_TOP = 190;
  const LOCATE_TOP = 240;
  const ZOOM_TOP = 290;
  const LEAFLET_ZOOM_HEIGHT = 64;
  const COVERAGE_BOTTOM_OFFSET = 36;
  const COVERAGE_HEIGHT = 40;
  assert.match(globalsCss, /\.singgah-home-map \.leaflet-top\.leaflet-right \{\s*top: 290px;/);
  assert.match(mapCode, /absolute right-3 top-\[190px\]/);
  assert.match(mapCode, /absolute right-3 top-\[240px\]/);
  assert.match(pageCode, /h-\[42vh\] min-h-\[440px\] max-h-\[560px\] sm:h-\[46vh\]/);
  const floor = 440;
  assert.ok(floor >= ZOOM_TOP + LEAFLET_ZOOM_HEIGHT, "the zoom control must not be clipped");
  assert.ok(floor >= COVERAGE_BOTTOM_OFFSET + COVERAGE_HEIGHT, "the coverage box must fit");
  assert.ok(RE_CENTER_TOP < LOCATE_TOP, "the control ladder keeps its order");
  assert.ok(LOCATE_TOP < ZOOM_TOP, "the zoom stack stays BELOW both locate controls");
  // The camera padding reserves that same chrome, so a fit never hides a Place
  // under it.
  const padding = resolveCameraFitPadding({ x: 390, y: floor });
  assert.equal(padding.paddingTopLeft[0], 24);
  assert.equal(padding.paddingTopLeft[1], 190);
  assert.equal(padding.paddingBottomRight[0], 76);
  assert.equal(padding.paddingBottomRight[1], 84);
  assert.ok(padding.paddingTopLeft[1] >= 190, "the fitted area starts below the floating chrome");
  // Nothing was hidden, collapsed, or made scrollable: the panel still renders
  // both strips and the same count line.
  assert.match(pageCode, /rounded-t-\[24px\] bg-brand-cream/);
  assert.match(pageCode, /curatedListed\.length\} tempat pilihan \$\{nearOrigin\}/);
  assert.match(pageCode, /discoveryRowPlaces\.length\} tempat \$\{nearOrigin\}/);
});
