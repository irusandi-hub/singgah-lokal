import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * HOME MAP-FIRST UI POLISH (PO, 2026-09-30)
 *
 * Scope of this lock: PRESENTATION ONLY. The functional baseline at
 * d47ee20 (camera values, curated coverage vs curated result, current
 * location transition/pulse, marker model, Discovery independence) is
 * locked by tests/map-current-location.test.ts,
 * tests/discovery-home-integration.test.ts, tests/map-empty-state.test.ts,
 * and tests/map-stacking.test.ts. Nothing here may relax those.
 *
 * The polish intent: clean / premium / modern / compact / map-first /
 * subtle. The map is the primary visual element of Home; search, filter,
 * and results support it.
 *
 * Locked geometry and its responsive rationale:
 * 1. Map frame: h-[64vh] clamped by min-h-[480px] / max-h-[760px],
 *    ~24px radius, subtle border, light shadow, still a clipping boundary
 *    (relative + isolate + overflow-hidden). The clamp is what keeps the
 *    map dominant AND overflow-free at 360px and at 1280px desktop.
 * 2. Search: ~20px radius, compact vertical padding, subtle border, and
 *    NO heavy shadow.
 * 3. Filter: still ONE row, same five controls, same order, ~16px radius
 *    (not full pills), no horizontal-overflow escape hatch (no
 *    overflow-x-auto), because the grid columns are what guarantee 360px.
 * 4. Result cards: ~18px radius, subtle border, light shadow, and the
 *    result section sits closer to the map.
 * 5. Section order stays HEADER -> SEARCH -> FILTER -> MAP -> RESULT ->
 *    INTRO.
 * 6. No gradients anywhere in the Home surface (forbidden by the polish
 *    brief), and no heavy shadow utility.
 */

const homeDiscovery = readFileSync(
  new URL("../components/home-discovery.tsx", import.meta.url),
  "utf8",
);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter(
      (line) =>
        !line.trim().startsWith("*") &&
        !line.trim().startsWith("//") &&
        !line.trim().startsWith("/*"),
    )
    .join("\n");
}

const code = stripComments(homeDiscovery);

test("map frame is the primary Home visual element with a clamped height", () => {
  assert.match(
    code,
    /<section className="relative isolate h-\[64vh\] min-h-\[480px\] max-h-\[760px\] overflow-hidden rounded-\[24px\] border border-black\/10 bg-\[#d9dfd2\] shadow-sm">/,
  );
});

test("map frame remains a clipping boundary and the retired 58vh/430px/28px frame is gone", () => {
  // relative + isolate + overflow-hidden is the Leaflet stacking lock.
  assert.match(code, /relative isolate h-\[64vh\][^"]*overflow-hidden/);
  assert.doesNotMatch(code, /h-\[58vh\]/);
  assert.doesNotMatch(code, /min-h-\[430px\]/);
  assert.doesNotMatch(code, /rounded-\[28px\]/);
});

test("search surface is compact with a ~20px radius and no heavy shadow", () => {
  assert.match(
    code,
    /flex items-center gap-3 rounded-\[20px\] border border-black\/10 bg-white px-4 py-3 shadow-sm/,
  );
  // Copy, label, and control function are untouched by the polish.
  assert.match(code, /aria-label="Cari tempat, cerita, produksi"/);
});

test("filter stays a single row with the locked five controls in order", () => {
  assert.match(
    code,
    /<div className="mb-4 grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5 pb-1">/,
  );
  // Order: LIVE -> Tempat Pilihan -> the three ordered distance tabs.
  const liveIndex = code.indexOf("setLiveOnly((value) => !value)");
  const curatedIndex = code.indexOf("setCuratedOnly(true)");
  const distanceIndex = code.indexOf("DISTANCE_FILTERS.map((filter) =>");
  assert.ok(liveIndex > -1, "LIVE control must exist");
  assert.ok(curatedIndex > liveIndex, "Tempat Pilihan must follow LIVE");
  assert.ok(distanceIndex > curatedIndex, "distance tabs must follow Tempat Pilihan");
});

test("filter controls use a ~16px radius rather than full pills", () => {
  const rounded16 = code.match(/rounded-\[16px\]/g) ?? [];
  // LIVE, Tempat Pilihan, and the shared distance-tab class.
  assert.equal(rounded16.length, 3);
  // No pill styling may creep back onto the filter BUTTONS. The only
  // rounded-full left in the row is the tiny LIVE status dot, which is
  // existing LIVE semantics (a dot, not a pill) and stays untouched.
  const filterRow = code.slice(
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]") + 2600,
  );
  const pills = filterRow.match(/rounded-full/g) ?? [];
  assert.equal(
    pills.length,
    1,
    "the LIVE status dot is the only rounded-full left in the filter row",
  );
  assert.match(filterRow, /h-1\.5 w-1\.5 rounded-full/);
});

test("filter row has no horizontal-overflow escape hatch", () => {
  // The five-column grid IS the 360px guarantee; an overflow scroller would
  // silently replace it with a scrollable row.
  assert.doesNotMatch(code, /overflow-x-auto/);
  assert.doesNotMatch(code, /overflow-x-scroll/);
});

test("result cards use an ~18px radius with a subtle border and light shadow", () => {
  assert.match(
    code,
    /group flex flex-col rounded-\[18px\] border border-black\/10 bg-white p-4 shadow-sm transition hover:shadow-md/,
  );
  // The map-first rhythm: results sit closer to the map than before.
  assert.match(code, /<section className="mt-5" aria-labelledby="place-results-heading">/);
  assert.doesNotMatch(code, /<section className="mt-6" aria-labelledby="place-results-heading">/);
});

test("Home section order stays HEADER -> SEARCH -> FILTER -> MAP -> RESULT -> INTRO", () => {
  const order = [
    "<SiteNav />",
    'aria-label="Cari tempat, cerita, produksi"',
    "grid grid-cols-[auto_auto_1fr_1fr_1fr]",
    "h-[64vh] min-h-[480px]",
    'aria-labelledby="place-results-heading"',
    "Jangan hanya datang.",
  ].map((needle) => code.indexOf(needle));

  for (const [index, position] of order.entries()) {
    assert.ok(position > -1, `missing section marker at index ${index}`);
  }
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      order[i] > order[i - 1],
      `section order broken: marker ${i} must follow marker ${i - 1}`,
    );
  }
});

test("polish adds no gradients and no heavy shadow utility", () => {
  assert.doesNotMatch(code, /bg-gradient-to-/);
  assert.doesNotMatch(code, /bg-linear-to-/);
  assert.doesNotMatch(code, /shadow-xl/);
  assert.doesNotMatch(code, /shadow-2xl/);
});

test("polish leaves the functional camera / coverage / marker wiring untouched", () => {
  // These are the baseline d47ee20 contracts: camera is 10 km for both
  // curated and the 10 km+ tab, the curated MAP shows curated + coverage
  // while the curated LIST stays curated-only, and the per-Place marker
  // treatment still flows through mapPlaces.
  assert.match(
    code,
    /cameraRadiusMeters=\{\s*curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]\s*\}/,
  );
  assert.match(code, /pulsePinOnPresetChange=\{curatedOnly\}/);
  assert.match(
    code,
    /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoveragePlaces\] : visiblePlaces;/,
  );
  assert.match(
    code,
    /isCurated: curatedOnly && curatedIdSet\.has\(place\.id\),/,
  );
  assert.match(
    code,
    /if \(curatedOnly \|\| distanceFilter === "10 km\+"\)/,
  );
});
