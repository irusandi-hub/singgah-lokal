import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CAMERA_PRESET_RADIUS_M, CURATED_CAMERA_RADIUS_M } from "../lib/live/ui";

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
  assert.match(mapCode, /focusUser\(map, anchor\)/);
});

test("Home Map provides a Lokasi Saya button that recenters on the real fix", () => {
  const mapCode = stripComments(homeMap);
  assert.match(mapCode, /Lokasi Saya/);
  assert.match(mapCode, /onRequestLocate/);
  assert.match(mapCode, /locatePendingRef\.current = true/);
  assert.match(mapCode, /focusUser\(map, anchor\)/);
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
  // ...the camera is NEVER fitted to the markers. SUPERSEDED (product decision,
  // 2026-10-03): the 2026-09-30 rule "no fitBounds anywhere at all" is replaced
  // by a STRICTLY NARROWER one — a fit now exists, but it reads a SEPARATE
  // bounds dataset that is NOT the marker set (`fitPlaces` / `searchFitPlaces`),
  // it fires ONLY on an explicit refocus trigger (a nonce), and it is never
  // reachable from a marker refresh or a filter-driven marker rebuild. The old
  // one-shot MARKER overview (which zoomed to a world view on a spread marker
  // set) still does not exist in any form.
  const fitBoundsCalls = mapCode.match(/map\.fitBounds\(/g) ?? [];
  assert.equal(fitBoundsCalls.length, 1, "one fit, and it is inside the shared auto-fit mechanism");
  // The fit's dataset is read from a REF, never from the narrowed `places`
  // prop — that is what keeps viewport/marker/camera from becoming circular.
  assert.match(mapCode, /const points = collectGeoPoints\(candidatePlaces\)/);
  assert.doesNotMatch(mapCode, /fitBounds\(L\.latLngBounds\(corners\)[\s\S]{0,200}collectGeoPoints\(places\)/);
  assert.match(mapCode, /fitPlacesRef = useRef<HomeMapPlace\[\]>\(fitPlaces\)/);
  assert.match(mapCode, /searchFitPlacesRef = useRef<HomeMapPlace\[\]>\(searchFitPlaces\)/);
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

test("Distance LABELS stay anchored to the real Current Location; the tabs never gate the list", () => {
  const pageCode = stripComments(homePage);
  // SUPERSEDED (product decision, 2026-10-01): the 1 km / 5 km / 10 km+ tabs
  // are CAMERA frames only — the visible Leaflet viewport is the geographic
  // coverage source for the rows, so no radius gate may remain in Home.
  assert.equal(pageCode.includes("matchesDistance"), false);
  // The distance LABEL on a card still comes from a REAL origin + canonical
  // Place coordinates, never from an invented point. The origin is the ACTIVE
  // search center (bug fix 2026-10-02): the searched city while one is active,
  // otherwise the real fix — so a Place admitted by the Riyadh coverage is no
  // longer labelled with its distance from Dammam.
  assert.match(pageCode, /formatDistance\(distanceMeters\(activeCenter/);
  assert.doesNotMatch(pageCode, /formatDistance\(distanceMeters\(viewerPosition/);
});

test("the camera anchor falls back to the REAL fix, so the default behavior is unchanged", () => {
  const mapCode = stripComments(homeMap);
  // Bug fix 2026-10-02: the radius preset used to hardcode `viewerPosition`,
  // so choosing a different radius during a city search discarded the searched
  // center. It now resolves ONE anchor — the searched city when active,
  // otherwise the real fix — which preserves this suite's whole contract in
  // the default case (no city searched) while fixing the city case.
  assert.match(mapCode, /const anchor = cameraCenter \?\? viewerPosition;/);
  // The preset effect still requires a real, usable origin: no fix and no
  // searched city means no camera move at all, never an invented point.
  assert.match(mapCode, /const anchor = cameraCenter \?\? viewerPosition;\s*\n\s*if \(!ready \|\| !map \|\| !anchor\) return;/);
  // The anchor is re-keyed so a new center re-arms the effect.
  assert.match(mapCode, /const cameraCenterKey = cameraCenter \? `\$\{cameraCenter\.lat\},\$\{cameraCenter\.lng\}` : "";/);
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
  // The locate recenter centers on the newest REAL fix and PRESERVES the
  // current close zoom (product decision, 2026-10-01: no forced zoom-out, no
  // wide radius), eased in with ONE short transition and the pin pulse as the
  // visual feedback.
  const mapCode = stripComments(homeMap);
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse]);"),
  );
  assert.match(locateEffect, /const center: \[number, number\] = \[viewerPosition\.lat, viewerPosition\.lng\]/);
  assert.match(locateEffect, /const targetZoom = Math\.max\(map\.getZoom\(\), LOCATE_MIN_ZOOM\)/);
  assert.doesNotMatch(locateEffect, /radiusZoom/);
  assert.doesNotMatch(locateEffect, /fitBounds/);
});

test("Every distance tab is a deterministic camera preset through ONE mechanism", () => {
  const pageCode = stripComments(homePage);
  const mapCode = stripComments(homeMap);
  // One preset mechanism: the camera frame covers a preset radius around the
  // REAL Current Location via radiusZoom — no unbounded camera path is left.
  assert.match(mapCode, /cameraRadiusMeters !== null/);
  assert.match(mapCode, /radiusZoom\(map, anchor, cameraRadiusMeters\)/);
  assert.match(mapCode, /map\.setView\(\[anchor\.lat, anchor\.lng\], Math\.max\(2, zoom\), \{ animate: false \}\)/);
  // Home feeds every mode into that ONE camera prop: distance tabs through
  // the ordered preset mapping, curated through its 10 km value.
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
  // The zoom is derived from the preset radius, never from the current zoom:
  // no Math.max(map.getZoom()...) preset flight survives.
  assert.doesNotMatch(mapCode, /Math\.max\(map\.getZoom\(\), \d+\)[^\n]*preset/i);
  // focusUser (the instant zoom-preserving fallback focus) appears exactly
  // ONCE, on the NULL-preset path only: the one-shot anchor fallback (no
  // Home mode reaches it). Every real camera move — the preset anchor and the
  // "Lokasi Saya" 10 km recenter — goes through the canonical radiusZoom
  // mechanism, never Math.max(getZoom(), 15).
  const focusUserCalls = mapCode.match(/focusUser\(map, anchor\)/g) ?? [];
  assert.equal(focusUserCalls.length, 1, "null-preset anchor fallback only");
});

test("Lokasi Saya centers the real fix on the CURRENT zoom — it never widens the frame", () => {
  const mapCode = stripComments(homeMap);
  // It centers on the newest REAL fix and keeps the close zoom the viewer is
  // already on (Math.max of the CURRENT zoom: it can raise a farther zoom to
  // the close floor, but it can never zoom OUT), instead of deriving a zoom
  // from a fixed wide radius (product decision, 2026-10-01).
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse]);"),
  );
  assert.match(locateEffect, /locatePendingRef\.current = false;/);
  assert.match(locateEffect, /const center: \[number, number\] = \[viewerPosition\.lat, viewerPosition\.lng\]/);
  assert.match(locateEffect, /const targetZoom = Math\.max\(map\.getZoom\(\), LOCATE_MIN_ZOOM\)/);
  // No radius-derived zoom, no marker fitBounds, no mode/filter mutation, and
  // NO fallback coordinate in the locate path.
  assert.doesNotMatch(locateEffect, /radiusZoom/);
  assert.doesNotMatch(locateEffect, /fitBounds/);
  assert.doesNotMatch(locateEffect, /setCuratedOnly|setDistanceFilter|curatedOnly\s*=/);
  assert.doesNotMatch(locateEffect, /cameraRadiusMeters/);
  // CORRECTION (2026-10-03): the frame this press produces is LATCHED, so the
  // fresh geolocation fix that lands right after it can no longer re-frame the
  // map to a radius preset the user never chose — which is what used to make
  // "Lokasi Saya" appear to jump a moment after the press. Only a new explicit
  // request (a tab, "Tempat Pilihan", or another press) releases it.
  assert.match(locateEffect, /userInteractedRef\.current = true;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // The floor is a CLOSE zoom, never a wide one, and it is the same value the
  // zoom-preserving fallback focus uses.
  const floor = Number(/const LOCATE_MIN_ZOOM = (\d+)/.exec(homeMap)?.[1] ?? "0");
  assert.ok(floor >= 14, `locate must focus close (got zoom ${floor})`);
  assert.match(mapCode, /map\.setView\(\[position\.lat, position\.lng\], Math\.max\(map\.getZoom\(\), \d+\)/);
  // The preset anchor is the ONLY place the selected preset radius reaches the
  // camera — the 1/5/10 km tabs AND the 10 km curated preset are untouched.
  const anchorEffect = mapCode.slice(
    mapCode.indexOf("const radiusChanged = lastRadiusRef.current !== cameraRadiusMeters"),
    mapCode.indexOf("}, [ready, viewerPositionKey, cameraCenterKey, cameraRadiusMeters, viewerPosition, cameraCenter, fitNonce, cameraRequestNonce, focusUser, radiusZoom, fitCamera, pulsePinOnPresetChange, triggerLocatePulse]);"),
  );
  assert.match(anchorEffect, /radiusZoom\(map, anchor, cameraRadiusMeters\)/);
  assert.match(anchorEffect, /map\.setView\(\[anchor\.lat, anchor\.lng\], Math\.max\(2, zoom\), \{ animate: false \}\)/);
  // The zoom-preserving focus remains ONLY on the null-preset anchor
  // fallback (one call site).
  const focusUserCalls = mapCode.match(/focusUser\(map, anchor\)/g) ?? [];
  assert.equal(focusUserCalls.length, 1, "null-preset anchor fallback only");
});

test("Lokasi Saya camera transition is SHORT and smooth, and respects reduced motion", () => {
  const mapCode = stripComments(homeMap);
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse]);"),
  );
  // ONE transition, and it is NOT the old instant jump: the camera eases to
  // the 10 km frame instead of teleporting...
  assert.match(locateEffect, /map\.flyTo\(center, targetZoom, \{/);
  assert.match(locateEffect, /duration: LOCATE_TRANSITION_MS \/ 1000/);
  assert.match(locateEffect, /easeLinearity: 0\.4/);
  // ...and the duration is BOUNDED so it can never become a long fly-through
  // or feel like loading. Executable: the real value must sit between a
  // clearly-perceptible 150 ms and a hard 600 ms ceiling.
  const declared = Number(/const LOCATE_TRANSITION_MS = (\d+)/.exec(homeMap)?.[1] ?? "0");
  assert.ok(declared >= 150, `locate transition must be perceptible (got ${declared} ms)`);
  assert.ok(declared <= 600, `locate transition must stay short (got ${declared} ms)`);
  const pulseWindow = Number(/const LOCATE_PULSE_MS = (\d+)/.exec(homeMap)?.[1] ?? "0");
  assert.ok(pulseWindow >= declared, "the pin pulse must outlast the camera transition");
  // Reduced motion wins: the SAME action then applies instantly (no
  // transition at all) — it is never skipped, only unanimated.
  assert.match(mapCode, /function prefersReducedMotion\(\): boolean \{[\s\S]*prefers-reduced-motion: reduce/);
  assert.match(locateEffect, /if \(prefersReducedMotion\(\)\) \{\n\s*map\.setView\(center, targetZoom, \{ animate: false \}\);\n\s*return;\n\s*\}/);
  // The transition exists ONLY on the locate path: choosing a tab keeps the
  // instant preset apply.
  const anchorEffect = mapCode.slice(
    mapCode.indexOf("const radiusChanged = lastRadiusRef.current !== cameraRadiusMeters"),
    mapCode.indexOf("}, [ready, viewerPositionKey, cameraCenterKey, cameraRadiusMeters, viewerPosition, cameraCenter, fitNonce, cameraRequestNonce, focusUser, radiusZoom, fitCamera, pulsePinOnPresetChange, triggerLocatePulse]);"),
  );
  assert.doesNotMatch(anchorEffect, /flyTo|duration/);
  assert.equal((mapCode.match(/map\.flyTo\(/g) ?? []).length, 1, "exactly one animated move — the locate recenter");
});

test("The curated and 10 km tab camera coverages stay exactly 10,000 m; no coverage constant survives", () => {
  // Executable proof of the REMAINING Home camera coverages (PO decision,
  // 2026-09-30): the "10 km+" tab and the curated preset frame the SAME 10 km
  // around the real fix. The narrower tabs stay narrower.
  //
  // SUPERSEDED (product decision, 2026-10-01): the dedicated "Lokasi Saya"
  // coverage (CURRENT_LOCATION_CAMERA_RADIUS_M) and the curated MAP-DATASET
  // coverage (CURATED_MAP_COVERAGE_RADIUS_M) no longer exist at all — the
  // locate recenter preserves the current zoom, and the map/list coverage is
  // the REAL Leaflet viewport. Neither symbol may come back as a fixed radius.
  assert.equal(CAMERA_PRESET_RADIUS_M["10 km+"], 10_000);
  assert.equal(CURATED_CAMERA_RADIUS_M, 10_000);
  // The distance tabs stay strictly ordered 1 km < 5 km < 10 km, so the
  // derived zoom is strictly ordered the opposite way and can never collapse
  // two tabs into the same frame (radiusZoom zoom delta = log2(ratio)).
  assert.ok(CAMERA_PRESET_RADIUS_M["1 km"] < CAMERA_PRESET_RADIUS_M["5 km"]);
  assert.ok(CAMERA_PRESET_RADIUS_M["5 km"] < CAMERA_PRESET_RADIUS_M["10 km+"]);
  assert.ok(Math.log2(CAMERA_PRESET_RADIUS_M["5 km"] / CAMERA_PRESET_RADIUS_M["1 km"]) > 1);
  // 5 km -> 10 km is exactly one full zoom level, so the order stays strict
  // even after Leaflet's zoomSnap (0.25) rounding.
  assert.ok(Math.log2(CAMERA_PRESET_RADIUS_M["10 km+"] / CAMERA_PRESET_RADIUS_M["5 km"]) >= 1);
  // The values reach ONLY their camera paths: neither retired coverage symbol
  // exists in the library or in either component.
  const uiSource = readFileSync(new URL("../lib/live/ui.ts", import.meta.url), "utf8");
  const pageCode = stripComments(homePage);
  const mapCode = stripComments(homeMap);
  assert.equal(uiSource.includes("CURRENT_LOCATION_CAMERA_RADIUS_M"), false, "the locate coverage constant is retired");
  assert.equal(uiSource.includes("CURATED_MAP_COVERAGE_RADIUS_M"), false, "the curated map coverage constant is retired");
  assert.equal(pageCode.includes("CURRENT_LOCATION_CAMERA_RADIUS_M"), false, "Home discovery never reads a locate coverage");
  assert.equal(pageCode.includes("CURATED_MAP_COVERAGE_RADIUS_M"), false, "Home discovery never reads a map coverage radius");
  assert.equal(mapCode.includes("CAMERA_PRESET_RADIUS_M"), false, "the map takes its tab presets through the camera prop only");
  assert.equal(mapCode.includes("CURRENT_LOCATION_CAMERA_RADIUS_M"), false, "the map recenter derives no radius");
  assert.equal(mapCode.includes("CURATED_MAP_COVERAGE_RADIUS_M"), false, "the map never filters the dataset by a fixed radius");
  const curatedCameraUses = pageCode.match(/CURATED_CAMERA_RADIUS_M/g) ?? [];
  // 3 uses: import + the camera prop + the MOCKUP coverage/scale LABEL that
  // mirrors the active radius (display only — never a filter input).
  assert.equal(curatedCameraUses.length, 3, "import + camera prop + display label only");
  // The locate path stays a SEPARATE mechanism: it never reads the preset
  // radius of the selected tab.
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse]);"),
  );
  assert.doesNotMatch(locateEffect, /cameraRadiusMeters|CURATED_CAMERA_RADIUS_M/);
});

// --- Camera preset ordering (PO, 2026-09-29) ---

test("Distance-tab camera radii stay strictly ordered: 1 km < 5 km < 10 km", () => {
  // The preset table is the single source of the ordering...
  assert.deepEqual(CAMERA_PRESET_RADIUS_M, { "1 km": 1_000, "5 km": 5_000, "10 km+": 10_000 });
  // "Tempat Pilihan" deliberately shares the widest 10 km frame with the
  // "10 km+" tab, so it is NOT part of this ordering (same radius => same
  // derived zoom by construction). "Lokasi Saya" is no longer a preset at all:
  // it preserves the current zoom (product decision, 2026-10-01).
  assert.equal(CURATED_CAMERA_RADIUS_M, CAMERA_PRESET_RADIUS_M["10 km+"]);
  // ...and the tab ordering is locked MATHEMATICALLY: at a fixed center the
  // pixel footprint of the radius box scales linearly with the radius, so
  // the derived zoom differs by exactly log2(ratio) — INDEPENDENT of the
  // current zoom, the viewport size, or the latitude. Every adjacent ratio is
  // >= 2, i.e. every step zooms out by AT LEAST one full level, which keeps
  // the order strict after Leaflet's zoomSnap (0.25) rounding: adjacent real
  // zooms can only floor to the same snap bucket when they are < 1 level
  // apart — impossible at these ratios.
  const orderings: [string, string, number, number][] = [
    ["1 km", "5 km", CAMERA_PRESET_RADIUS_M["1 km"], CAMERA_PRESET_RADIUS_M["5 km"]],
    ["5 km", "10 km+", CAMERA_PRESET_RADIUS_M["5 km"], CAMERA_PRESET_RADIUS_M["10 km+"]],
  ];
  for (const [narrow, wide, narrowR, wideR] of orderings) {
    const ratio = wideR / narrowR;
    assert.ok(ratio >= 2, `${wide} (${wideR}) must cover at least 2× ${narrow} (${narrowR})`);
    assert.ok(Math.log2(ratio) >= 1, `${wide} must zoom out at least one full level vs ${narrow}`);
  }
});

test("Bounded radius focuses the camera on the real Current Location, never on markers or Indonesia", () => {
  const mapCode = stripComments(homeMap);
  // The camera effect is driven by the preset radius...
  assert.match(mapCode, /cameraRadiusMeters/);
  // ...centers on the REAL geolocation fix — INSTANTLY...
  assert.match(mapCode, /map\.setView\(\[anchor\.lat, anchor\.lng\]/);
  // ...derives zoom from the radius itself (radius-sized bounds box)...
  assert.match(mapCode, /getBoundsZoom\(bounds\)/);
  assert.match(mapCode, /latDelta = radiusMeters \/ 111_320/);
  // ...never steals the camera from the user (interactions latch; the latch
  // re-arms on a NEW preset choice so the next tab can refocus).
  assert.match(mapCode, /userInteractedRef\.current\) return/);
  // Home passes ONE camera preset mapping for every mode (distance tabs or
  // the curated 10 km preset).
  const pageCode = stripComments(homePage);
  assert.match(pageCode, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
});

test("No-preset fallback keeps the one-shot unbounded focus; it is not a distance tab", () => {
  const mapCode = stripComments(homeMap);
  // The null-preset fallback exists ONLY for safety (no Home mode reaches
  // it) and stays a one-shot focus on the actual location, never a radius
  // re-zoom and never a marker fit.
  assert.match(mapCode, /if \(!autoFocusedRef\.current\) \{\n\s*autoFocusedRef\.current = true;\n\s*focusUser\(map, anchor\);\n\s*\}/);
});

test("Camera is ALWAYS bounded to CANONICAL Place coordinates: no marker-set camera, no invented world view", () => {
  const mapCode = stripComments(homeMap);
  const pageCode = stripComments(homePage);
  // Every camera move centers the REAL Current Location... TWO preset
  // applications exist: the preset anchor (active tab/curated radius) and
  // the "Lokasi Saya" recenter (its own 15 km current-location coverage) —
  // BOTH derive zoom from a radius and BOTH center the real fix; neither
  // ever fits markers.
  const moves = mapCode.match(/map\.setView\(\[anchor\.lat, anchor\.lng\]/g) ?? [];
  assert.equal(moves.length, 1, "the preset anchor — the only instant setView on the raw fix (the locate recenter centers the same real fix through the shared `center` value)");
  // ...whose zoom is derived from the preset radius box (bounded), and no
  // world/country fallback view is invented for the no-fix case.
  assert.match(mapCode, /map\.fitWorld\(\)/);
  // Home itself never calls Leaflet's fitBounds — the camera mechanism lives
  // entirely in the map component, which frames a CANONICAL Place spread.
  assert.equal(pageCode.includes("fitBounds"), false);
  assert.equal(pageCode.includes("collectGeoPoints"), false, "Home hands over canonical Places, never bounds");
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
  assert.match(mapCode, /L\.control\.zoom\(\{ position: "topright", zoomInTitle: "Perbesar peta", zoomOutTitle: "Perkecil peta" \}\)/);
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
  // ...and still centers on the REAL geolocation fix with preset-derived
  // zoom, applied instantly (setView).
  assert.match(mapCode, /map\.setView\(\[anchor\.lat, anchor\.lng\]/);
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

test("Curated mode centers the camera on Current Location with 10 km coverage", () => {
  const pageCode = stripComments(homePage);
  const mapCode = stripComments(homeMap);
  // Home passes the curated camera radius ONLY while curated is on; normal
  // modes keep the distance-tab preset mapping untouched. Both are 10 km
  // (locked by the coverage constants), never the retired 50 km frame.
  assert.match(pageCode, /CURATED_CAMERA_RADIUS_M/);
  assert.match(pageCode, /cameraRadiusMeters=\{\n?\s*curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]\n?\s*\}/);
  assert.equal(CURATED_CAMERA_RADIUS_M, 10_000);
  // The map applies to the REAL fix with radius-derived zoom — no fallback
  // coordinate is ever introduced (the no-fake-position test above still
  // applies to every setViewerPosition call).
  assert.match(mapCode, /cameraRadiusMeters !== null/);
  assert.match(mapCode, /radiusZoom\(map, anchor, cameraRadiusMeters\)/);
  assert.match(mapCode, /map\.setView\(\[anchor\.lat, anchor\.lng\], Math\.max\(2, zoom\), \{ animate: false \}\)/);
});

test("Curated MEMBERSHIP never comes from the camera radius or the coverage rule", () => {
  const pageCode = stripComments(homePage);
  // The curated layer narrows ONLY by the canonical curated ids — the camera
  // radius appears ONLY as the camera prop, never in the membership rule. The
  // curated set is an intersection with the curated ids: an empty selection
  // yields an empty curated LIST, never the full search-filtered set and
  // never a radius-filtered one. The MAP coverage rule is a separate,
  // explicitly named dataset step (see the curated map test below).
  assert.match(pageCode, /if \(curatedOnly\) \{/);
  assert.match(
    pageCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
  assert.doesNotMatch(pageCode, /curatedIdSet\.size > 0/);
  const cameraUses = pageCode.match(/CURATED_CAMERA_RADIUS_M/g) ?? [];
  // 3 uses: import + the camera prop + the MOCKUP coverage/scale LABEL that
  // mirrors the active radius (display only — still never a membership or
  // dataset input; the membership rule above stays untouched).
  assert.equal(cameraUses.length, 3, "import + camera prop + truthful display label only");
  // The coverage rule may only ADD ordinary Places to the curated MAP, and
  // only as the non-curated remainder. RE-ORDERED (product decision,
  // 2026-10-03): that remainder is named ONCE as `curatedCoverageSource` and
  // the curated marker coverage narrows it — same rule, one named step.
  assert.match(pageCode, /const curatedCoverageSource = useMemo\([\s\S]*searchFiltered\.filter\(\(place\) => !curatedIdSet\.has\(place\.id\)\)/);
  assert.doesNotMatch(pageCode, /matchesDistance\([^)]*CURATED/);
  // Discovery is never used as the extra map source either.
  assert.doesNotMatch(pageCode, /discovery\?\.discovery[^\n]*curatedCoveragePlaces|curatedCoveragePlaces[^\n]*discovery\?\.discovery/);
});

// --- Unified marker system (PO, 2026-09-29): base pin + treatments ---

test("ONE base Place marker: compact teardrop, no emoji, treatments not different models", () => {
  const mapCode = stripComments(homeMap);
  // One marker builder for every Place: the SAME teardrop shape in all
  // modes — only the fill color (and the curated accent) differ, and the
  // treatment follows the Place's OWN canonical curated flag (the curated
  // map shows curated AND ordinary Places side by side).
  assert.match(mapCode, /const isCurated = place\.isCurated === true/);
  assert.match(mapCode, /const pinColor = isCurated \? BRAND_SECONDARY : BRAND_BROWN/);
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
  // No curated-only label branch is left (decluttering covers every Place,
  // curated or not).
  assert.doesNotMatch(mapCode, /if \(isCurated\) \{\n\s*marker\.bindTooltip/);
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

// --- Instant camera + one-shot pin focus feedback (PO, 2026-09-30) ---

test("Preset camera moves stay INSTANT; only the locate recenter animates (and briefly)", () => {
  const mapCode = stripComments(homeMap);
  const pageCode = stripComments(homePage);
  // Choosing a tab stays an instant setView on the real fix — Leaflet skips
  // its animated-zoom path entirely for these options (synchronous
  // _resetView, no requestAnimFrame, no easing curve). The null-preset focus
  // uses position.lat and is locked in the locate pulse test below.
  const setViews = mapCode.match(/map\.setView\(\[anchor\.lat, anchor\.lng\],[\s\S]*?\{ animate: false \}\)/g) ?? [];
  assert.equal(setViews.length, 1, "the preset anchor applies instantly");
  // The ONLY animated move is the locate recenter, and it is bounded (the
  // locate-transition test proves the real duration value).
  assert.equal((mapCode.match(/map\.flyTo\(/g) ?? []).length, 1, "exactly one animated move — the locate recenter");
  assert.equal((mapCode.match(/duration:/g) ?? []).length, 1, "exactly one bounded duration — the locate transition");
  assert.equal(pageCode.includes("flyTo"), false, "no flyTo in Home discovery");
  assert.equal(pageCode.includes("duration"), false, "no duration in Home discovery");
  assert.equal(pageCode.includes("easeLinearity"), false, "no easing in Home discovery");
  // No animated fit and no fallback camera anywhere in either file.
  // SUPERSEDED (product decision, 2026-10-03): an INSTANT `fitBounds` now
  // exists for the curated tab and a location search — the auto-fit camera.
  // It is deliberately `animate: false`, so the "instant camera" rule above
  // still holds in full: the only animated move is the locate recenter.
  const animatedFits = mapCode.match(/fitBounds\([\s\S]{0,240}?animate: true/g) ?? [];
  assert.equal(animatedFits.length, 0, "the auto-fit is never animated");
  assert.equal(pageCode.includes("fitBounds"), false);
});

test("Tempat Pilihan transition: instant 10 km preset camera + one-shot pin focus pulse", () => {
  const mapCode = stripComments(homeMap);
  const pageCode = stripComments(homePage);
  const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  // Home enables the pin pulse ONLY for the curated layer — the transition
  // into "Tempat Pilihan" is made visually obvious by the pin, never by an
  // animated camera.
  assert.match(pageCode, /pulsePinOnPresetChange=\{curatedOnly\}/);
  // The map applies the pulse after the INSTANT preset application...
  assert.match(mapCode, /pulsePinOnPresetChange\) triggerLocatePulse\(\)/);
  // ...which is a SHORT BOUNDED burst (~900 ms, two cycles — never infinite)
  // on the EXISTING user pin element (getElement), never a new marker and
  // never a marker redesign.
  assert.match(mapCode, /const triggerLocatePulse = useCallback/);
  assert.match(mapCode, /userPinRef\.current\?\.getElement\?\.\(\)/);
  assert.match(mapCode, /singgah-locate-pulse/);
  assert.doesNotMatch(mapCode, /L\.marker\([\s\S]{0,240}locate-pulse/);
  assert.doesNotMatch(mapCode, /L\.divIcon\([\s\S]{0,240}locate-pulse/);
  assert.equal((mapCode.match(/class=.singgah-locate-pulse/g) ?? []).length, 0, "pulse is applied via classList, not baked into a marker");
  // The pulse timer is a one-shot (no interval, no infinite loop).
  assert.match(mapCode, /setTimeout\(\(\) => \{\n\s*locatePulseTimerRef\.current = null;/);
  assert.equal(mapCode.includes("setInterval"), false);
  assert.equal((mapCode.match(/LOCATE_PULSE_MS/g) ?? []).length, 3, "one declared window, used for the pending state and the timer");
  // Minimal CSS: exactly one keyframe + one class for the locate pulse,
  // disabled under the existing reduced-motion pattern, LIVE pulse untouched.
  assert.match(globals, /@keyframes singgah-locate-pulse/);
  assert.match(globals, /\.singgah-locate-pulse \{\n  animation: singgah-locate-pulse 900ms ease-out 2;\n\}/);
  assert.doesNotMatch(globals, /singgah-locate-pulse[^\n]*infinite/);
  assert.equal((globals.match(/@keyframes/g) ?? []).length, 2, "exactly the LIVE pulse + the locate pulse");
  assert.equal((globals.match(/prefers-reduced-motion/g) ?? []).length, 2, "reduced-motion opt-out: the LIVE pulse + the locate pulse");
  assert.match(globals, /@keyframes singgah-live-pulse/);
  assert.match(globals, /\.singgah-live-pulse \{\n  animation: singgah-live-pulse 1\.8s ease-in-out infinite;\n\}/);
});

test("Lokasi Saya pulses the pin BEFORE the camera moves and survives a late marker", () => {
  const mapCode = stripComments(homeMap);
  // The pulse is triggered BEFORE the camera transition, so it is already
  // running while the map settles (not only after it).
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse]);"),
  );
  const pulseAt = locateEffect.indexOf("triggerLocatePulse();");
  const moveAt = locateEffect.indexOf("map.flyTo(");
  assert.ok(pulseAt > 0 && moveAt > pulseAt, "the pulse starts before the camera transition");
  // The reduced-motion branch keeps the same pulse (it is never skipped).
  assert.match(locateEffect, /if \(prefersReducedMotion\(\)\) \{/);
  // PENDING PULSE (PO, 2026-09-30): the feedback window is recorded BEFORE the
  // pin element is looked up, so a locate request that lands before the
  // asynchronous marker exists still pulses it once it is created.
  const pulse = mapCode.slice(
    mapCode.indexOf("const triggerLocatePulse = useCallback"),
    mapCode.indexOf("// Jump to the real user position"),
  );
  const windowAt = pulse.indexOf("locatePulseUntilRef.current = Date.now() + LOCATE_PULSE_MS;");
  const elementAt = pulse.indexOf("const element = userPinRef.current?.getElement?.();");
  assert.ok(windowAt > 0 && elementAt > windowAt, "the pending window is recorded before the pin element is read");
  assert.match(pulse, /if \(!element\) return;/);
  // ...and the user-marker effect re-applies it to a freshly built pin.
  const markerEffect = mapCode.slice(
    mapCode.indexOf("userPinRef.current = L.circleMarker"),
    mapCode.indexOf("}, [ready, viewerPosition, triggerLocatePulse]);"),
  );
  assert.match(markerEffect, /if \(Date\.now\(\) < locatePulseUntilRef\.current\) triggerLocatePulse\(\);/);
  // The zoom-preserving fallback focus still ends with the same pulse.
  assert.match(mapCode, /map\.setView\(\[position\.lat, position\.lng\], Math\.max\(map\.getZoom\(\), 15\), \{ animate: false \}\);\s*triggerLocatePulse\(\);/);
});

test("Current Location marker is visually distinct from every Place pin", () => {
  const mapCode = stripComments(homeMap);
  // A BLUE disc with a white core (MOCKUP 2026-10-01 §6 — Place pins are
  // teardrops, never discs; blue is exclusive to the user marker), no click
  // behavior, and the Lokasi Saya tooltip/label stays.
  assert.match(mapCode, /const BRAND_PIN = "#2563eb"/);
  assert.match(mapCode, /fillColor: BRAND_PIN/);
  assert.match(mapCode, /fillColor: "#ffffff"/);
  assert.match(mapCode, /Lokasi Anda/);
  // Accuracy circle is preserved (now tinted with the same blue).
  assert.match(mapCode, /radius: accuracy/);
});

test("MOCKUP 2026-10-01 §5: right-side control stack — Re-center + Lokasi Saya reuse the ONE locate flow", () => {
  const mapCode = stripComments(homeMap);
  // The labeled "Lokasi Saya" control and the Re-center arrow are BOTH
  // entries into the SAME existing onRequestLocate handler — no second
  // geolocation system, no new camera logic, no filter mutation.
  const locateButtons = mapCode.match(/onClick=\{onRequestLocate\}/g) ?? [];
  assert.equal(locateButtons.length, 2, "Re-center arrow + labeled Lokasi Saya, one shared handler");
  assert.match(mapCode, /Pusatkan peta ke lokasi saya/);
  assert.match(mapCode, /Lokasi Saya\n/);
  // The blue dot on the labeled control is decorative.
  assert.match(mapCode, /bg-\[#2563eb\] ring-2 ring-white/);
  // Both controls stay ABOVE the Leaflet control ceiling (z-[1100]).
  assert.match(mapCode, /z-\[1100\]/);
  // The Leaflet +/- stack keeps its locked topright position.
  assert.match(mapCode, /L\.control\.zoom\(\{ position: "topright", zoomInTitle: "Perbesar peta", zoomOutTitle: "Perkecil peta" \}\)/);
});
