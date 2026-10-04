import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMERA_FIT_PADDING,
  FIT_SINGLE_PLACE_ZOOM,
  boundsOfPoints,
  collectGeoPoints,
  narrowToViewport,
  resolveCameraFitPadding,
  type MapViewport,
} from "../lib/live/ui";

/**
 * AUTO-FIT VIEWPORT (product decision, 2026-10-03)
 *
 * Root cause this suite locks shut: the Home camera only ever framed ONE
 * point — the geocoder's city center, or a fixed 10 km radius around the
 * Current Location. A "Tempat Pilihan" Place on the edge of the region was
 * therefore never on screen, and because the viewport is the ONE coverage
 * source for the markers and both Place rows (product decision 2026-10-01),
 * that Place was MISSING from the list until the user zoomed out by hand.
 *
 * The camera now frames the SPREAD of the relevant Places' canonical
 * coordinates. This suite proves the ten acceptance rules of that change:
 *   1. the curated camera follows the Place spread, with no 10 km cap;
 *   2. a "Riyadh" search covers the spread-out Places of the region, not just
 *      the geocoding center;
 *   3. the bounds dataset is NOT limited by the current viewport;
 *   4. no recenter loop when the viewport or the markers update;
 *   5. manual pan/zoom is respected until an explicit refocus trigger;
 *   6. zero / one / many Places are all handled correctly;
 *   7. the +/- buttons sit below "Lokasi Saya" and still work;
 *   8. the search info panel spans the screen on a solid background;
 *   9. the Place carousel has a visible frame and stays horizontally
 *      scrollable;
 *  10. the pre-existing camera / marker / stacking / search / Discovery
 *      regression suites stay green (they are run alongside this one).
 *
 * It also records what this decision does NOT touch: curated membership still
 * comes only from the canonical `places.is_curated` ids, the distance tabs
 * keep their ordered radius presets, "Lokasi Saya" still preserves the
 * current zoom, and nothing ever invents a coordinate.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const mapCode = stripComments(homeMap);
const pageCode = stripComments(homeDiscovery);

type Place = { id: string; latitude: number | null; longitude: number | null };

function place(id: string, latitude: number | null, longitude: number | null): Place {
  return { id, latitude, longitude };
}

function fitPoints(places: Place[]) {
  return collectGeoPoints(places);
}

function fittedBounds(places: Place[]): MapViewport | null {
  return boundsOfPoints(fitPoints(places));
}

// ---------------------------------------------------------------------------
// 1. Tempat Pilihan: the camera follows the Place spread, with no 10 km cap.
// ---------------------------------------------------------------------------

test("AC 1: curated coverage is derived from the Place spread, and the camera has no fixed-radius cap", () => {
  // Two curated Places ~25 km apart: a 10 km frame around any single point
  // CANNOT contain both, which is exactly the reported defect.
  const spread = [place("north", 24.8, 46.6), place("south", 24.6, 46.6)];
  const bounds = fittedBounds(spread);
  assert.ok(bounds);
  assert.ok(bounds.north - bounds.south > 0.15, "the spread is far larger than 10 km");

  // The component feeds the camera the SELECTED candidates WITHOUT the
  // viewport gate. The curated focus is the SELECTED distribution plus nearby
  // CAMERA CONTEXT (bug fix 2026-10-03): `selectedLocalArea` resolves the
  // selected set, and the curated pool then adds the ordinary Places of that
  // SAME local area as frame context only — they never enter a result row.
  assert.match(
    pageCode,
    /const selectedLocalArea = useMemo\(\s*\(\) =>\s*resolveLocalAreaCoverage\(\{/,
  );
  assert.match(pageCode, /const selectedFitPlaces = useMemo\(\(\) => toHomeMapPlaces\(selectedLocalArea\.places\)/);
  // ...bounded to the viewer's LOCAL AREA so one fit can never frame two
  // continents (see tests/map-local-area-coverage.test.ts).
  assert.match(pageCode, /origin: searchCenter \?\? viewerPosition,/);
  // ...and the camera's fit is a fitBounds, not a radius frame.
  assert.match(mapCode, /const fitChanged = fitNonce > 0 && fitNonce !== lastFitNonceRef\.current;/);
  assert.match(mapCode, /const applied = await fitCamera\(map, fitPlacesRef\.current, CURATED_FIT_MAX_ZOOM\)/);
  // The curated frame carries a COMFORTABLE DENSITY zoom ceiling (product
  // decision, 2026-10-04) that can only ever widen the frame.
  assert.match(mapCode, /const CURATED_FIT_MAX_ZOOM = 13;/);
  assert.match(mapCode, /map\.fitBounds\(L\.latLngBounds\(corners\)/);

  // The fit branch does NOT consult the curated radius value: choosing the tab
  // must not re-frame the camera to a fixed 10 km.
  const fitBranch = mapCode.slice(
    mapCode.indexOf("if (fitChanged) {"),
    mapCode.indexOf("const anchor = cameraCenter ?? viewerPosition;"),
  );
  assert.doesNotMatch(fitBranch, /radiusZoom|cameraRadiusMeters\)|LAT_M|latDelta/);
  // The radius still reaches the camera prop (it is the display radius and the
  // distance-tab preset) — but the curated FRAME is the Place spread.
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
});

test("AC 1: curated MEMBERSHIP is untouched — the fit is geometry, never a membership input", () => {
  // Canonical is_curated is still the ONLY source of curated membership.
  assert.match(
    pageCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
  // The fit dataset is derived from that membership (product decision,
  // 2026-10-04; contextual framing 2026-10-05): the CANDIDATES are every
  // curated Place, straight from the canonical curated ids — it never
  // re-selects, never sorts, and never re-orders a row. Coordinate
  // fail-closed lives in the shared `toCameraCandidates` projection used by
  // every camera dataset, and again inside the resolver itself.
  const fitDataset = pageCode.slice(
    pageCode.indexOf("const curatedFitPlaces"),
    pageCode.indexOf("const cameraFitPlaces"),
  );
  assert.match(fitDataset, /curatedIdSet\.has\(place\.id\)/);
  assert.match(fitDataset, /toCameraCandidates\(/);
  assert.match(pageCode, /function toCameraCandidates\(source: readonly Place\[\]\)/);
  assert.match(pageCode, /if \(place\.latitude === null \|\| place\.longitude === null\) return null;/);
  // The fit dataset itself still neither sorts, re-selects, nor measures
  // anything — membership and geometry stay independent.
  assert.doesNotMatch(fitDataset, /\.sort\(|curatedIdSet\.size|distanceMeters/);
  // No list row reads the fit dataset.
  assert.equal(/\bfitNonce\b|\bcameraFitPlaces\b|\bsearchFitPlaces\b/.test(pageCode.slice(pageCode.indexOf("const listedPlaces"), pageCode.indexOf("return ("))), false);
});

// ---------------------------------------------------------------------------
// 2. A "Riyadh" search covers the region's spread-out Places.
// ---------------------------------------------------------------------------

test("AC 2: a searched region frames its own Place spread, not only the geocoding center", () => {
  const RIYADH = { lat: 24.7136, lng: 46.6753 };
  const region = {
        north: RIYADH.lat + 0.05,
        south: RIYADH.lat - 0.05,
        east: RIYADH.lng + 0.05,
        west: RIYADH.lng - 0.05,
      };
  // Places spread across the region — one of them far from the city point.
  const inside = [
    place("near-center", 24.7136, 46.6753),
    place("west-edge", 24.72, 46.66),
    place("east-edge", 24.69, 46.71),
  ];
  const elsewhere = place("dammam", 26.4207, 50.0888);

  // The relevant set is the region's own Places, NOT the device fix.
  const relevant = narrowToViewport([...inside, elsewhere], region);
  assert.deepEqual(relevant.map((item) => item.id), ["near-center", "west-edge", "east-edge"]);

  const bounds = fittedBounds(relevant);
  assert.ok(bounds);
  // The frame must contain every relevant Place, and it is clearly wider than
  // a single point around the geocoder.
  for (const item of relevant) {
    assert.ok(item.latitude! <= bounds.north && item.latitude! >= bounds.south);
    assert.ok(item.longitude! <= bounds.east && item.longitude! >= bounds.west);
  }
  assert.ok(bounds.east - bounds.west > 0.04);

  // The component builds exactly that dataset for the search camera.
  assert.match(pageCode, /const searchFitPlaces = useMemo<HomeMapPlace\[\]>\(\(\) => \{\s*if \(curatedOnly\) return curatedFitPlaces;\s*if \(!searchViewport\) return \[\];\s*return narrowToViewport\(visiblePlaces, searchViewport\)/);
  // The search camera prefers the fit and only falls back to the geocoding
  // center when the region holds NO Place with canonical coordinates.
  assert.match(mapCode, /const applied = await fitCamera\(map, searchFitPlacesRef\.current\);/);
  assert.match(mapCode, /if \(cancelled \|\| applied\) return;/);
});

test("AC 2: the Place-keyword search is submit-only — one search, never a second path", () => {
  // 2026-10-04: the debounce is gone. Typing only updates the box; the ONE
  // geocode runs on Enter/submit, guarded by the same epoch check.
  assert.doesNotMatch(pageCode, /setTimeout\(\(\) => \{\s*runSearch\(searchQuery\);/);
  assert.doesNotMatch(pageCode, /\}, 250\);/);
  assert.match(pageCode, /onKeyDown=\{handleSearchKeyDown\}/);
  assert.match(pageCode, /fetch\(`\/api\/geocode\?q=\$\{encodeURIComponent\(trimmed\)\}`/);
  assert.match(pageCode, /const isCurrent = \(\) =>\s*acceptSearchResponse\(\{/);
  assert.equal((pageCode.match(/submittedSearchRef\.current !== trimmed/g) ?? []).length >= 3, true);
  // The auto-fit reads searchCenter/searchViewport; it never runs its own query.
  assert.equal(/fetch\(/.test(pageCode.slice(pageCode.indexOf("const searchFitPlaces"), pageCode.indexOf("const searchFitPlaces") + 600)), false);
});

// ---------------------------------------------------------------------------
// 3. The bounds dataset is NOT limited by the current viewport.
// ---------------------------------------------------------------------------

test("AC 3: the camera's bounds dataset never depends on the reported viewport", () => {
  // `mapViewport` is the ONLY value the markers and the rows are narrowed by...
  assert.match(pageCode, /const coverageViewport = mapViewport \?\? searchViewport;/);
  assert.match(pageCode, /const visibleMapPlaces = useMemo\(\s*\(\) => narrowToViewport\(mapPlaces, coverageViewport\)/);
  // ...and it appears NOWHERE in either bounds dataset, so the camera can never
  // be fitted to the markers it just moved (the circular dependency).
  const fitDatasets = pageCode.slice(
    pageCode.indexOf("const cameraFitPlaces"),
    pageCode.indexOf("const searchFitPlaces") + 700,
  );
  assert.doesNotMatch(fitDatasets, /mapViewport|coverageViewport|visibleMapPlaces/);
  // Nor does the map component narrow its own fit input.
  const fitMechanism = mapCode.slice(
    mapCode.indexOf("const fitCamera = useCallback"),
    mapCode.indexOf("// Camera anchor:"),
  );
  assert.doesNotMatch(fitMechanism, /narrowToViewport|visibleMapPlaces|map\.getBounds/);
  // The fit input is mirrored into a REF so a new array identity can never
  // re-run a fit that already happened.
  assert.match(mapCode, /const fitPlacesRef = useRef<HomeMapPlace\[\]>\(fitPlaces\);/);
  assert.match(mapCode, /const searchFitPlacesRef = useRef<HomeMapPlace\[\]>\(searchFitPlaces\);/);
});

// ---------------------------------------------------------------------------
// 4. No recenter loop on viewport / marker updates.
// ---------------------------------------------------------------------------

test("AC 4: only a NONCE can re-frame the camera — no viewport or marker input can", () => {
  const fitEffect = mapCode.slice(
    mapCode.indexOf("const fitChanged = fitNonce > 0"),
    mapCode.indexOf("}, [ready, viewerPositionKey, cameraCenterKey, cameraRadiusMeters"),
  );
  // The gate is a strict inequality against the LAST APPLIED nonce, and it is
  // recorded even when the dataset is empty.
  assert.match(fitEffect, /lastFitNonceRef\.current = fitNonce;/);
  // The fit runs ONCE per trigger and then returns — no fall-through into the
  // radius path that would re-frame the map a second time.
  assert.match(fitEffect, /return;\s*\}\s*const anchor = cameraCenter \?\? viewerPosition;/);
  // The deps of the camera effects carry the NONCES, never the Place arrays:
  // a discovery re-poll or a marker rebuild cannot re-trigger them.
  assert.match(mapCode, /}, \[ready, searchNonce, searchCenter, fitCamera\]\);/);
  assert.match(mapCode, /}, \[locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera\]\);/);
  assert.match(mapCode, /cameraCenter, fitNonce, cameraRequestNonce, focusUser, radiusZoom, fitCamera, pulsePinOnPresetChange/);
  // The locate dataset is mirrored into its own ref the same way, and that
  // mirror is declared BEFORE the locate effect, so a press always reads the
  // CURRENT local-area set (never one from a previous fix or a previous city).
  assert.match(mapCode, /const locateFitPlacesRef = useRef<HomeMapPlace\[\]>\(locateFitPlaces\);/);
  // The marker rebuild effect still never touches the camera.
  const markerEffect = mapCode.slice(
    mapCode.indexOf("const markerPositions: [number, number][] = [];"),
    mapCode.indexOf("}, [ready, markerKey, places, liveByPlaceId, router]);"),
  );
  assert.doesNotMatch(markerEffect, /fitCamera|fitBounds|setView|flyTo/);
  // ONE shared smooth-transition helper (product decision, 2026-10-04): the
  // camera eases between view distances through the SAME curve everywhere, and
  // there is still no flyTo. Exactly one declared duration lives in the helper.
  assert.equal((mapCode.match(/map\.flyTo\(/g) ?? []).length, 0);
  assert.equal((mapCode.match(/duration:/g) ?? []).length, 1);
  assert.match(mapCode, /function cameraAnimationOptions\(\)/);
});

// ---------------------------------------------------------------------------
// 5. Manual pan/zoom is respected until an explicit refocus.
// ---------------------------------------------------------------------------

test("AC 5: a real pan/zoom latches the camera; only a tab choice or a new search re-arms it", () => {
  // A finished user move latches...
  assert.match(mapCode, /userInteractedRef\.current = true/);
  // ...a programmatic move is excluded from that latch, so the fit's OWN
  // moveend events can never look like a user gesture.
  assert.match(mapCode, /programmaticMoveRef\.current = true/);
  // RE-ARMED ONLY BY AN EXPLICIT REQUEST (correction, 2026-10-03): the frame a
  // fit or a search produced is LATCHED right after, so the next geolocation
  // fix can no longer re-frame the map to a radius preset the user never
  // chose. The ONLY thing that releases that latch is a NEW explicit request.
  const fitBranch = mapCode.slice(
    mapCode.indexOf("if (fitChanged) {"),
    mapCode.indexOf("const anchor = cameraCenter ?? viewerPosition;"),
  );
  assert.match(fitBranch, /userInteractedRef\.current = true;/);
  assert.match(
    mapCode,
    /userInteractedRef\.current = true;\s*\(async \(\) => \{\s*const applied = await fitCamera\(map, searchFitPlacesRef\.current\)/,
  );
  assert.match(mapCode, /const requestChanged = cameraRequestNonce !== lastRequestNonceRef\.current;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // The curated tab is the ONLY state change that bumps the FIT nonce.
  assert.equal((pageCode.match(/setFitNonce\(\(nonce\) => nonce \+ 1\)/g) ?? []).length, 1);
  const curatedHandler = pageCode.slice(
    pageCode.indexOf("const next = activateCuratedFilter();"),
    pageCode.indexOf("const next = activateCuratedFilter();") + 400,
  );
  assert.match(curatedHandler, /setFitNonce/);
  // Choosing a distance tab (the other explicit camera action) keeps its own
  // preset and carries no fit nonce.
  const tabHandler = pageCode.slice(
    pageCode.indexOf("setDistanceFilter(filter);"),
    pageCode.indexOf("setDistanceFilter(filter);") + 160,
  );
  assert.doesNotMatch(tabHandler, /setFitNonce/);
  // It DOES carry an explicit camera request, which is what releases the latch
  // the previous frame left behind.
  assert.match(tabHandler, /setCameraRequestNonce/);
});

// ---------------------------------------------------------------------------
// 6. Zero / one / many Places.
// ---------------------------------------------------------------------------

test("AC 6: zero Places with valid coordinates NEVER invents a coordinate", () => {
  // The mechanism refuses to move at all and reports that it did not apply.
  const fitMechanism = mapCode.slice(
    mapCode.indexOf("const fitCamera = useCallback"),
    mapCode.indexOf("// Camera anchor:"),
  );
  assert.match(fitMechanism, /const points = collectGeoPoints\(candidatePlaces\);\s*const bounds = boundsOfPoints\(points\);/);
  assert.match(fitMechanism, /if \(!bounds\) return false;/);
  assert.match(fitMechanism, /if \(mapRef\.current !== map\) return false;/);
  // Pure contract: an empty set and a coordinate-less set both yield no bounds.
  assert.equal(boundsOfPoints([]), null);
  assert.equal(boundsOfPoints(fitPoints([place("no-coords", null, null)])), null);
  assert.equal(boundsOfPoints(fitPoints([place("nan", Number.NaN, 1), place("inf", 1, Number.POSITIVE_INFINITY)])), null);
  // The search then KEEPS its geocoding center; the curated tab keeps the
  // current view. Neither branch invents a point.
  assert.match(mapCode, /if \(cancelled \|\| applied\) return;\s*programmaticMoveRef\.current = true;\s*map\.setView\(\[searchCenter\.lat, searchCenter\.lng\]/);
  const fitBranch = mapCode.slice(
    mapCode.indexOf("if (fitChanged) {"),
    mapCode.indexOf("const anchor = cameraCenter ?? viewerPosition;"),
  );
  assert.doesNotMatch(fitBranch, /setView|flyTo|fitBounds\(/);
});

test("AC 6: ONE Place is focused on its canonical coordinate, never zoomed to the maximum", () => {
  const single = [place("only", 24.7136, 46.6753)];
  // A single point has a degenerate box: fitting it would jump to maxZoom.
  const bounds = fittedBounds(single);
  assert.deepEqual(bounds, { north: 24.7136, south: 24.7136, east: 46.6753, west: 46.6753 });
  const fitMechanism = mapCode.slice(
    mapCode.indexOf("const fitCamera = useCallback"),
    mapCode.indexOf("// Camera anchor:"),
  );
  assert.match(fitMechanism, /if \(points\.length === 1\) \{\s*const singleZoom =\s*typeof maxZoom === "number" \? Math\.min\(FIT_SINGLE_PLACE_ZOOM, maxZoom\) : FIT_SINGLE_PLACE_ZOOM;\s*map\.setView\(\[points\[0\]\.lat, points\[0\]\.lng\], singleZoom, \{ \.\.\.cameraAnimationOptions\(\) \}\);/);
  // A close, deliberate focus level — the same floor "Lokasi Saya" uses, and
  // never Leaflet's maximum zoom.
  assert.ok(FIT_SINGLE_PLACE_ZOOM >= 14 && FIT_SINGLE_PLACE_ZOOM <= 17);
  assert.doesNotMatch(fitMechanism, /getMaxZoom/);
  // The search falls through to the fit (applied === true) for one Place too,
  // so a single result is framed rather than recentered a second time.
  assert.match(mapCode, /const applied = await fitCamera\(map, searchFitPlacesRef\.current\);/);
});

test("AC 6: MANY Places are framed with padding that reserves the chrome and the controls", () => {
  const many = [
    place("a", 24.6, 46.6),
    place("b", 24.9, 46.8),
    place("c", 24.75, 46.7),
  ];
  const bounds = fittedBounds(many);
  assert.deepEqual(bounds, { north: 24.9, south: 24.6, east: 46.8, west: 46.6 });
  // Zooming out "secukupnya" is exactly this: the whole box, never a cap.
  assert.ok(Math.abs(bounds.north - bounds.south - 0.3) < 1e-9);

  // Padding reserves the floating header/search/filter chrome (top), the
  // right-hand control column, and the coverage box + scale at the bottom.
  assert.ok(CAMERA_FIT_PADDING.top > 150, "the header + search bar + filter row are reserved");
  assert.ok(CAMERA_FIT_PADDING.right > 40, "the right-hand controls are reserved");
  assert.ok(CAMERA_FIT_PADDING.bottom > 40, "the coverage box + scale are reserved");

  // An unmeasured container reserves nothing (Leaflet then fits the full box).
  assert.deepEqual(resolveCameraFitPadding({ x: 0, y: 0 }), {
    paddingTopLeft: [0, 0],
    paddingBottomRight: [0, 0],
  });
  // A desktop map gets the full reserved chrome.
  const desktop = resolveCameraFitPadding({ x: 1280, y: 496 });
  assert.deepEqual(desktop, {
    paddingTopLeft: [CAMERA_FIT_PADDING.left, CAMERA_FIT_PADDING.top],
    paddingBottomRight: [CAMERA_FIT_PADDING.right, CAMERA_FIT_PADDING.bottom],
  });
  // A short mobile map can never reserve more than it has pixels.
  for (const height of [260, 280, 320, 354]) {
    const mobile = resolveCameraFitPadding({ x: 360, y: height });
    const [left, top] = mobile.paddingTopLeft;
    const [right, bottom] = mobile.paddingBottomRight;
    assert.ok(top <= height, `top ${top} must fit in ${height}`);
    assert.ok(bottom <= height, `bottom ${bottom} must fit in ${height}`);
    assert.ok(top + bottom <= height * 0.7, "the reserved chrome never eats the map");
    assert.ok(left + right < 360, "the horizontal reserve stays a share of the width");
  }
  // The mechanism hands exactly that padding to Leaflet.
  assert.match(mapCode, /const padding = resolveCameraFitPadding\(map\.getSize\(\)\);/);
  assert.match(mapCode, /paddingTopLeft: padding\.paddingTopLeft,\s*paddingBottomRight: padding\.paddingBottomRight,/);
});

// ---------------------------------------------------------------------------
// 7. Zoom controls sit BELOW "Lokasi Saya" and still work.
// ---------------------------------------------------------------------------

test("AC 7: the +/- stack is below both locate buttons, and the zoom control is untouched", () => {
  const recenter = Number(/absolute right-3 top-\[(\d+)px\] z-\[1100\] inline-flex h-11 w-11/.exec(homeMap)?.[1] ?? "0");
  const labeled = Number(/absolute right-3 top-\[(\d+)px\] z-\[1100\] inline-flex w-11 flex-col/.exec(homeMap)?.[1] ?? "0");
  const zoomStack = Number(/\.singgah-home-map \.leaflet-top\.leaflet-right \{\s*top: (\d+)px;/.exec(globals)?.[1] ?? "0");
  // LOWER on the screen means a LARGER offset: the zoom stack is last.
  assert.ok(recenter > 150, "the Re-center arrow clears the floating chrome");
  assert.ok(labeled > recenter, `"Lokasi Saya" (${labeled}px) sits below Re-center (${recenter}px)`);
  assert.ok(zoomStack > labeled, `the +/- stack (${zoomStack}px) sits below "Lokasi Saya" (${labeled}px)`);
  // No collision: the labeled control is ~41px tall, so the stack starts after
  // it, and the whole ladder still ends above the bottom overlays on the
  // shortest supported map (a 42vh map on a 640px screen ≈ 413px tall).
  assert.ok(zoomStack >= labeled + 41, "the stack starts below the labeled control, never on it");
  assert.ok(zoomStack + 60 <= 360, "the stack clears the coverage box / scale on the shortest map");
  // FUNCTIONALITY IS UNCHANGED: still Leaflet's own control, same position,
  // same two buttons, same titles and handlers.
  assert.match(
    mapCode,
    /L\.control\.zoom\(\{ position: "topright", zoomInTitle: "Perbesar peta", zoomOutTitle: "Perkecil peta" \}\)/,
  );
  assert.match(mapCode, /scrollWheelZoom: true/);
  assert.equal(mapCode.includes("dragging: false"), false);
  assert.equal(mapCode.includes("touchZoom: false"), false);
  // The offset stays SCOPED to the Home map, so the Producer location picker
  // map keeps its default zoom control.
  assert.match(globals, /\.singgah-home-map \.leaflet-top\.leaflet-right \{/);
});

// ---------------------------------------------------------------------------
// 8. The search info panel is full width with a solid background.
// ---------------------------------------------------------------------------

test("AC 8: the search info panel spans the screen and is fully opaque", () => {
  const panel = pageCode.slice(
    pageCode.indexOf("{(searchPending || searchError) && ("),
    pageCode.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
  );
  // It escapes BOTH the horizontal padding and the max-width cap of the
  // content column, and is re-centred on the VIEWPORT.
  assert.match(panel, /-mx-4 relative left-\[calc\(50%_-_50vw\)\] w-\[100vw\]/);
  assert.match(panel, /w-full items-center gap-2/);
  // Opaque background in every state — the map can never show through.
  assert.doesNotMatch(panel, /bg-white\/\d+/);
  assert.match(panel, /bg-white text-black\/55/);
  assert.match(panel, /bg-\[#fcebe7\] text-live/);
  // The existing content, data, and semantics are preserved verbatim.
  assert.match(panel, /role="status"/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(panel, /Mencari lokasi…/);
  assert.match(panel, /\{searchError\}/);
  // 2026-10-04: the resolved-center branch is GONE. The Home UI no longer
  // prints raw coordinates, and the banner only exists while a search is
  // running or failed — so a resolved search leaves no strip and no gap. The
  // `bg-white text-brand-ink` background that only that branch used is
  // therefore gone with it; loading and error keep their own opaque surfaces.
  assert.doesNotMatch(panel, /Area pencarian/);
  assert.doesNotMatch(panel, /searchCenter\.(lat|lng)\.toFixed/);
  assert.doesNotMatch(panel, /bg-white text-brand-ink/);
});

// ---------------------------------------------------------------------------
// 9. The Place rows are vertical lists inside the results panel.
// ---------------------------------------------------------------------------

test("AC 9: both Place rows are vertical lists inside the panel", () => {
  // 2026-10-04: the horizontal carousels became vertical lists. The same
  // dataset, order, and cards remain; only the layout changed.
  const frames = (pageCode.match(/-mx-4 overflow-hidden border-y border-black\/10 bg-white\/70 py-1\.5"/g) ?? []);
  assert.equal(frames.length, 0, "the old carousel frames are gone");
  const strips = (pageCode.match(/-mx-4 flex flex-col gap-2\.5 px-4 pb-1"/g) ?? []);
  assert.equal(strips.length, 2, "Baris 1 and Baris 2 are both vertical lists");
  const tracks = (pageCode.match(/w-\[46vw\] max-w-\[200px\] min-w-\[132px\] shrink-0 snap-start/g) ?? []);
  assert.equal(tracks.length, 0, "no fixed-width horizontal tracks remain");
  // Cards stay wrapped in a full-width list item in BOTH rows.
  assert.equal((pageCode.match(/className="w-full"/g) ?? []).length, 2);
  const curated = pageCode.slice(pageCode.indexOf("{curatedOnly && curatedListed.length > 0 && ("));
  assert.match(curated, /\{curatedListed\.map\(\(place\) => \(/);
  // No page-level horizontal overflow is introduced: the list only cancels
  // the section's own padding, it never exceeds it.
  assert.equal(/-mx-4 overflow-hidden border-y[^\n]*w-\[100vw\]/.test(pageCode), false);
});

// ---------------------------------------------------------------------------
// 10. Boundaries this change must not cross.
// ---------------------------------------------------------------------------

test("AC 10: no product boundary was crossed by the auto-fit change", () => {
  // No new feature, no new page, no route, no payment/checkout vocabulary.
  for (const forbidden of [/checkout/i, /payment/i, /wallet|escrow|settlement/i, /keranjang|cart/i]) {
    assert.doesNotMatch(pageCode, forbidden);
    assert.doesNotMatch(mapCode, forbidden);
  }
  // No backend / database / RLS / Place-status surface was touched.
  assert.equal(/supabase|from\("places"\)|is_curated|publication_status|admin/i.test(mapCode), false);
  // The distance tabs keep their ordered radius presets.
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
  // "Lokasi Saya" frames the viewer's LOCAL AREA around the newest real fix
  // (correction, 2026-10-03) — never a radius, never a global fit, and never
  // a bare `setView` at the previous zoom.
  const locate = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera]);"),
  );
  assert.match(locate, /const applied = await fitCamera\(map, candidates, LOCATE_FIT_MAX_ZOOM\);/);
  assert.match(locate, /locateFitPlacesRef\.current/);
  assert.match(locate, /id: VIEWER_FIT_POINT_ID,/);
  assert.doesNotMatch(locate, /radiusZoom/);
  assert.doesNotMatch(locate, /CAMERA_PRESET_RADIUS_M|CURATED_CAMERA_RADIUS_M|10_000/);
  // The curated display radius is still a truthful DISPLAY value for the
  // distance tabs, and the coverage caption names the real origin whenever a
  // radius preset really owns the frame.
  assert.match(pageCode, /const activeRadiusMeters = curatedOnly\n\s*\? CURATED_CAMERA_RADIUS_M\n\s*: CAMERA_PRESET_RADIUS_M\[distanceFilter\];/);
  assert.match(pageCode, /const coverageScope = describeCoverageScope\(\{/);
});