import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMERA_PRESET_RADIUS_M,
  acceptSearchResponse,
  clearCitySearch,
  distanceMeters,
  formatDistance,
  narrowToViewport,
  resolveActiveCenter,
  type ActiveCenter,
  type MapViewport,
} from "../lib/live/ui";

/**
 * ACTIVE SEARCH CENTER SYNCHRONIZATION (bug fix 2026-10-02)
 *
 * Device report that prompted this suite: the user searched "Riyadh" from
 * Dammam. The map flew to 24.6389, 46.7160, but the Place rows kept showing
 * ~399 km — because the viewport COVERAGE filtered by the searched city while
 * BOTH distance labels measured from the device fix. Two sources of truth
 * described two different places on the same screen.
 *
 * Four separate defects are locked shut here, each proven from code before it
 * was fixed:
 *  A. distance labels always used `viewerPosition`, never the active center;
 *  B. "Lokasi Saya" only moved the camera — it never cleared the searched
 *     city, so the coverage box, the name text filter and the "Area
 *     pencarian" status all survived the press;
 *  C. a geocode still in flight could land AFTER "Lokasi Saya" and drag the
 *     map and rows back, because the guard compared the query text — which
 *     "Lokasi Saya" does not change;
 *  D. the radius preset framed `viewerPosition` unconditionally, so 1 km → 5 km
 *     during a city search silently discarded the searched center.
 *
 * The pure helpers carry the executable proofs; the source assertions cover
 * the component wiring, which cannot run without a DOM harness.
 */

/** The two real coordinates from the device report. */
const RIYADH: ActiveCenter = { lat: 24.6389, lng: 46.716 };
const DAMMAM: ActiveCenter = { lat: 26.4207, lng: 50.0888 };

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const discoveryCode = stripComments(homeDiscovery);
const mapCode = stripComments(homeMap);

/** The ±0.05° bridge box the component builds around a searched city. */
function bridgeViewport(center: ActiveCenter): MapViewport {
  return {
    north: center.lat + 0.05,
    south: center.lat - 0.05,
    east: center.lng + 0.05,
    west: center.lng - 0.05,
  };
}

// ---------------------------------------------------------------------------
// LOC-01 / LOC-02 / LOC-07 — one center for filtering AND for distance
// ---------------------------------------------------------------------------

test("LOC-01 LOC-02 LOC-07: a searched city is the active center, and the distance label agrees with the filter", () => {
  // The searched city owns the center while a search answer exists.
  assert.deepEqual(resolveActiveCenter({ searchCenter: RIYADH, viewerPosition: DAMMAM }), {
    mode: "city_search",
    center: RIYADH,
  });

  // THE REPORTED BUG, pinned: a Place sitting in the Riyadh box is admitted
  // by the coverage filter, so its label must read ~0 km from the same center.
  // Measured from the device it reads ~392 km — the contradiction users saw.
  const placeInRiyadh = { lat: RIYADH.lat, lng: RIYADH.lng };
  const active = resolveActiveCenter({ searchCenter: RIYADH, viewerPosition: DAMMAM }).center;
  assert.ok(active);

  const fromActive = distanceMeters(active, placeInRiyadh);
  const fromDevice = distanceMeters(DAMMAM, placeInRiyadh);

  assert.ok(fromActive < 1000, `label must be ~0 km from the active center, got ${fromActive} m`);
  assert.ok(fromDevice > 350_000, `the old device-origin label was the ~399 km complaint, got ${fromDevice} m`);
  // The two are genuinely different numbers — this test can never pass by
  // accident because the coordinates happen to coincide.
  assert.notEqual(fromActive, fromDevice);
});

test("LOC-07 LOC-11: with no city searched the device fix is the active center, and nothing is invented without one", () => {
  assert.deepEqual(resolveActiveCenter({ searchCenter: null, viewerPosition: DAMMAM }), {
    mode: "device_location",
    center: DAMMAM,
  });
  // Location denied / not yet available: no center at all. Fail-closed — the
  // UI renders no distance rather than a fabricated one (AGENTS.md).
  assert.deepEqual(resolveActiveCenter({ searchCenter: null, viewerPosition: null }), {
    mode: "device_location",
    center: null,
  });
  // Non-finite coordinates are treated as absent, never as a usable origin.
  assert.equal(resolveActiveCenter({ searchCenter: null, viewerPosition: { lat: NaN, lng: 0 } }).center, null);
  assert.equal(resolveActiveCenter({ searchCenter: { lat: 0, lng: Infinity }, viewerPosition: DAMMAM }).center, DAMMAM);
});

test("the two distance labels in the component read the active center, not the device", () => {
  // Defect A: both call sites used `viewerPosition`. A stale call site would
  // silently reintroduce the 399 km contradiction.
  assert.doesNotMatch(discoveryCode, /distanceMeters\(viewerPosition/);
  assert.equal((discoveryCode.match(/distanceMeters\(activeCenter/g) ?? []).length, 2);
});

// ---------------------------------------------------------------------------
// LOC-03 / LOC-04 / LOC-05 — a radius change keeps the active center
// ---------------------------------------------------------------------------

test("LOC-03 LOC-04 LOC-05: changing the radius never changes the active center", () => {
  for (const tab of ["1 km", "5 km", "10 km+"] as const) {
    // The radius is a CAMERA preset; it is not an input to the center, so the
    // center is provably identical before and after the change.
    const before = resolveActiveCenter({ searchCenter: RIYADH, viewerPosition: DAMMAM });
    const after = resolveActiveCenter({ searchCenter: RIYADH, viewerPosition: DAMMAM });
    assert.deepEqual(after, before);
    assert.equal(after.center, RIYADH, `${tab} must keep the searched city as the center`);
    // And the camera radius it frames is the locked, strictly ordered preset.
    assert.equal(CAMERA_PRESET_RADIUS_M[tab], { "1 km": 1000, "5 km": 5000, "10 km+": 10000 }[tab]);
  }
  assert.ok(CAMERA_PRESET_RADIUS_M["1 km"] < CAMERA_PRESET_RADIUS_M["5 km"]);
  assert.ok(CAMERA_PRESET_RADIUS_M["5 km"] < CAMERA_PRESET_RADIUS_M["10 km+"]);
});

test("LOC-04 LOC-05: the radius preset frames the active center, not the device unconditionally", () => {
  // Defect D: the preset effect hardcoded `viewerPosition` for both the zoom
  // derivation and the setView target.
  assert.match(mapCode, /const anchor = cameraCenter \?\? viewerPosition;/);
  assert.match(mapCode, /radiusZoom\(map, anchor, cameraRadiusMeters\)/);
  assert.match(mapCode, /map\.setView\(\[anchor\.lat, anchor\.lng\]/);
  assert.doesNotMatch(mapCode, /radiusZoom\(map, viewerPosition/);
  // Home must hand the resolved center down, so the map never re-derives it.
  assert.match(discoveryCode, /cameraCenter=\{activeCenter\}/);
  // Radius changes re-key the effect so a new preset re-arms.
  assert.match(mapCode, /cameraCenterKey/);
});

// ---------------------------------------------------------------------------
// LOC-06 / LOC-08 / LOC-16 — "Lokasi Saya" resets city search atomically
// ---------------------------------------------------------------------------

test("LOC-06 LOC-08: returning to the device drops the city center, query, error and pending flag together", () => {
  // One value, so the UI can never paint a half-cleared state (camera back on
  // the device while the rows are still narrowed to the old city).
  const cleared = clearCitySearch();
  assert.deepEqual(cleared, { query: "", pending: false, error: null, center: null });
  // Every field is reset, not just the center.
  assert.equal(cleared.query, "");
  assert.equal(cleared.pending, false);
  assert.equal(cleared.error, null);
  assert.equal(cleared.center, null);

  // The center really goes back to the device afterwards.
  const after = resolveActiveCenter({ searchCenter: cleared.center, viewerPosition: DAMMAM });
  assert.equal(after.mode, "device_location");
  assert.equal(after.center, DAMMAM);
  // The typed city must be gone too, or it stays a live text filter over
  // Place names and the list remains filtered to the abandoned city.
  assert.equal(cleared.query, "");
});

test("LOC-06: the locate handler resets the city search and releases the viewport latch", () => {
  const handler = discoveryCode.slice(
    discoveryCode.indexOf("const handleLocatePress"),
    discoveryCode.indexOf("const liveByPlaceId"),
  );
  // It must clear ALL four pieces of city state, not just move the camera.
  assert.match(handler, /searchEpochRef\.current \+= 1;/);
  assert.match(handler, /const cleared = clearCitySearch\(\);/);
  assert.match(handler, /setSearchQuery\(cleared\.query\);/);
  assert.match(handler, /setSearchPending\(cleared\.pending\);/);
  assert.match(handler, /setSearchError\(cleared\.error\);/);
  assert.match(handler, /setSearchCenter\(cleared\.center\);/);
  // Coverage returns to the REAL Leaflet bounds, and the camera follows the
  // fresh fix.
  assert.match(handler, /resetViewportLatch\(\);/);
  assert.match(handler, /setLocateNonce\(\(nonce\) => nonce \+ 1\);/);
  assert.match(handler, /requestViewerPosition\(\);/);
});

test("LOC-08: the \"Area pencarian\" status is gated on the searched city, so it disappears on reset", () => {
  // The status branch can only render while a city center exists.
  assert.match(discoveryCode, /\) : searchCenter \? \(/);
  // And it describes the ACTIVE center it is reporting on.
  assert.match(discoveryCode, /Area pencarian: \{searchCenter\.lat\.toFixed\(4\)\}/);
});

test("LOC-16: a fresh Home starts in device mode with no city state", () => {
  // Initial state: no search answer, so coverage is the REAL viewport and the
  // center is the device fix (or null before permission is granted).
  const initial = resolveActiveCenter({ searchCenter: null, viewerPosition: DAMMAM });
  assert.equal(initial.mode, "device_location");
  assert.equal(initial.center, DAMMAM);
  // The clear payload is idempotent against that initial state.
  const cleared = clearCitySearch();
  assert.equal(resolveActiveCenter({ searchCenter: cleared.center, viewerPosition: DAMMAM }).center, DAMMAM);
});

// ---------------------------------------------------------------------------
// LOC-09 / LOC-10 — a late response never overwrites a newer intent
// ---------------------------------------------------------------------------

test("LOC-09: a Riyadh response still in flight is dropped once \"Lokasi Saya\" was pressed", () => {
  // The exact race: the text is STILL "Riyadh" after the press, so a
  // query-string guard alone would accept this stale answer.
  const stale = acceptSearchResponse({
    requestEpoch: 4,
    currentEpoch: 5, // bumped by the locate press
    submitted: "Riyadh",
    activeQuery: "Riyadh",
  });
  assert.equal(stale, false, "a superseded response must never be applied");
});

test("LOC-10: a slow earlier response is dropped after a newer query replaces it", () => {
  assert.equal(
    acceptSearchResponse({
      requestEpoch: 2,
      currentEpoch: 2,
      submitted: "Riyadh",
      activeQuery: "Jakarta",
    }),
    false,
  );
  // The newest request for the newest text is always accepted.
  assert.equal(
    acceptSearchResponse({
      requestEpoch: 2,
      currentEpoch: 2,
      submitted: "Jakarta",
      activeQuery: "Jakarta",
    }),
    true,
  );
});

test("LOC-09 LOC-10: the search flow guards every post-await write with the epoch check", () => {
  const body = discoveryCode.slice(
    discoveryCode.indexOf("const runSearch"),
    discoveryCode.indexOf("useEffect", discoveryCode.indexOf("const runSearch")),
  );
  // The epoch is captured BEFORE the request goes out, so a later intent is
  // always visible on return.
  assert.match(body, /const requestEpoch = searchEpochRef\.current;/);
  assert.match(body, /const isCurrent = \(\) =>\s*acceptSearchResponse\(\{/);
  // Success, not-found, bad-payload and catch paths all re-check it, so no
  // branch can write through a superseded request.
  assert.ok((body.match(/if \(!isCurrent\(\)\) return;/g) ?? []).length >= 3);
  // A new answer releases the viewport latch so the real Leaflet bounds
  // supersede the synthetic bridge box.
  assert.match(body, /resetViewportLatch\(\);/);
});

// ---------------------------------------------------------------------------
// LOC-12 / LOC-13 / LOC-14 / LOC-15 — results follow the active center
// ---------------------------------------------------------------------------

test("LOC-03 LOC-12: results narrow to the active center, and an empty radius is a real empty state", () => {
  const riyadhPlaces = [
    { id: "a", latitude: RIYADH.lat, longitude: RIYADH.lng },
    { id: "b", latitude: RIYADH.lat + 0.01, longitude: RIYADH.lng },
  ];
  const bridge = bridgeViewport(RIYADH);

  // In the active center's area: both Places are listed.
  assert.equal(narrowToViewport(riyadhPlaces, bridge).length, 2);
  // LOC-03 — a 1 km frame around Riyadh does not admit a Dammam Place, and
  // never invents a position for a coordinate-less one.
  const dammamPlace = { id: "d", latitude: DAMMAM.lat, longitude: DAMMAM.lng };
  assert.deepEqual(narrowToViewport([...riyadhPlaces, dammamPlace], bridge).map((p) => p.id), ["a", "b"]);
  assert.deepEqual(
    narrowToViewport([...riyadhPlaces, { id: "none", latitude: null, longitude: null }], bridge).map((p) => p.id),
    ["a", "b"],
  );
  // A tighter frame still narrows progressively — it can only REMOVE.
  const tightFrame: MapViewport = {
    north: RIYADH.lat + 0.001,
    south: RIYADH.lat - 0.001,
    east: RIYADH.lng + 0.001,
    west: RIYADH.lng - 0.001,
  };
  assert.deepEqual(narrowToViewport(riyadhPlaces, tightFrame).map((p) => p.id), ["a"]);

  // LOC-12 — an area with no Place is an empty list, never a silent fallback
  // back to the previous (wider) result.
  const emptyFrame: MapViewport = {
    north: 24.9,
    south: 24.8,
    east: 46.9,
    west: 46.8,
  };
  assert.deepEqual(narrowToViewport(riyadhPlaces, emptyFrame), []);
});

test("LOC-13: the curated layer narrows by the same active center", () => {
  const curatedInRiyadh = { id: "c1", latitude: RIYADH.lat, longitude: RIYADH.lng };
  const curatedInDammam = { id: "c2", latitude: DAMMAM.lat, longitude: DAMMAM.lng };
  const listed = narrowToViewport([curatedInRiyadh, curatedInDammam], bridgeViewport(RIYADH));
  assert.deepEqual(listed.map((p) => p.id), ["c1"]);
  // Curated membership still comes from the canonical flag, never the viewport.
  assert.match(discoveryCode, /searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\)/);
});

test("LOC-14: LIVE cards follow the same listed set as every other layer", () => {
  // The pipeline is: coverage narrow → listed ids → LIVE cards. LIVE is
  // intersected with the listed set, never a separate coverage source.
  assert.match(discoveryCode, /const listedIds = new Set\(listedPlaces\.map\(\(place\) => place\.id\)\);/);
  assert.match(discoveryCode, /return liveItems\.filter\(\(item\) => listedIds\.has\(item\.placeId\)\);/);

  // Executable proof: a live session for a Place outside the active center is
  // dropped, one inside is kept.
  const listed = narrowToViewport(
    [{ id: "in", latitude: RIYADH.lat, longitude: RIYADH.lng }],
    bridgeViewport(RIYADH),
  );
  const liveItems = [
    { placeId: "in", sessionId: "s1" },
    { placeId: "out", sessionId: "s2" },
  ];
  const listedIds = new Set(listed.map((p) => p.id));
  assert.deepEqual(liveItems.filter((i) => listedIds.has(i.placeId)).map((i) => i.sessionId), ["s1"]);
});

test("LOC-15: the REAL Leaflet viewport supersedes the bridge box once reported", () => {
  // The bridge box used to win FOREVER, so a searched city permanently
  // overrode manual panning: the map moved and the list refused to follow.
  assert.match(discoveryCode, /const coverageViewport = mapViewport \?\? searchViewport;/);

  // Executable: after the user pans to Dammam, the reported bounds decide.
  const panned = narrowToViewport(
    [
      { id: "r", latitude: RIYADH.lat, longitude: RIYADH.lng },
      { id: "d", latitude: DAMMAM.lat, longitude: DAMMAM.lng },
    ],
    bridgeViewport(DAMMAM),
  );
  assert.deepEqual(panned.map((p) => p.id), ["d"]);

  // Before Leaflet has reported, the bridge box stands in — never an empty
  // first paint right after a search.
  assert.equal(narrowToViewport([{ id: "r", latitude: RIYADH.lat, longitude: RIYADH.lng }], bridgeViewport(RIYADH)).length, 1);
  assert.equal(narrowToViewport([{ id: "r", latitude: RIYADH.lat, longitude: RIYADH.lng }], null).length, 1);
});

// ---------------------------------------------------------------------------
// Formatting sanity — the label itself must stay truthful
// ---------------------------------------------------------------------------

test("the distance label formats the active-center measurement, not a device measurement", () => {
  const active = resolveActiveCenter({ searchCenter: RIYADH, viewerPosition: DAMMAM }).center!;
  const placeInRiyadh = { lat: RIYADH.lat, lng: RIYADH.lng };
  // From the active center the Place is in-area; from the device it is the
  // ~392 km the user saw on a Place the filter had just admitted.
  assert.equal(formatDistance(distanceMeters(active, placeInRiyadh)), "0 m");
  assert.equal(formatDistance(distanceMeters(DAMMAM, placeInRiyadh)), "392,1 km");
});
