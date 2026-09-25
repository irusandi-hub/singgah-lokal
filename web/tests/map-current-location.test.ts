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
  // No default Indonesia coordinate ever becomes the user position.
  const pageCode = stripComments(homePage);
  assert.doesNotMatch(pageCode, /lat:\s*-2\.5|lng:\s*118/);
});

test("Home Map shows a user marker from the real fix and centers on it", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /circleMarker\(\[viewerPosition\.lat, viewerPosition\.lng\]/);
  assert.match(mapCode, /Lokasi Anda/);
  assert.match(mapCode, /flyToUser\(map, viewerPosition\)/);
  // Overview center is viewport fallback only, never the user's position.
  assert.match(mapCode, /center: \[-2\.5, 118\]/);
});

test("Home Map provides a Lokasi Saya button that recenters on the real fix", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /Lokasi Saya/);
  assert.match(mapCode, /onRequestLocate/);
  assert.match(mapCode, /locatePendingRef\.current = true/);
  assert.match(mapCode, /flyToUser\(map, viewerPosition\)/);
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

test("Marker refresh and filter changes never steal the viewport from the user", () => {
  const mapCode = stripComments(homeMap);
  // A real user pan/zoom latches the camera against automatic moves...
  assert.match(mapCode, /userInteractedRef\.current = true/);
  // ...fitBounds is a one-shot initial overview...
  assert.match(mapCode, /!cameraDecidedRef\.current && !userInteractedRef\.current/);
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
  // ...centers on the REAL geolocation fix — never the overview point...
  assert.match(mapCode, /flyTo\(\[lat, viewerPosition\.lng\]/);
  // ...derives zoom from the radius itself (radius-sized bounds box)...
  assert.match(mapCode, /getBoundsZoom\(bounds\)/);
  assert.match(mapCode, /latDelta = radiusMeters \/ 111_320/);
  // ...skips unbounded "10 km+" and never steals the camera from the user.
  assert.match(mapCode, /radiusMeters === null \|\| !viewerPosition \|\| userInteractedRef\.current/);
  // Home passes the locked filter's radius mapping as the camera source.
  const pageCode = stripComments(homePage);
  assert.match(pageCode, /radiusMeters=\{DISTANCE_FILTER_RADIUS_M\[distanceFilter\]\}/);
});
