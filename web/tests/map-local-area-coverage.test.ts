import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AREA_COVERAGE_CAPTION,
  CAMERA_PRESET_RADIUS_M,
  CURATED_CAMERA_RADIUS_M,
  LOCAL_AREA_SEPARATION_RATIO,
  MAP_SCALE_MAX_BAR_PX,
  distanceMeters,
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
  // The local-area resolver reads the CONTENT filter (curated membership + the
  // ordinary remainder) one step before the viewport gate, so a Place outside
  // the current frame is still inside the area.
  assert.match(
    pageCode,
    /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoverageSource\] : visiblePlaces;/,
  );
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
  // The radius path stays guarded by the latch, so an automatic apply is
  // blocked while the user's own frame is on screen.
  assert.match(mapCode, /if \(userInteractedRef\.current && lastRadiusRef\.current === cameraRadiusMeters\) return;/);
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
// 8. The results panel is more compact without cutting content.
// ---------------------------------------------------------------------------

test("AC 8: the panel and the map window above it are more compact", () => {
  // The map window shrank by one clamp band...
  assert.match(pageCode, /h-\[36vh\] min-h-\[240px\] max-h-\[440px\] sm:h-\[38vh\]/);
  assert.doesNotMatch(pageCode, /h-\[42vh\]|max-h-\[520px\]/);
  // ...and the panel's own padding went with it.
  assert.match(
    pageCode,
    /<section\s*\n\s*className="relative z-10 -mt-5 rounded-t-\[24px\] bg-brand-cream pb-1\.5 pt-2\.5/,
  );
  assert.match(pageCode, /mx-auto mb-2 block h-1\.5 w-12 rounded-full bg-black\/15/);
  assert.match(pageCode, /mb-2\.5 flex items-end justify-between gap-3 px-1/);
  // NOTHING important was cut: the title, the count, the "Ke hasil" link, the
  // category labels, both strips, and both carousel frames are all still there.
  assert.match(pageCode, /id="place-results-heading"/);
  assert.match(pageCode, /\{curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\}`/);
  assert.match(pageCode, /Ke hasil <span aria-hidden>›<\/span>/);
  assert.match(pageCode, />\s*Tempat Pilihan\s*\n\s*<\/p>/);
  assert.match(pageCode, />\s*Discovery Place\s*\n\s*<\/p>/);
  assert.equal((pageCode.match(/-mx-4 overflow-hidden border-y border-black\/10 bg-white\/70 py-2"/g) ?? []).length, 2);
  assert.equal(
    (pageCode.match(/-mx-4 flex snap-x snap-mandatory gap-2\.5 overflow-x-auto px-4 pb-1\.5/g) ?? []).length,
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
  assert.match(pageCode, /import \{\s*\n\s*AREA_COVERAGE_CAPTION,/);
  assert.match(pageCode, /const coverageCaption = cameraCoverage === "radius" \? radiusCaption : AREA_COVERAGE_CAPTION;/);
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