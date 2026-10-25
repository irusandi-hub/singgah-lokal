import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { boundsOfPoints, collectGeoPoints, narrowToViewport } from "@/lib/live/ui";

/**
 * HOME INITIAL FRAME / VIEWPORT CONSISTENCY (regression, 2026-10-23).
 *
 * HISTORY — two bugs, one symptom.
 *
 * (1) The map used to open on `map.fitWorld()`, which `minZoom: 2` clamped to a
 *     ~137° slice centred on [0, 0]. That slice covers the Gulf, so the first
 *     viewport report removed every Indonesian Place from the map, the rows, and
 *     the count: a frame that looks global while serving one region.
 * (2) The first fix (PR #53) made the DATASET agree with that frame by fitting
 *     the WHOLE catalogue at init (Gulf + Riyadh + West Java). Across two
 *     continents that fit IS a world-scale frame (`minZoom: 2`, ~137° of
 *     longitude): the Gulf Places collapse into one blob, and the real location
 *     camera replaces the frame a moment later. So Home still went
 *     "global overview → local area" during loading — and between the viewport
 *     report and the new tiles the narrowed local set was painted over the
 *     world basemap. That is the reported "global map with only two places,
 *     then it changes".
 *
 * THE RULE THIS FILE LOCKS: ONE initial frame, decided before any tile, marker,
 * or viewport report — the local area of a known origin (searched city first,
 * else the real fix), the catalogue spread ONLY once the first location attempt
 * has settled with no origin, and nothing at all while that attempt is still
 * running. The wait is driven by the request's own callbacks, never a timer.
 * The camera presets for a real fix / active search are untouched.
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

test("1. the no-origin catalogue frame is derived from the Place spread, never a world slice", () => {
  // The dataset-derived bounds really do cover every Place, so the viewport
  // gate that runs right after the first report keeps all of them.
  const points = collectGeoPoints(CATALOGUE);
  const bounds = boundsOfPoints(points);
  assert.ok(bounds, "the catalogue must produce bounds");
  const covered = narrowToViewport(CATALOGUE, bounds!);
  assert.equal(covered.length, CATALOGUE.length, "the catalogue frame must cover the whole catalogue");

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

test("2. the first frame follows the origin, and the catalogue only once the location attempt settled", () => {
  const decideStart = homeMap.indexOf("const finalizeInitialFrame = async (): Promise<boolean> => {");
  assert.notEqual(decideStart, -1, "the initial frame must be decided in ONE place");
  const decide = homeMap.slice(decideStart, decideStart + 1400);

  // A known origin frames the LOCAL AREA (the same rule the locate path uses)…
  assert.match(decide, /const origin = initialOriginRef\.current;[\s\S]{0,120}?applyOriginFrame\(origin\);/);
  // …with no origin, the catalogue frame is ONLY the settled outcome, and only
  // once the results-panel height it reserves has really been measured
  // (2026-10-25: a first frame may never be fitted with a guessed inset)…
  assert.match(
    decide,
    /\} else if \(viewerSettledRef\.current\) \{[\s\S]{0,600}?if \(bottomInsetRef\.current === null\) return false;[\s\S]{0,80}?applyCatalogueFrame\(\);/,
  );
  // …and while the first request is running, NOTHING is painted.
  assert.match(decide, /\} else \{[\s\S]{0,260}?return false;/);

  // The catalogue frame is the Place spread, single Place at the shared zoom,
  // and the world overview only when there is no coordinate at all.
  const catalogueStart = homeMap.indexOf("const applyCatalogueFrame = () => {");
  assert.notEqual(catalogueStart, -1);
  const catalogue = homeMap.slice(
    catalogueStart,
    homeMap.indexOf("const applyOriginFrame = (origin:", catalogueStart),
  );
  assert.match(catalogue, /map\.fitBounds\(/);
  assert.match(catalogue, /if \(initialPoints\.length === 1\) \{/);
  assert.match(catalogue, /map\.setView\(\[initialPoints\[0\]\.lat, initialPoints\[0\]\.lng\], FIT_SINGLE_PLACE_ZOOM/);
  // The world overview survives only as the no-coordinate fallback.
  assert.ok(
    catalogue.indexOf("map.fitWorld();") > catalogue.indexOf("} else if (initialBounds) {"),
    "fitWorld must be the last resort, after the single-Place and bounds branches",
  );
  // The initial move is instant: an opening flight would be a second camera
  // motion on top of the location preset.
  assert.match(catalogue, /animate: false/);
});

test("3. the origin frame is the SAME radius/local-area rule every other camera path uses", () => {
  const originStart = homeMap.indexOf("const applyOriginFrame = (origin: { lat: number; lng: number }) => {");
  assert.notEqual(originStart, -1, "the origin frame must exist");
  const origin = homeMap.slice(originStart, originStart + 1600);

  // The preset radius decides the zoom through the ONE shared helper — the
  // exact function the distance tabs use, so the first paint can never differ
  // from the preset a later tab choice would produce.
  assert.match(origin, /presetZoomForRadius\(map, origin, radius\)/);
  assert.match(homeMap, /function presetZoomForRadius\(/);
  assert.match(homeMap, /presetZoomForRadius\(map, position, radiusMeters\)/);
  // Without an active radius the local-area dataset is framed (the "Lokasi
  // Saya" rule), then the origin itself — never a fabricated coordinate.
  assert.match(origin, /collectGeoPoints\(locateFitPlacesRef\.current\)/);
  assert.match(origin, /map\.setView\(\[origin\.lat, origin\.lng\], Math\.max\(map\.getZoom\(\), SEARCH_MIN_ZOOM\)/);
  // The origin comes from Home's ONE resolved anchor, not from a second rule.
  assert.match(
    homeMap,
    /const origin = cameraCenter \?\? viewerPosition \?\? searchCenter \?\? null;/,
  );
});

test("4. no tile, marker, or viewport report happens before that frame is decided", () => {
  // The basemap is created INSIDE the finalizer, i.e. after the frame choice…
  const decideStart = homeMap.indexOf("const finalizeInitialFrame = async (): Promise<boolean> => {");
  const decide = homeMap.slice(decideStart, decideStart + 3400);
  assert.match(decide, /if \(!tileLayerRef\.current\) \{[\s\S]{0,700}?tileLayerRef\.current = L\.tileLayer\(OSM_TILE_URL/);
  // …and readiness (which gates the marker rebuild and every camera effect)
  // flips only after it, together with the container claim, and the frame kind
  // is recorded on the container (`origin` / `catalogue`) for the smoke suite.
  assert.match(decide, /container\.dataset\.singgahMap = "ready";/);
  assert.match(decide, /container\.dataset\.singgahMapFrame = origin \? "origin" : "catalogue";/);
  assert.match(decide, /initialFrameDoneRef\.current = true;\s*setReady\(true\);/);
  // Exactly one tile layer for the map's lifetime, still.
  assert.equal((homeMap.match(/L\.tileLayer\(/g) ?? []).length, 1);
  // The first viewport report stays inside the ready timer, after that.
  const firstReport = homeMap.indexOf("reportViewportBounds();", decideStart);
  assert.ok(firstReport > decideStart, "the first report must come after the frame decision");
});

test("5. the held frame is finished by the location OUTCOME, never by a timer", () => {
  // The map records that the very first attempt settled (success OR failure)…
  assert.match(
    homeDiscovery,
    /setViewerSettled\(true\);\s*\n\s*\},\s*\n\s*\/\/ Denial\/failure is silent/,
  );
  assert.match(homeDiscovery, /viewerSettled=\{viewerSettled\}/);
  // …and the held frame is resumed on that value / the origin itself.
  const resumeStart = homeMap.indexOf("if (initialFrameDoneRef.current) return;\n    const finalize = finalizeInitialFrameRef.current;");
  assert.notEqual(resumeStart, -1, "the held frame must have a resume path");
  // 2026-10-25: the measured panel inset is part of the same decision, so it
  // resumes a catalogue frame that was held for it — still an effect, still
  // driven by real values, never a timer.
  assert.match(
    homeMap,
    /\}, \[viewerSettled, viewerPosition, cameraCenter, searchCenter, bottomInset\]\);/,
  );
  // No timer is introduced for the wait: the ONLY setTimeout in the whole
  // finalizer is the pre-existing 150 ms destroy-safe invalidate/report pass.
  const decideStart = homeMap.indexOf("const finalizeInitialFrame = async (): Promise<boolean> => {");
  const decideBlock = homeMap.slice(decideStart, homeMap.indexOf("finalizeInitialFrameRef.current = finalizeInitialFrame;"));
  assert.equal((decideBlock.match(/setTimeout\(/g) ?? []).length, 1, "the wait adds no timer");
  assert.match(decideBlock, /\}, 150\);/);
});

test("6. the first frame never invents a coordinate or a stand-in city", () => {
  const start = homeMap.indexOf("const applyCatalogueFrame = () => {");
  const block = homeMap.slice(start, homeMap.indexOf("finalizeInitialFrameRef.current = finalizeInitialFrame;"));
  assert.notEqual(start, -1);
  // No literal coordinate, no default city, no rounded constant.
  assert.doesNotMatch(block, /-6\.9|107\.6|24\.71|46\.67|26\.3|50\.1/);
  assert.doesNotMatch(block, /\[0,\s*0\]/);
  assert.doesNotMatch(block, /Math\.random|Date\.now\(\)\s*%/);
});

test("7. narrowing rules for the rows and markers are unchanged", () => {
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
