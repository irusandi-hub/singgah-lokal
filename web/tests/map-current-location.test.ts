import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homePage = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const locationPicker = readFileSync(
  new URL("../components/place-location-picker.tsx", import.meta.url),
  "utf8",
);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

test("Home Map makes Current Location a first-class function via browser geolocation", () => {
  assert.match(homePage, /navigator\.geolocation\.getCurrentPosition/);
  assert.match(homePage, /setViewerPosition\(\{/);
  // No default Indonesia coordinate ever becomes the user position or the
  // map's initial visible camera — no stand-in viewport exists at all.
  const pageCode = stripComments(homePage);
  assert.doesNotMatch(pageCode, /lat:\s*-2\.5|lng:\s*118/);
  const mapCode = stripComments(homeMap);
  assert.doesNotMatch(mapCode, /-2\.5, 118|center: \[-2\.5/);
});

test("Home Map starts on the neutral world overview and has NO Indonesia fallback camera", () => {
  const mapCode = stripComments(homeMap);
  // fitWorld = neutral world overview until the real fix defines the view.
  assert.match(mapCode, /map\.fitWorld\(\)/);
  assert.equal(mapCode.includes("-2.5, 118"), false);
});

test("Home Map shows a user marker from the real fix and centers on it", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /circleMarker\(\[viewerPosition\.lat, viewerPosition\.lng\]/);
  assert.match(mapCode, /Lokasi Anda/);
  assert.match(mapCode, /flyToUser\(map, viewerPosition\)/);
});

test("Home Map provides a Lokasi Saya button that recenters on the real fix", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /Lokasi Saya/);
  assert.match(mapCode, /onRequestLocate/);
  assert.match(mapCode, /locatePendingRef\.current = true/);
  assert.match(mapCode, /flyToUser\(map, viewerPosition\)/);
});

test("No fake user position is ever invented when geolocation is unavailable", () => {
  const pageCode = stripComments(homePage);
  // Every setViewerPosition call must come from the geolocation callback —
  // no constant/default/fallback point is ever assigned as user position.
  const writes = pageCode.match(/setViewerPosition\([\s\S]{0,200}?\}\)/g) ?? [];
  assert.ok(writes.length >= 1, "geolocation must feed viewerPosition");
  for (const write of writes) {
    assert.match(write, /position\.coords/);
    assert.doesNotMatch(write, /-2\.5|118|DEFAULT|fallback/i);
  }
});

test("Home Map keeps exactly one basemap and no layer/terrain/satellite selector", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /L\.tileLayer\(OSM_TILE_URL/);
  assert.equal(mapCode.includes("L.control.layers"), false);
  assert.equal(/terrain|satellite/i.test(mapCode), false);
});

test("Home Map enables functional pan, zoom, scroll and touch interactions", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /scrollWheelZoom: true/);
  assert.match(mapCode, /L\.control\.zoom\(/);
  // Leaflet's default drag/touch pan stays on (not disabled anywhere).
  assert.equal(mapCode.includes("dragging: false"), false);
  assert.equal(mapCode.includes("touchZoom: false"), false);
});

test("One container = one Leaflet instance; teardown is complete", () => {
  const mapCode = stripComments(homeMap);
  // Synchronous claim before the async import resolves (Strict Mode safe)...
  assert.match(mapCode, /container\.dataset\.singgahMap = "initializing"/);
  assert.match(mapCode, /container\.dataset\.singgahMap = ""/);
  // ...and full cleanup: listeners, layers, and the map itself.
  assert.match(mapCode, /map\.off\(\)/);
  assert.match(mapCode, /map\.remove\(\)/);
  assert.match(mapCode, /markerLayerRef\.current\?\.remove\(\)/);
  assert.match(mapCode, /userLayerRef\.current\?\.remove\(\)/);
});

test("invalidateSize runs after init and on window resize (no stacked mobile tiles)", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /map\.invalidateSize\(\)/);
  assert.match(mapCode, /window\.addEventListener\("resize"/);
  assert.match(mapCode, /window\.removeEventListener\("resize"/);
});

test("Marker refresh and filter changes never steal the viewport from the user", () => {
  const mapCode = stripComments(homeMap);
  // A real user pan/zoom latches the camera against automatic moves...
  assert.match(mapCode, /userInteractedRef\.current = true/);
  // ...fitBounds is a one-shot overview for the no-fix case only...
  assert.match(mapCode, /!cameraDecidedRef\.current &&\s*!userInteractedRef\.current/);
  // ...guarded against the Current Location fix arriving during the async
  // import (no race with Current Location)...
  assert.match(mapCode, /!viewerPositionRef\.current &&/);
  // ...and programmatic flights are excluded from the latch.
  assert.match(mapCode, /programmaticMoveRef\.current = true/);
});

test("Places only ever use canonical database coordinates; no fabricated position", () => {
  // Map markers fail closed on canonical lat/lng...
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /Number\.isFinite\(place\.latitude\)/);
  assert.match(mapCode, /Number\.isFinite\(place\.longitude\)/);
  // ...the picker's coordinates come only from user actions (map click,
  // marker drag, or real geolocation) — no demo/default Place point.
  const pickerCode = stripComments(locationPicker);
  assert.match(pickerCode, /navigator\.geolocation\.getCurrentPosition/);
  assert.doesNotMatch(pickerCode, /changeRef\.current\(-2\.5\.toString|changeRef\.current\(118\.toString/);
});

test("Place Location Picker offers Gunakan lokasi saya with loading and error feedback", () => {
  const pickerCode = stripComments(locationPicker);
  assert.match(pickerCode, /Gunakan lokasi saya/);
  assert.match(pickerCode, /setLocateState\("loading"\)/);
  assert.match(pickerCode, /setLocateState\("error"\)/);
  assert.match(pickerCode, /changeRef\.current\(lat\.toString\(\), lng\.toString\(\)\)/);
  assert.match(pickerCode, /flyTo\(\[lat, lng\], 16/);
});

test("Distance filtering stays anchored to the real Current Location", () => {
  const pageCode = stripComments(homePage);
  assert.match(pageCode, /matchesDistance\(\s*distanceFilter,\s*viewerPosition,/);
  assert.match(pageCode, /formatDistance\(distanceMeters\(viewerPosition/);
});

test("Bounded radius focuses the camera on the real Current Location, never on markers or Indonesia", () => {
  const mapCode = stripComments(homeMap);
  // The camera effect is driven by the active filter radius...
  assert.match(mapCode, /radiusMeters/);
  // ...centers on the REAL geolocation fix...
  assert.match(mapCode, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\]/);
  // ...derives zoom from the radius itself (radius-sized bounds box)...
  assert.match(mapCode, /getBoundsZoom\(bounds\)/);
  assert.match(mapCode, /latDelta = radiusMeters \/ 111_320/);
  // ...skips unbounded "10 km+" radius re-zoom and never steals the camera
  // from the user (interactions latch; the latch re-arms on a NEW radius
  // choice so the next bounded tab can refocus).
  assert.match(mapCode, /radiusMeters !== null/);
  assert.match(mapCode, /userInteractedRef\.current\) return/);
  // Home passes the locked filter's radius mapping as the camera source
  // (unbounded in curated mode).
  const pageCode = stripComments(homePage);
  assert.match(pageCode, /radiusMeters=\{curatedOnly \? null : DISTANCE_FILTER_RADIUS_M\[distanceFilter\]\}/);
});

test("Unbounded 10 km+ never re-zooms the camera from a radius refocus", () => {
  const mapCode = stripComments(homeMap);
  // Unbounded path: single focus on the actual location, no radius zoom.
  assert.match(mapCode, /if \(!cameraDecidedRef\.current\) \{\n\s*flyToUser\(map, viewerPosition\);\n\s*\}/);
});

// --- Round 2 hardening (PO request, 2026-09-25) ---

test("Map is single-world: no world-copy jump, wrapped tiles, or Indonesia layer on pan", () => {
  const mapCode = stripComments(homeMap);
  // Panning never repeats the world or shows wrapped copy tiles...
  assert.match(mapCode, /worldCopyJump: false/);
  assert.match(mapCode, /noWrap: true/);
  // ...and the single OSM tile layer is clamped to the single-world bounds.
  assert.match(mapCode, /bounds: \[\n\s*\[-85, -Infinity\],/);
  assert.match(mapCode, /maxBoundsViscosity: 1\.0/);
});

test("Exactly one tile layer exists for the map's whole lifetime", () => {
  const mapCode = stripComments(homeMap);
  // One L.tileLayer call, kept in a ref and explicitly removed in teardown —
  // no orphaned OSM layer can survive a remount, refresh, or drag.
  const tileLayerCalls = mapCode.match(/L\.tileLayer\(/g) ?? [];
  assert.equal(tileLayerCalls.length, 1, "exactly one L.tileLayer call");
  assert.match(mapCode, /tileLayerRef\.current = tileLayer/);
  assert.match(mapCode, /tileLayerRef\.current\?\.remove\(\)/);
  assert.match(mapCode, /tileLayerRef\.current = null/);
});

test("Zoom controls stay available and user zoom/pan latches are re-armed per filter", () => {
  const mapCode = stripComments(homeMap);
  // +/- controls remain a real Leaflet zoom control...
  assert.match(mapCode, /L\.control\.zoom\(\{ position: "topright" \}\)/);
  // ...and interactions are re-armed on a new radius choice so a bounded tab
  // can refocus after the user dragged on the previous one.
  assert.match(mapCode, /if \(radiusChanged\) userInteractedRef\.current = false/);
  assert.match(mapCode, /lastRadiusRef\.current = radiusMeters/);
});

test("Bounded radius refocuses the camera on every radius change (tab-switch regression)", () => {
  const mapCode = stripComments(homeMap);
  // The refocus is driven by radius change, not a one-shot latch...
  assert.match(mapCode, /const radiusChanged = lastRadiusRef\.current !== radiusMeters/);
  // ...re-arms the interaction latch for the new tab...
  assert.match(mapCode, /if \(radiusChanged\) userInteractedRef\.current = false/);
  // ...and still centers on the REAL geolocation fix with radius-derived zoom.
  assert.match(mapCode, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\]/);
  assert.match(mapCode, /getBoundsZoom\(bounds\)/);
  // Home passes the locked filter radius (or unbounded in curated mode).
  const pageCode = stripComments(homePage);
  assert.match(pageCode, /radiusMeters=\{curatedOnly \? null : DISTANCE_FILTER_RADIUS_M\[distanceFilter\]\}/);
});

test("Remount/refresh safety: container claim, full teardown, and size re-measure", () => {
  const mapCode = stripComments(homeMap);
  // Synchronous container claim before the async import (no double init).
  assert.match(mapCode, /container\.dataset\.singgahMap = "initializing"/);
  assert.match(mapCode, /if \(!container \|\| container\.dataset\.singgahMap\) return/);
  // Teardown removes listeners, every layer, and the map itself.
  assert.match(mapCode, /map\.off\(\)/);
  assert.match(mapCode, /map\.remove\(\)/);
  assert.match(mapCode, /markerLayerRef\.current\?\.remove\(\)/);
  assert.match(mapCode, /userLayerRef\.current\?\.remove\(\)/);
  assert.match(mapCode, /tileLayerRef\.current\?\.remove\(\)/);
  // Size re-measure after init + on resize (no stacked mobile tiles).
  assert.match(mapCode, /map\.invalidateSize\(\)/);
  assert.match(mapCode, /window\.addEventListener\("resize"/);
});
