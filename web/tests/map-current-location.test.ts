import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMERA_PRESET_RADIUS_M,
  CURATED_CAMERA_RADIUS_M,
} from "../lib/live/ui";

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homePage = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
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
  // ...marker fitBounds NO LONGER EXISTS anywhere: the viewport is owned by
  // the real Current Location + the bounded radius preset only. Marker
  // refreshes and filter-driven marker rebuilds never move the camera
  // (map-coverage fix, 2026-09-30 — the old one-shot marker overview zoomed
  // to a world view whenever the demo marker set was spread out).
  assert.equal(mapCode.includes("fitBounds"), false, "no marker fitBounds at all");
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

test("Lokasi Saya: immediate recenter on the existing fix + fresh geolocation refinement", () => {
  const pageCode = stripComments(homePage);
  // ONE geolocation system: the shared handler serves the mount fix AND the
  // fresh refinement — no second watcher/implementation.
  assert.equal((pageCode.match(/getCurrentPosition\(/g) ?? []).length, 1, "exactly one getCurrentPosition call site");
  assert.match(pageCode, /useEffect\(\(\) => \{\n\s*requestViewerPosition\(\);\n\s*\}, \[requestViewerPosition\]\);/);
  // The press handler bumps the locate nonce IMMEDIATELY (locate-refresh
  // regression fix, 2026-09-30): a failed/denied fresh request can never
  // swallow the press — with a valid fix the recenter happens first.
  const pressStart = pageCode.indexOf("const handleLocatePress");
  const pressEnd = pageCode.indexOf("const liveByPlaceId");
  assert.ok(pressStart > 0 && pressEnd > pressStart, "press handler exists");
  const press = pageCode.slice(pressStart, pressEnd);
  assert.match(press, /setLocateNonce\(\(nonce\) => nonce \+ 1\);\s*requestViewerPosition\(\);/);
  // The fresh refinement commits the newest real coords, THEN bumps the
  // nonce again so the camera follows the newest fix — never a stale one.
  const handlerStart = pageCode.indexOf("const requestViewerPosition");
  const handler = pageCode.slice(handlerStart, pressStart);
  assert.match(handler, /navigator\.geolocation\.getCurrentPosition\(/);
  assert.match(
    handler,
    /setViewerPosition\(\{\s*lat: position\.coords\.latitude,\s*lng: position\.coords\.longitude,\s*accuracy: position\.coords\.accuracy,\s*\}\);\s*setLocateNonce\(\(nonce\) => nonce \+ 1\);/,
  );
  // Exactly one viewer-position write (the fresh fix itself — no fallback).
  assert.equal((handler.match(/setViewerPosition\(/g) ?? []).length, 1);
  // Denial/failure stays silent: no default location, no camera mutation.
  assert.match(handler, /=> undefined,\s*\{\s*timeout: 8000\s*\}/);
});

test("Locate failure matrix: existing fix recentres, no fix never invents one", () => {
  const pageCode = stripComments(homePage);
  // EXISTING viewerPosition + failed fresh geolocation: the immediate nonce
  // bump still recentres to the existing fix (the regression fixed here).
  const press = pageCode.slice(pageCode.indexOf("const handleLocatePress"), pageCode.indexOf("const liveByPlaceId"));
  assert.match(press, /setLocateNonce\(\(nonce\) => nonce \+ 1\);/);
  // NO existing position + failed geolocation: no viewerPosition write
  // anywhere outside the geolocation success callback — no fake position,
  // no camera move to an invented point (the map-level pending latch just
  // waits for the first real fix).
  const writes = pageCode.match(/setViewerPosition\(/g) ?? [];
  assert.equal(writes.length, 1, "viewerPosition is written only by the fresh-fix success callback");
  assert.match(pageCode, /lat: position\.coords\.latitude/);
  // The ACTIVE radius stays authoritative on every locate flight (map side).
  const mapCode = stripComments(homeMap);
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, cameraRadiusMeters, flyToUser, radiusZoom]);"),
  );
  assert.match(locateEffect, /radiusZoom\(map, viewerPosition, cameraRadiusMeters\)/);
  assert.match(locateEffect, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\], Math\.max\(2, zoom\)/);
  assert.doesNotMatch(locateEffect, /Math\.max\(map\.getZoom\(\)/);
  assert.doesNotMatch(locateEffect, /fitBounds/);
});

test("Every distance tab is a deterministic camera preset through ONE mechanism", () => {
  const pageCode = stripComments(homePage);
  const mapCode = stripComments(homeMap);
  // One preset mechanism: the camera frame covers a preset radius around the
  // REAL Current Location via radiusZoom — no unbounded camera path is left.
  assert.match(mapCode, /cameraRadiusMeters !== null/);
  assert.match(mapCode, /radiusZoom\(map, viewerPosition, cameraRadiusMeters\)/);
  assert.match(mapCode, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\], Math\.max\(2, zoom\)/);
  // Home feeds every mode into that ONE camera prop: distance tabs through
  // the ordered preset mapping, curated through its 50 km value.
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
  // The zoom is derived from the preset radius, never from the current zoom:
  // no Math.max(map.getZoom()...) preset flight survives.
  assert.doesNotMatch(mapCode, /Math\.max\(map\.getZoom\(\), \d+\)[^\n]*preset/i);
  // flyToUser (the zoom-preserving focus) appears exactly TWICE now, both on
  // the NULL-preset paths only: the one-shot focus fallback and the null-
  // preset "Lokasi Saya" recenter (no Home mode reaches either — every mode
  // passes a preset). With a preset active, BOTH the preset anchor AND the
  // "Lokasi Saya" recenter fly through the canonical radiusZoom mechanism
  // (locate-preset fix, 2026-09-30) — never Math.max(getZoom(), 15).
  const flyToUserCalls = mapCode.match(/flyToUser\(map, viewerPosition\)/g) ?? [];
  assert.equal(flyToUserCalls.length, 2, "null-preset focus + null-preset recenter only");
});

test("Lokasi Saya keeps the ACTIVE preset: recenter flies through radiusZoom, never an arbitrary zoom", () => {
  const mapCode = stripComments(homeMap);
  // The locate effect branches on the active preset...
  assert.match(mapCode, /locatePendingRef\.current = false;\n\s*if \(cameraRadiusMeters !== null\) \{/);
  // ...and re-derives the zoom from cameraRadiusMeters through the ONE
  // canonical radiusZoom mechanism, centering the newest real fix —
  // 1 km stays 1 km, 5 km stays 5 km, 10 km+ stays 10 km+, Tempat Pilihan
  // stays the 50 km curated radius (locate-preset fix, 2026-09-30).
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, cameraRadiusMeters, flyToUser, radiusZoom]);"),
  );
  assert.match(locateEffect, /radiusZoom\(map, viewerPosition, cameraRadiusMeters\)/);
  assert.match(locateEffect, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\], Math\.max\(2, zoom\)/);
  // No arbitrary zoom bump, no marker fitBounds, no mode/filter mutation.
  assert.doesNotMatch(locateEffect, /Math\.max\(map\.getZoom\(\)/);
  assert.doesNotMatch(locateEffect, /fitBounds/);
  assert.doesNotMatch(locateEffect, /setCuratedOnly|setDistanceFilter|curatedOnly\s*=/);
  // The zoom-preserving focus remains ONLY on the null-preset paths
  // (one-shot fallback + null-preset locate recenter).
  const flyToUserCalls = mapCode.match(/flyToUser\(map, viewerPosition\)/g) ?? [];
  assert.equal(flyToUserCalls.length, 2, "null-preset focus + null-preset recenter only");
});

// --- Camera preset ordering (PO, 2026-09-29) ---

test("Camera preset radii are strictly ordered: 1 km < 5 km < 10 km+ < curated 50 km", () => {
  // The preset table is the single source of the ordering...
  assert.deepEqual(CAMERA_PRESET_RADIUS_M, { "1 km": 1_000, "5 km": 5_000, "10 km+": 12_000 });
  assert.equal(CURATED_CAMERA_RADIUS_M, 50_000);
  // ...and the ordering is locked MATHEMATICALLY: at a fixed center the
  // pixel footprint of the radius box scales linearly with the radius, so
  // the derived zoom differs by exactly log2(ratio) — INDEPENDENT of the
  // current zoom, the viewport size, or the latitude. Each adjacent ratio
  // is > 2, i.e. every step zooms out by MORE than one full level, which
  // also keeps the order strict after Leaflet's zoomSnap (0.25) rounding:
  // adjacent real zooms can only floor to the same snap bucket when they
  // are < 1 level apart — impossible at these ratios.
  const orderings: [string, string, number, number][] = [
    ["1 km", "5 km", CAMERA_PRESET_RADIUS_M["1 km"], CAMERA_PRESET_RADIUS_M["5 km"]],
    ["5 km", "10 km+", CAMERA_PRESET_RADIUS_M["5 km"], CAMERA_PRESET_RADIUS_M["10 km+"]],
    ["10 km+", "curated", CAMERA_PRESET_RADIUS_M["10 km+"], CURATED_CAMERA_RADIUS_M],
  ];
  for (const [narrow, wide, narrowR, wideR] of orderings) {
    const ratio = wideR / narrowR;
    assert.ok(ratio > 2, `${wide} (${wideR}) must cover more than 2× ${narrow} (${narrowR})`);
    assert.ok(Math.log2(ratio) > 1, `${wide} must zoom out more than one full level vs ${narrow}`);
  }
});

test("Bounded radius focuses the camera on the real Current Location, never on markers or Indonesia", () => {
  const mapCode = stripComments(homeMap);
  // The camera effect is driven by the preset radius...
  assert.match(mapCode, /cameraRadiusMeters/);
  // ...centers on the REAL geolocation fix...
  assert.match(mapCode, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\]/);
  // ...derives zoom from the radius itself (radius-sized bounds box)...
  assert.match(mapCode, /getBoundsZoom\(bounds\)/);
  assert.match(mapCode, /latDelta = radiusMeters \/ 111_320/);
  // ...never steals the camera from the user (interactions latch; the latch
  // re-arms on a NEW preset choice so the next tab can refocus).
  assert.match(mapCode, /userInteractedRef\.current\) return/);
  // Home passes ONE camera preset mapping for every mode (distance tabs or
  // curated 50 km).
  const pageCode = stripComments(homePage);
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
});

test("No-preset fallback keeps the one-shot unbounded focus; it is not a distance tab", () => {
  const mapCode = stripComments(homeMap);
  // The null-preset fallback exists ONLY for safety (no Home mode reaches
  // it) and stays a one-shot focus on the actual location, never a radius
  // re-zoom and never a marker fit.
  assert.match(mapCode, /if \(!autoFocusedRef\.current\) \{\n\s*autoFocusedRef\.current = true;\n\s*flyToUser\(map, viewerPosition\);\n\s*\}/);
});

test("Camera is ALWAYS bounded: no filter/tab ever fits the whole marker set (map coverage)", () => {
  const mapCode = stripComments(homeMap);
  const pageCode = stripComments(homePage);
  // Every camera flight centers the REAL Current Location... TWO preset
  // flights exist (locate-preset fix, 2026-09-30): the preset anchor and the
  // "Lokasi Saya" recenter — BOTH derive zoom from the active preset radius
  // and BOTH center the real fix; neither ever fits markers.
  const flights = mapCode.match(/map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\]/g) ?? [];
  assert.equal(flights.length, 2, "preset anchor + preset locate recenter, both on the real fix");
  // ...whose zoom is derived from the preset radius box (bounded), and no
  // world/country fallback view is invented for the no-fix case.
  assert.match(mapCode, /map\.fitWorld\(\)/);
  assert.equal(pageCode.includes("fitBounds"), false);
  // A chosen tab still refocuses to its own preset radius: the anchor effect
  // re-derives zoom from cameraRadiusMeters on EVERY radius change.
  assert.match(mapCode, /const radiusChanged = lastRadiusRef\.current !== cameraRadiusMeters/);
});

// --- Round 2 hardening (PO request, 2026-09-25) ---

test("Map is single-world: no world-copy jump, wrapped tiles, or Indonesia layer on pan", () => {
  const mapCode = stripComments(homeMap);
  // Panning never repeats the world or shows wrapped copy tiles...
  assert.match(mapCode, /worldCopyJump: false/);
  assert.match(mapCode, /noWrap: true/);
  // ...and the single OSM tile layer is clamped to the single-world bounds.
  assert.match(mapCode, /bounds: \[\n\s*\[-85, -180\],/);
  assert.match(mapCode, /maxBoundsViscosity: 1\.0/);
});

test("Pan clamp uses FINITE maxBounds — ±Infinity longitudes never reach Leaflet (drag-escape root cause)", () => {
  const mapCode = stripComments(homeMap);
  // Leaflet projects ±180 lng to ±Infinity pixels; maxBounds with ±Infinity
  // made the drag-limit math NaN/Infinity so the pane was NEVER clamped and
  // one strong drag slid the whole map pane out of its frame.
  assert.match(mapCode, /maxBounds: \[\n\s*\[-85, -180\],\n\s*\[85, 180\],\n\s*\],/);
  // No ±Infinity survives anywhere in the map options or tile bounds.
  assert.equal(mapCode.includes("Infinity"), false, "no Infinity in map/tile bounds");
  // Viscosity 1.0 hard-clamps the pane at the world edge (drag stays ON).
  assert.match(mapCode, /maxBoundsViscosity: 1\.0/);
  // Dragging itself is never disabled (the clamp is the real mechanism).
  assert.equal(mapCode.includes("dragging: false"), false);
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

test("Zoom controls stay available and user zoom/pan latches are re-armed per preset", () => {
  const mapCode = stripComments(homeMap);
  // +/- controls remain a real Leaflet zoom control...
  assert.match(mapCode, /L\.control\.zoom\(\{ position: "topright" \}\)/);
  // ...and interactions are re-armed on a new preset choice so a new tab can
  // refocus after the user dragged on the previous one.
  assert.match(mapCode, /if \(radiusChanged\) userInteractedRef\.current = false/);
  assert.match(mapCode, /lastRadiusRef\.current = cameraRadiusMeters/);
});

test("A new preset refocuses deterministically; manual pan/zoom wins between choices", () => {
  const mapCode = stripComments(homeMap);
  // The refocus is driven by the preset change, not a one-shot latch...
  assert.match(mapCode, /const radiusChanged = lastRadiusRef\.current !== cameraRadiusMeters/);
  // ...re-arms the interaction latch for the new tab...
  assert.match(mapCode, /if \(radiusChanged\) userInteractedRef\.current = false/);
  // ...and still centers on the REAL geolocation fix with preset-derived zoom.
  assert.match(mapCode, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\]/);
  assert.match(mapCode, /getBoundsZoom\(bounds\)/);
  // Home passes the ONE preset mapping (curated 50 km or the tab preset).
  const pageCode = stripComments(homePage);
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
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

// --- "Tempat Pilihan" curated mode (PO, 2026-09-29) ---

test("Curated mode centers the camera on Current Location with 50 km coverage", () => {
  const pageCode = stripComments(homePage);
  const mapCode = stripComments(homeMap);
  // Home passes the 50 km curated camera radius ONLY while curated is on;
  // normal modes keep the distance-tab preset mapping untouched.
  assert.match(pageCode, /CURATED_CAMERA_RADIUS_M/);
  assert.match(pageCode, /cameraRadiusMeters=\{\n?\s*curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]\n?\s*\}/);
  // The map flies to the REAL fix with radius-derived zoom — no fallback
  // coordinate is ever introduced (the no-fake-position test above still
  // applies to every setViewerPosition/flyTo call).
  assert.match(mapCode, /cameraRadiusMeters !== null/);
  assert.match(mapCode, /radiusZoom\(map, viewerPosition, cameraRadiusMeters\)/);
  assert.match(mapCode, /map\.flyTo\(\[viewerPosition\.lat, viewerPosition\.lng\], Math\.max\(2, zoom\)/);
});

test("Curated camera radius never filters the curated Place set", () => {
  const pageCode = stripComments(homePage);
  // The curated layer narrows ONLY by the canonical curated ids — the 50 km
  // value appears ONLY as the camera prop, never in the filter pipeline
  // (matchesDistance / distanceMeters calls stay radius-filter only). The
  // curated set is an intersection with the curated ids: an empty selection
  // yields an empty layer, never the full search-filtered set and never a
  // radius-filtered one.
  assert.match(pageCode, /if \(curatedOnly\) \{/);
  assert.match(
    pageCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
  assert.doesNotMatch(pageCode, /curatedIdSet\.size > 0/);
  const cameraUses = pageCode.match(/CURATED_CAMERA_RADIUS_M/g) ?? [];
  assert.equal(cameraUses.length, 2, "import + camera prop only — never a filter input");
  assert.doesNotMatch(pageCode, /matchesDistance\([^)]*CURATED/);
  assert.doesNotMatch(pageCode, /distanceMeters\([^)]*CURATED/);
});

// --- Unified marker system (PO, 2026-09-29): base pin + treatments ---

test("ONE base Place marker: compact teardrop, no emoji, treatments not different models", () => {
  const mapCode = stripComments(homeMap);
  // One marker builder for every Place: the SAME teardrop shape in all
  // modes — only the fill color (and the curated accent) differ.
  assert.match(mapCode, /const pinColor = curatedMarkers \? BRAND_SECONDARY : BRAND_BROWN/);
  assert.match(mapCode, /border-radius:9999px 9999px 9999px 0/);
  // Exactly one Place-pin builder: no second model, no emoji glyphs.
  assert.equal((mapCode.match(/const placePin = /g) ?? []).length, 1);
  assert.doesNotMatch(mapCode, /📍/);
  // Compact: 28×36 px pin, 28 px head — light on a dense mobile map.
  assert.match(mapCode, /width:28px;height:36px/);
  // "Tempat Pilihan" is a treatment of the base: secondary green fill + ✦
  // accent on the SAME shape, never a different object.
  assert.match(mapCode, /background:\$\{pinColor\}/);
  assert.match(mapCode, /BRAND_SECONDARY/);
  assert.match(mapCode, /✦/);
  // Click/navigation flow unchanged: every pin routes to /places/[id].
  assert.match(mapCode, /router\.push\(`\/places\/\$\{place\.id\}`\)/);
});

test("Declutter: Place names appear only on hover/focus/selection, never as always-on labels", () => {
  const mapCode = stripComments(homeMap);
  // The name tooltip is bound unconditionally (hover/focus/selection ONLY —
  // Leaflet does not render it persistently), with NO always-on name chip.
  assert.match(mapCode, /marker\.bindTooltip\(escapeHtml\(place\.name\)/);
  assert.doesNotMatch(mapCode, /max-width:180px[^\n]*font-weight:700[^\n]*\$\{escapeHtml\(place\.name\)\}/);
  // No curated-only label branch is left (decluttering covers all modes).
  assert.doesNotMatch(mapCode, /if \(curatedMarkers\) \{\n\s*marker\.bindTooltip/);
  // The LIVE pin has no name label either — its identity is the LIVE chip.
  assert.doesNotMatch(mapCode, /bindTooltip\(liveTitle/);
});

test("LIVE treatment: same teardrop language, unmistakably live-red, still compact", () => {
  const mapCode = stripComments(homeMap);
  // The LIVE pin keeps the teardrop silhouette (one visual language)...
  const liveIdx = mapCode.indexOf("Live sekarang di");
  const placeIdx = mapCode.indexOf("const placePin = ");
  assert.ok(liveIdx >= 0 && placeIdx > liveIdx, "LIVE pin shares the Place pin language");
  assert.match(mapCode, /border-radius:9999px 9999px 9999px 0/);
  // ...in the live red with a white pulsing core and a small LIVE chip...
  assert.match(mapCode, /background:\$\{BRAND_LIVE\}/);
  assert.match(mapCode, /singgah-live-pulse/);
  // ...compact (30 px head + 9 px chip, total ≈38 px tall), not a 48 px badge.
  assert.match(mapCode, /width:30px;height:38px/);
  assert.doesNotMatch(mapCode, /height:48px;width:48px/);
  // Global stylesheet carries the pulse animation + reduced-motion opt-out.
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globals, /@keyframes singgah-live-pulse/);
  assert.match(globals, /prefers-reduced-motion/);
  // Accessibility: every marker keeps a correct aria-label; LIVE keeps its
  // top z-priority over Place pins and the /live/[sessionId] flow.
  assert.match(mapCode, /aria-label="Live sekarang di \$\{escapeHtml\(place\.name\)\} — lihat proses produksi"/);
  assert.match(mapCode, /zIndexOffset: 1000/);
  assert.match(mapCode, /router\.push\(`\/live\/\$\{live\.sessionId\}`\)/);
  const liveOffset = mapCode.indexOf("zIndexOffset: 1000");
  const placeOffset = mapCode.indexOf("zIndexOffset: live ? 0 : 500");
  assert.ok(liveOffset >= 0 && placeOffset > liveOffset);
});

test("Every marker carries an accessible aria-label", () => {
  const mapCode = stripComments(homeMap);
  // Place pins (normal + curated) announce the Place; LIVE pins announce
  // the live status and flow; the user marker keeps its own tooltip.
  const placePinAria = (mapCode.match(/aria-label="Lihat \$\{escapeHtml\(place\.name\)\}"/g) ?? []).length;
  assert.equal(placePinAria, 1, "exactly one Place-pin aria-label builder");
  assert.match(mapCode, /aria-label="Live sekarang di/);
  assert.match(mapCode, /Lokasi Anda/);
});

test("Current Location marker is visually distinct from every Place pin", () => {
  const mapCode = stripComments(homeMap);
  // A deep-green disc with a white core (Place pins are teardrops — never
  // discs), no click behavior, and the Lokasi Saya tooltip/label stays.
  assert.match(mapCode, /fillColor: BRAND_PIN/);
  assert.match(mapCode, /fillColor: "#ffffff"/);
  assert.match(mapCode, /Lokasi Anda/);
  // Accuracy circle is preserved.
  assert.match(mapCode, /radius: accuracy/);
});
