import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { boundsOfPoints, collectGeoPoints, narrowToViewport } from "@/lib/live/ui";

/**
 * HOME INITIAL FRAME / VIEWPORT CONSISTENCY (regression, 2026-10-23).
 *
 * BUG: with no location permission Home opened on `map.fitWorld()`, which the
 * map's `minZoom: 2` clamped to a ~137° slice of the world centred on [0, 0].
 * That slice covers the Gulf, so the first viewport report silently removed
 * every Indonesian Place from the map, the rows, and the count — a frame that
 * looks global while serving one region, and then a visible collapse once the
 * report landed.
 *
 * FIX: the neutral frame is fitted to the CANONICAL PLACE SPREAD the map was
 * handed; `fitWorld()` survives only as the no-coordinate fallback. The camera
 * presets for a real Current Location fix / active search are untouched.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

// The published catalogue's real shape: Gulf + Riyadh + West Java. Bounds are
// the canonical coordinates only — never a guessed city or stand-in point.
const CATALOGUE = [
  { latitude: 26.3642121, longitude: 50.1988771 }, // Dammam
  { latitude: 24.7442, longitude: 46.6728 }, // Riyadh
  { latitude: -6.9553, longitude: 107.6377 }, // Bandung
  { latitude: -7.0455, longitude: 107.5897 }, // Banjaran
];

test("1. the initial frame is fitted to the Place spread, not to a world slice", () => {
  // The dataset-derived bounds really do cover every Place, so the viewport
  // gate that runs right after the first report keeps all of them.
  const points = collectGeoPoints(CATALOGUE);
  const bounds = boundsOfPoints(points);
  assert.ok(bounds, "the catalogue must produce bounds");
  const covered = narrowToViewport(CATALOGUE, bounds!);
  assert.equal(covered.length, CATALOGUE.length, "the first frame must cover the whole catalogue");

  // The OLD frame is what dropped them: a fitWorld clamped by minZoom 2 on a
  // 390px-wide phone is roughly ±68° of longitude around 0. The Gulf and
  // Riyadh survive it; every West Java Place is outside it.
  const worldSlice = { north: 66, south: -66, east: 68, west: -68 };
  const underOldFrame = narrowToViewport(CATALOGUE, worldSlice);
  assert.equal(underOldFrame.length, 2, "the clamped world slice keeps only the Gulf/Riyadh Places");
  assert.equal(
    underOldFrame.some((place) => place.longitude === 107.6377),
    false,
    "the clamped world slice silently dropped the Indonesian catalogue",
  );
});

test("2. HomeMap fits the dataset at init and keeps fitWorld only as the fallback", () => {
  const initStart = homeMap.indexOf("const initialPoints = collectGeoPoints(placesRef.current);");
  assert.notEqual(initStart, -1, "the initial frame must be derived from the Place dataset");
  const initBlock = homeMap.slice(initStart, initStart + 2000);

  // Dataset first…
  assert.match(initBlock, /map\.fitBounds\(/);
  // …single Place framed at the shared single-Place zoom (a degenerate box
  // would otherwise jump to maximum zoom)…
  assert.match(homeMap, /if \(initialPoints\.length === 1\) \{/);
  assert.match(homeMap, /map\.setView\(\[initialPoints\[0\]\.lat, initialPoints\[0\]\.lng\], FIT_SINGLE_PLACE_ZOOM/);
  // …and the neutral world overview only when there is no coordinate at all.
  assert.match(homeMap, /\} else \{\s*map\.fitWorld\(\);\s*\}/);

  // The initial move is instant: an opening flight would be a second camera
  // motion on top of the location preset.
  assert.match(initBlock, /animate: false/);
});

test("3. the first frame never invents a coordinate or a stand-in city", () => {
  const initStart = homeMap.indexOf("const initialPoints = collectGeoPoints(placesRef.current);");
  const initBlock = homeMap.slice(initStart, initStart + 2000);
  // No literal coordinate, no default city, no rounded constant.
  assert.doesNotMatch(initBlock, /-6\.9|107\.6|24\.71|46\.67|26\.3|50\.1/);
  assert.doesNotMatch(initBlock, /\[0,\s*0\]/);
  assert.doesNotMatch(initBlock, /Math\.random|Date\.now\(\)\s*%/);
});

test("4. the initial fit is in place before the first viewport report", () => {
  const initFit = homeMap.indexOf("const initialPoints = collectGeoPoints(placesRef.current);");
  const firstReport = homeMap.indexOf("reportViewportBounds();", initFit);
  assert.notEqual(initFit, -1);
  assert.notEqual(firstReport, -1, "the first viewport report must come after the initial frame");
  assert.ok(
    initFit < firstReport,
    "the map must frame the dataset BEFORE its viewport narrows the rows and markers",
  );
});

test("5. narrowing rules for the rows and markers are unchanged", () => {
  // The viewport gate itself is the documented 2026-10-01 behaviour and this
  // fix must not weaken it: markers and both rows are still narrowed by the
  // same coverage viewport, and a Place without coordinates is still dropped.
  assert.match(
    homeDiscovery,
    /const visibleMapPlaces = useMemo\(\s*\n?\s*\(\) => narrowToViewport\(mapPlaces, coverageViewport\)/,
  );
  assert.equal(narrowToViewport([{ latitude: null, longitude: 1 }], null).length, 0);
  assert.equal(narrowToViewport([{ latitude: 1, longitude: null }], null).length, 0);
  // A viewport still removes Places outside it — the gate is real.
  assert.equal(
    narrowToViewport(CATALOGUE, { north: 27, south: 25, east: 51, west: 49 }).length,
    1,
  );
});
