import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMERA_PRESET_RADIUS_M,
  DISTANCE_FILTERS,
  narrowToViewport,
  resolveExploreFitPlaces,
  type LocalAreaPlace,
  type MapViewport,
} from "../lib/live/ui";

/**
 * TEMPAT PILIHAN MUST NOT MOVE THE CAMERA (2026-10-05).
 *
 * ROOT CAUSE: selecting the curated tab was ALSO a camera action. The press
 * bumped a fit nonce (a `fitBounds` over the curated Places), bumped the
 * camera-request nonce (which RELEASED the manual-interaction latch), and
 * switched the camera to a curated radius. So a presentation choice silently
 * threw away the frame the user was looking at — a Riyadh search framed the
 * city, then the curated press re-fit it to the curated subset.
 *
 * THE RULE NOW: "Tempat Pilihan" changes which Places are specially marked. It
 * never moves, re-frames, or narrows the camera, in either the search or the
 * Current Location context.
 *
 * The second half of the file covers the too-tight Current Location frame,
 * which is corrected by widening the explore set to the ACTIVE distance preset
 * — never a new radius.
 */

const discovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const pageCode = stripComments(discovery);
const mapCode = stripComments(map);

const curatedHandler = pageCode.slice(
  pageCode.indexOf("const next = activateCuratedFilter();"),
  pageCode.indexOf("const next = activateCuratedFilter();") + 500,
);
const distanceHandler = pageCode.slice(
  pageCode.indexOf("setDistanceFilter(filter);"),
  pageCode.indexOf("setDistanceFilter(filter);") + 400,
);
const locatePress = pageCode.slice(
  pageCode.indexOf("const handleLocatePress"),
  pageCode.indexOf("const liveByPlaceId"),
);

// ---------------------------------------------------------------------------
// 1. Search coverage is independent of the active distance tab.
// ---------------------------------------------------------------------------

test("1: search coverage reads the canonical bounds, never the distance preset", () => {
  const searchViewportMemo = pageCode.slice(
    pageCode.indexOf("const searchViewport"),
    pageCode.indexOf("const liveCards"),
  );
  assert.match(
    searchViewportMemo,
    /\(searchArea \? searchArea : searchCenter \? fallbackSearchArea\(searchCenter\) : null\)/,
  );
  assert.doesNotMatch(searchViewportMemo, /CAMERA_PRESET_RADIUS_M|distanceFilter/);
  // A resolved answer claims the AREA caption, not the preset's radius.
  assert.match(
    pageCode,
    /setSearchCenter\(\{ lat: latitude, lng: longitude \}\);[\s\S]{0,900}?setCameraCoverage\("area"\);/,
  );
});

// ---------------------------------------------------------------------------
// 2 + 3 + 5. Tempat Pilihan never touches the camera, in ANY context.
// ---------------------------------------------------------------------------

test("2 & 3 & 5: selecting Tempat Pilihan moves no camera state at all", () => {
  // It still toggles the layer and keeps the LIVE exclusivity rule.
  assert.match(curatedHandler, /setCuratedOnly\(next\.curatedOnly\);/);
  assert.match(curatedHandler, /setLiveOnly\(next\.liveOnly\);/);
  // ...and reaches NOTHING the camera owns.
  assert.doesNotMatch(curatedHandler, /setCameraRequestNonce/);
  assert.doesNotMatch(curatedHandler, /fitNonce/);
  assert.doesNotMatch(curatedHandler, /setCameraCoverage/);
  assert.doesNotMatch(curatedHandler, /setSearchNonce|setSearchCenter/);
});

test("2 & 3: the curated tab cannot re-frame through any surviving mechanism", () => {
  // The curated auto-fit mechanism is removed outright, so there is nothing
  // left for a tab press to trigger.
  assert.doesNotMatch(pageCode, /const curatedFitPlaces/);
  assert.doesNotMatch(pageCode, /fitNonce/);
  assert.doesNotMatch(mapCode, /fitNonce|fitPlacesRef|CURATED_FIT_MAX_ZOOM|cameraFitPlaces/);
  // The camera radius is the ACTIVE DISTANCE PRESET in every mode, so entering
  // or leaving the curated tab cannot silently switch distance modes.
  assert.match(pageCode, /cameraRadiusMeters=\{CAMERA_PRESET_RADIUS_M\[distanceFilter\]\}/);
  assert.match(pageCode, /const activeRadiusMeters = CAMERA_PRESET_RADIUS_M\[distanceFilter\];/);
  assert.doesNotMatch(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M/);
  // Both camera datasets are mode-independent, so neither can narrow coverage
  // because the curated tab happens to be selected.
  assert.match(
    pageCode,
    /const locateFitPlaces = useMemo<HomeMapPlace\[\]>\(\s*\(\) =>\s*toHomeMapPlaces\(/,
  );
  assert.match(
    pageCode,
    /const searchFitPlaces = useMemo<HomeMapPlace\[\]>\(\(\) => \{\s*if \(!searchViewport\) return \[\];/,
  );
  assert.doesNotMatch(pageCode, /contextFramedTab|contextFitPlaces/);
});

// ---------------------------------------------------------------------------
// 4. Current Location framing is not restricted to a single Place.
// ---------------------------------------------------------------------------

const RIYADH = { lat: 24.7136, lng: 46.6753 };
const place = (
  id: string,
  lat: number,
  lng: number,
  extra: Partial<LocalAreaPlace> = {},
): LocalAreaPlace => ({ id, latitude: lat, longitude: lng, ...extra });

test("4: a single-Place local area is widened to the ACTIVE distance preset", () => {
  // The viewer's own trusted geography resolves to ONE Place…
  const only = [place("nearest", 24.7137, 46.6754, { countryCode: "SA", regionName: "Ar Riyad" })];
  // …but other relevant Places sit inside the user's own 1 km exploration scope.
  const candidates = [
    ...only,
    place("a", 24.7190, 46.6753, { countryCode: "SA", regionName: "Ar Riyad" }),
    place("b", 24.7210, 46.6753, { countryCode: "SA", regionName: "Ar Riyad" }),
  ];

  const widened = resolveExploreFitPlaces({
    origin: RIYADH,
    localPlaces: only,
    candidatePlaces: candidates,
    radiusMeters: CAMERA_PRESET_RADIUS_M["1 km"],
  });
  const ids = widened.map((row) => row.id).sort();
  // More than one Place is framable, so the frame can no longer be a
  // street-level view of the single nearest pin.
  assert.ok(ids.length > 1, "the explore set must not collapse to one Place");
  assert.ok(ids.includes("nearest"), "the local-area Place is always kept");
  assert.ok(ids.includes("a") && ids.includes("b"), "nearby Places inside the preset are admitted");

  // The widened set is bounded by the passed radius and never beyond it.
  const far = resolveExploreFitPlaces({
    origin: RIYADH,
    localPlaces: only,
    candidatePlaces: [...only, place("far", 40.0, 46.6753)],
    radiusMeters: CAMERA_PRESET_RADIUS_M["1 km"],
  });
  assert.ok(!far.some((row) => row.id === "far"), "a distant Place is never admitted");
});

test("4: a healthy multi-Place local area is never narrowed", () => {
  const local = [place("a", 24.72, 46.675), place("b", 24.73, 46.68)];
  const result = resolveExploreFitPlaces({
    origin: RIYADH,
    localPlaces: local,
    candidatePlaces: [...local, place("far", 40.0, 46.6)],
    radiusMeters: CAMERA_PRESET_RADIUS_M["1 km"],
  });
  assert.deepEqual(result.map((row) => row.id), ["a", "b"], "two Places already: no widening at all");
});

test("4: the explore helper is fail-closed and introduces no radius of its own", () => {
  assert.deepEqual(
    resolveExploreFitPlaces({ origin: null, localPlaces: [], candidatePlaces: [], radiusMeters: 1000 }),
    [],
    "no origin -> no invented frame",
  );
  const local = [place("a", 24.72, 46.675), place("b", 24.73, 46.68)];
  assert.deepEqual(
    resolveExploreFitPlaces({
      origin: RIYADH,
      localPlaces: local,
      // A Place without canonical coordinates can never enter the frame.
      candidatePlaces: [...local, place("nocoords", Number.NaN, Number.NaN)],
      radiusMeters: 1000,
    }).map((row) => row.id),
    ["a", "b"],
  );
});

test("4: the locate frame reuses the active preset, never a new radius", () => {
  assert.match(pageCode, /resolveExploreFitPlaces\(\{/);
  assert.match(pageCode, /radiusMeters: CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
  // The user marker is NOT a Place and never narrows the dataset.
  assert.match(mapCode, /VIEWER_FIT_POINT_ID/);
  assert.doesNotMatch(pageCode, /resolveExploreFitPlaces\(\{[\s\S]{0,400}?searchCenter/);
});

// ---------------------------------------------------------------------------
// 6. Manual pan / zoom is never overridden by a tab or a Place state update.
// ---------------------------------------------------------------------------

test("6: a real pan/zoom latches the camera and only an explicit request re-arms it", () => {
  assert.match(mapCode, /if \(!programmaticMoveRef\.current\) userInteractedRef\.current = true;/);
  assert.match(mapCode, /if \(userInteractedRef\.current\) return;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // No marker refresh, poll or viewport report carries a request.
  assert.match(mapCode, /if \(!programmaticMoveRef\.current\) userInteractedRef\.current = true;/);
  // Zoom controls and the map surface are untouched: wheel zoom stays on and
  // the touch-primary gesture rules are unchanged by this correction.
  assert.match(mapCode, /L\.control\.zoom\(\{/);
  assert.match(mapCode, /scrollWheelZoom: true,/);
  assert.match(mapCode, /dragging: !touchPrimary,/);
});

// ---------------------------------------------------------------------------
// 7 + 8. Clearing, a new search and "Lokasi Saya" keep their own behaviour.
// ---------------------------------------------------------------------------

test("7 & 8: clearing, a new search and Lokasi Saya each keep their own trigger", () => {
  // Clearing never releases the viewport latch, so browsing resumes on the
  // real Leaflet bounds without a flash of un-narrowed results.
  assert.match(pageCode, /const resetViewportLatch = useCallback\(\(\) => \{/);
  assert.doesNotMatch(pageCode.slice(pageCode.indexOf("const handleSearchClear"), pageCode.indexOf("const handleSearchClear") + 900), /resetViewportLatch\(\)/);
  // A NEW answer establishes the searched frame exactly once.
  assert.match(mapCode, /const applied = await fitCamera\(map, searchFitPlacesRef\.current\);/);
  // An explicit Lokasi Saya establishes the local frame exactly once.
  assert.match(mapCode, /lastLocateNonceRef\.current = locateNonce;/);
  assert.match(mapCode, /const applied = await fitCamera\(map, candidates, LOCATE_FIT_MAX_ZOOM\);/);
  assert.match(locatePress, /setCameraCoverage\("area"\);/);
  // A stale answer cannot restore an old frame.
  assert.match(pageCode, /if \(submittedSearchRef\.current !== trimmed\) return;/);
  assert.match(pageCode, /acceptSearchResponse\(\{/);
});

// ---------------------------------------------------------------------------
// 9. Distance tabs keep their approved behaviour.
// ---------------------------------------------------------------------------

test("9: the three distance tabs keep their ordered, deterministic presets", () => {
  assert.deepEqual(DISTANCE_FILTERS, ["1 km", "5 km", "10 km+"]);
  assert.ok(CAMERA_PRESET_RADIUS_M["1 km"] < CAMERA_PRESET_RADIUS_M["5 km"]);
  assert.ok(CAMERA_PRESET_RADIUS_M["5 km"] < CAMERA_PRESET_RADIUS_M["10 km+"]);
  // A distance tab still sets its radius, leaves the curated layer, claims the
  // radius caption and releases the latch.
  assert.match(distanceHandler, /setDistanceFilter\(filter\);/);
  assert.match(distanceHandler, /setCuratedOnly\(false\);/);
  assert.match(distanceHandler, /setCameraCoverage\("radius"\);/);
  assert.match(distanceHandler, /setCameraRequestNonce\(\(nonce\) => nonce \+ 1\);/);
  // The curated tab no longer activates a radius of its own.
  assert.doesNotMatch(pageCode, /CURATED_CAMERA_RADIUS_M/);
});

// ---------------------------------------------------------------------------
// 10. Rows and markers stay consistent with the active viewport.
// ---------------------------------------------------------------------------

test("10: rows and markers read ONE coverage source", () => {
  assert.match(pageCode, /const coverageViewport = mapViewport \?\? searchViewport;/);
  assert.match(
    pageCode,
    /const listedPlaces = useMemo\(\s*const narrow|const listedPlaces = useMemo\(\s*\(\) => narrowToViewport\(visiblePlaces, coverageViewport\)/,
  );
  assert.match(pageCode, /narrowToViewport\(mapPlaces, coverageViewport\)/);
  // And the camera datasets never read that viewport (no circular dependency).
  const cameraDatasets = pageCode.slice(
    pageCode.indexOf("const locateFitPlaces"),
    pageCode.indexOf("const mapPlaces"),
  );
  assert.doesNotMatch(cameraDatasets, /mapViewport|coverageViewport|visibleMapPlaces/);
});

// ---------------------------------------------------------------------------
// Scope discipline.
// ---------------------------------------------------------------------------

test("the curated LIST, both rows and eligibility are untouched", () => {
  assert.match(
    pageCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
  assert.match(
    pageCode,
    /narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
  // Pin styling is still per-Place and still reads canonical membership.
  assert.match(pageCode, /isCurated: curatedOnly && curatedIdSet\.has\(place\.id\),/);
  // The tab row keeps exactly its five controls.
  assert.match(pageCode, /grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5/);
  assert.match(pageCode, />\s*Tempat Pilihan\s*<\/button>/);
});

// ---------------------------------------------------------------------------
// 11. The CAMERA datasets are MODE-INDEPENDENT (correction 2026-10-05).
//
// ROOT CAUSE the previous round left open: the camera datasets were projected
// from `visiblePlaces`, the CONTENT-MODE set. Selecting "Tempat Pilihan"
// collapses that set to the curated subset, so a geocode answer that landed
// while the tab was active resolved the search camera dataset from the curated
// pins — the renewed search framed only the 10 curated Places and the full
// search-area framing was gone. Every camera dataset now reads ONE
// mode-independent eligible pool.
// ---------------------------------------------------------------------------

test("11: every camera dataset reads the mode-independent eligible pool", () => {
  // ONE pool, declared from the search-filtered eligible set.
  assert.match(pageCode, /const cameraEligiblePlaces = searchFiltered;/);
  // The searched region, the local area, and the locate widening all read it.
  assert.match(
    pageCode,
    /const searchFitPlaces = useMemo<HomeMapPlace\[\]>\(\(\) => \{[\s\S]*?narrowToViewport\(cameraEligiblePlaces, searchViewport\)/,
  );
  assert.match(pageCode, /places: toCameraCandidates\(cameraEligiblePlaces\),/);
  assert.match(pageCode, /candidatePlaces: toCameraCandidates\(cameraEligiblePlaces\),/);
  // ...and NONE of them reads the content-mode set any more, so selecting
  // "Tempat Pilihan" cannot re-frame or re-narrow the camera.
  const cameraDatasets = pageCode.slice(
    pageCode.indexOf("const cameraEligiblePlaces"),
    pageCode.indexOf("const mapPlaces"),
  );
  assert.doesNotMatch(cameraDatasets, /\bvisiblePlaces\b/);
});

test("11: a search answer landing while Tempat Pilihan is active still frames the full area", () => {
  const searchFit = pageCode.slice(
    pageCode.indexOf("const searchFitPlaces"),
    pageCode.indexOf("const mapPlaces"),
  );
  // No content mode appears in the search camera dataset: the framed set is
  // the eligible Places of the searched region, never the curated subset and
  // never the active distance preset.
  assert.doesNotMatch(searchFit, /curatedOnly|curatedIdSet|liveOnly|distanceFilter/);
  assert.doesNotMatch(searchFit, /CAMERA_PRESET_RADIUS_M|fallbackSearchArea/);
});

// ---------------------------------------------------------------------------
// 12. The map LAYER keeps every eligible Place in the active search area.
// ---------------------------------------------------------------------------

type MapCandidate = { id: string; latitude: number | null; longitude: number | null };

test("12: curated mode keeps the same eligible Places on the map as the normal mode", () => {
  const area: MapViewport = { north: 25.0, south: 24.4, east: 47.2, west: 46.2 };
  const searchFiltered: MapCandidate[] = [
    { id: "cur-1", latitude: 24.71, longitude: 46.67 },
    { id: "cur-2", latitude: 24.75, longitude: 46.7 },
    { id: "plain-1", latitude: 24.68, longitude: 46.65 },
    { id: "plain-2", latitude: 24.8, longitude: 46.72 },
    { id: "outside", latitude: 40.0, longitude: 46.6 },
  ];
  const curatedIdSet = new Set(["cur-1", "cur-2"]);

  // The exact `mapPlaces` formula the component uses in curated mode.
  const visible = searchFiltered.filter((place) => curatedIdSet.has(place.id));
  const coverageSource = searchFiltered.filter((place) => !curatedIdSet.has(place.id));
  const coverage = narrowToViewport(coverageSource, area);
  const mapPlaces = [...visible, ...coverage];
  const curatedLayer = narrowToViewport(mapPlaces, area)
    .map((place) => place.id)
    .sort();

  // The normal-mode layer over the same data.
  const normalLayer = narrowToViewport(searchFiltered, area)
    .map((place) => place.id)
    .sort();

  assert.deepEqual(curatedLayer, normalLayer, "curated mode must not drop an eligible Place");
  assert.deepEqual(curatedLayer, ["cur-1", "cur-2", "plain-1", "plain-2"]);
  assert.equal(curatedLayer.includes("outside"), false, "a Place outside the area stays out");
});

// ---------------------------------------------------------------------------
// 13. Current Location framing stays mode-independent.
// ---------------------------------------------------------------------------

test("13: the locate frame reads the mode-independent pool, so a tab cannot change it", () => {
  const locateMemo = pageCode.slice(
    pageCode.indexOf("const locateFitPlaces"),
    pageCode.indexOf("const mapPlaces"),
  );
  assert.match(locateMemo, /candidatePlaces: toCameraCandidates\(cameraEligiblePlaces\),/);
  assert.doesNotMatch(locateMemo, /\bvisiblePlaces\b/);
  // The locate trigger and latch are untouched by the tab: only `locateNonce`
  // fires the frame.
  assert.match(mapCode, /if \(!locateNonce \|\| lastLocateNonceRef\.current === locateNonce\) return;/);
  assert.match(mapCode, /lastLocateNonceRef\.current = locateNonce;/);
});