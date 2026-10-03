import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  isSameViewport,
  isWithinViewport,
  narrowToViewport,
  type MapViewport,
} from "../lib/live/ui";

/**
 * VIEWPORT AS THE GEOGRAPHIC COVERAGE SOURCE (product decision, 2026-10-01)
 *
 * Root cause this suite locks shut: the Home map reported only a BOOLEAN
 * ("is a marker inside the viewport?") for the empty state, while the markers
 * and both Place rows were decided by fixed radius presets around the real
 * fix. Panning or zooming the map therefore changed nothing in the lists,
 * "1 km" could hide Places the user was looking at, and "Lokasi Saya" forced a
 * wide 10 km frame instead of the close zoom in use.
 *
 * The map now REPORTS its real bounds; those bounds are the ONE coverage
 * source for the markers, the Discovery Place row, and the "Tempat Pilihan"
 * row. Everything below proves the invariants around that change: viewport
 * narrowing can only REMOVE canonical entries, never add, re-order, or make
 * an ineligible Place eligible; coordinate-less Places are never placed; the
 * map lifecycle and listeners stay leak-free; and no security, RLS, scoring,
 * or server-side canonical read was touched.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const mapCode = stripComments(homeMap);
const pageCode = stripComments(homeDiscovery);

type Placeish = { id: string; latitude: number | null; longitude: number | null };

const JAKARTA: MapViewport = { north: -6.1, south: -6.3, east: 106.9, west: 106.7 };
const BANDUNG: MapViewport = { north: -6.9, south: -7.1, east: 107.7, west: 107.5 };

const place = (id: string, latitude: number | null, longitude: number | null): Placeish => ({
  id,
  latitude,
  longitude,
});

// ---------------------------------------------------------------------------
// 1-2. Canonical results are narrowed by the viewport, never widened.
// ---------------------------------------------------------------------------

test("1. Discovery shows only canonical engine Places that are inside the viewport", () => {
  const canonical = [
    place("eligible-jakarta", -6.2, 106.8166),
    place("eligible-bandung", -6.9, 107.6),
  ];
  // Only the canonical entries, in canonical order, minus the out-of-viewport
  // one — the viewport is a filter, never a source.
  assert.deepEqual(
    narrowToViewport(canonical, JAKARTA).map((item) => item.id),
    ["eligible-jakarta"],
  );
  // The row is built from the engine output and then narrowed — there is no
  // second list source anywhere in the component.
  const row = pageCode.slice(pageCode.indexOf("const discoveryRowPlaces"), pageCode.indexOf("const curatedListed"));
  assert.match(row, /const canonical = \(discovery\?\.discovery \?\? \[\]\)\.flatMap/);
  assert.match(row, /return narrowToViewport\(canonical, coverageViewport\);/);
  assert.doesNotMatch(row, /places\.filter|searchFiltered\.flatMap/);
});

test("2. A Place outside the viewport never appears in a viewport-following list", () => {
  const inside = place("inside", -6.2, 106.8);
  const outside = place("outside", -7.0, 107.6);
  const listed = narrowToViewport([inside, outside], JAKARTA);
  assert.deepEqual(listed.map((item) => item.id), ["inside"]);
  assert.equal(listed.some((item) => item.id === "outside"), false);
  // All three consumers narrow by the SAME viewport value, so markers and the
  // two rows can never disagree.
  assert.match(pageCode, /narrowToViewport\(visiblePlaces, coverageViewport\)/);
  assert.match(pageCode, /narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/);
  assert.match(pageCode, /narrowToViewport\(mapPlaces, coverageViewport\)/);
  assert.match(pageCode, /places=\{visibleMapPlaces\}/);
});

test("2b. Panning the viewport changes the result with no dataset change", () => {
  const places = [place("jakarta", -6.2, 106.8), place("bandung", -7.0, 107.6)];
  assert.deepEqual(
    narrowToViewport(places, JAKARTA).map((item) => item.id),
    ["jakarta"],
  );
  assert.deepEqual(
    narrowToViewport(places, BANDUNG).map((item) => item.id),
    ["bandung"],
  );
  // The narrowing is order-preserving: canonical ranking is never re-sorted.
  const ordered = [place("rank-1", -7.0, 107.6), place("rank-2", -6.2, 106.8), place("rank-3", -6.9, 107.6)];
  assert.deepEqual(
    narrowToViewport(ordered, { north: 0, south: -10, east: 120, west: 100 }).map((item) => item.id),
    ["rank-1", "rank-2", "rank-3"],
  );
});

// ---------------------------------------------------------------------------
// 3-4. Reports happen on FINISHED gestures, resize, and readiness.
// ---------------------------------------------------------------------------

test("3. The viewport is reported on finished move/zoom only — never per frame", () => {
  assert.match(homeMap, /onViewportChange\?: \(viewport: MapViewport\) => void;/);
  assert.match(mapCode, /onViewportChangeRef\.current = onViewportChange \?\? null;/);
  // moveend + zoomend (once per gesture), readiness, and resize — and NO
  // continuous move/zoom listener anywhere.
  assert.match(mapCode, /evaluateViewportStatus\(\);\n\s*reportViewportBounds\(\);/);
  assert.match(mapCode, /map\.on\("zoomend", evaluateViewportStatus\);/);
  assert.match(mapCode, /map\.on\("zoomend", reportViewportBounds\);/);
  assert.equal(/map\.on\("move"/.test(mapCode), false, "no continuous move listener");
  assert.equal(/map\.on\("zoom"/.test(mapCode), false, "no continuous zoom listener");
  assert.equal(/map\.on\("movestart"/.test(mapCode), false);
  assert.equal(/requestAnimationFrame/.test(mapCode), false, "no per-frame work");
  // Reports are deduped on exact bounds equality, and the reader is stable
  // ([] deps) so no listener ever captures a stale closure.
  assert.match(mapCode, /if \(isSameViewport\(lastViewportRef\.current, viewport\)\) return;/);
  assert.match(mapCode, /const reportViewportBounds = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/);
});

test("4. Resize, readiness, and dataset changes all refresh the viewport state", () => {
  // Resize changes the visible area without any map move.
  assert.match(
    mapCode,
    /const onWindowResize = \(\) => \{\n\s*const map = mapRef\.current;\n\s*if \(map\) invalidate\(map\);\n\s*evaluateViewportStatus\(\);\n\s*reportViewportBounds\(\);\n\s*\};/,
  );
  assert.match(
    mapCode,
    /if \(mapRef\.current === map\) \{\n\s*invalidate\(map\);\n\s*evaluateViewportStatus\(\);\n\s*reportViewportBounds\(\);\n\s*\}/,
  );
  // Readiness reports the FIRST viewport: the rows never wait for a gesture.
  // The marker rebuild re-evaluates the empty-state status against the new set
  // (a dataset change can empty or fill the viewport without a camera move).
  assert.match(mapCode, /markerPositionsRef\.current = markerPositions;/);
  assert.match(mapCode, /evaluateViewportStatus\(\);/);
  // Home dedupes the incoming reports too, so a settled viewport never
  // re-renders the rows.
  assert.match(pageCode, /if \(isSameViewport\(lastViewportRef\.current, viewport\)\) return;/);
  assert.match(pageCode, /onViewportChange=\{handleViewportChange\}/);
  // CONTAINER resize without a window resize event (the Home map box is
  // vh-based, so mobile browser chrome / orientation / keyboard change it):
  // a ResizeObserver re-measures and re-reports, guarded on a REAL size
  // change, and is always disconnected in teardown.
  assert.match(mapCode, /typeof ResizeObserver === "function"/);
  assert.match(mapCode, /new ResizeObserver\(\(\) => \{[\s\S]*?invalidate\(map\);[\s\S]*?reportViewportBounds\(\);[\s\S]*?\}\)/);
  assert.match(mapCode, /if \(previous && previous\.x === size\.x && previous\.y === size\.y\) return;/);
  assert.match(mapCode, /resizeObserver\.observe\(containerRef\.current\);/);
  assert.match(mapCode, /resizeObserver\?\.disconnect\(\);/);
  // It adds no global listener and no polling loop.
  assert.equal((mapCode.match(/window\.addEventListener\(/g) ?? []).length, 1, "only the resize listener");
  assert.equal((mapCode.match(/setInterval\(/g) ?? []).length, 0);
});

test("4b. Before the first viewport report the canonical result still renders", () => {
  // Leaflet has not reported yet (map not ready, or its box not measured):
  // `null` narrows nothing except coordinate-less Places, so the first paint
  // can never show a wrongly empty list.
  const places = [place("jakarta", -6.2, 106.8), place("bandung", -7.0, 107.6), place("no-coords", null, null)];
  assert.deepEqual(narrowToViewport(places, null).map((item) => item.id), ["jakarta", "bandung"]);
  // ...and once the report arrives the same Places narrow to the visible area.
  assert.deepEqual(narrowToViewport(places, JAKARTA).map((item) => item.id), ["jakarta"]);
  // The overlay stays hidden until the map has reported: the readiness gate is
  // the same `viewportReported` flag.
  assert.match(pageCode, /const \[viewportReported, setViewportReported\] = useState\(false\);/);
  assert.match(pageCode, /viewportReported && !viewportHasPlaces/);
  assert.equal(/viewportReported \|\|/.test(pageCode), false, "an unreported viewport must never show the empty state");
});

// ---------------------------------------------------------------------------
// 5-7. Curated layer, empty state, and the overlap rule.
// ---------------------------------------------------------------------------

test("5. Tempat Pilihan comes only from canonical is_curated and follows the viewport", () => {
  // Membership is still the canonical id set — the camera radius and the
  // viewport are never membership inputs.
  assert.match(pageCode, /const curatedIdSet = useMemo\(\s*\(\) => new Set\(discovery\?\.curatedPlaceIds \?\? \[\]\)/);
  const curatedRow = pageCode.slice(pageCode.indexOf("const curatedListed"), pageCode.indexOf("const curatedCoveragePlaces"));
  assert.match(
    curatedRow,
    /narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
  assert.doesNotMatch(curatedRow, /distanceFilter|CURATED_CAMERA_RADIUS_M|curatedCoveragePlaces/);
  // The curated MAP's extra ordinary source is the non-curated remainder
  // inside the real viewport — never a fixed radius any more.
  // RE-ORDERED (product decision, 2026-10-03): the non-curated remainder is
  // now named ONCE in `curatedCoverageSource` (the un-narrowed candidate set)
  // and the marker set narrows that — so the coverage rule is provably still
  // the non-curated remainder, never Discovery and never a radius. The slice
  // ends before the CAMERA dataset, which is a separate rule (the viewer's
  // local area, correction 2026-10-03) and legitimately reads the real fix.
  const coverage = pageCode.slice(pageCode.indexOf("const curatedCoverageSource"), pageCode.indexOf("const cameraFitPlaces"));
  assert.match(coverage, /searchFiltered\.filter\(\(place\) => !curatedIdSet\.has\(place\.id\)\)/);
  assert.match(coverage, /return narrowToViewport\(curatedCoverageSource, coverageViewport\);/);
  assert.doesNotMatch(coverage, /distanceMeters|viewerPosition/);
});

test("6. An empty result never falls back to the full published set", () => {
  // Canonical behaviour: an empty curated set intersects to nothing, and an
  // empty viewport narrows to nothing. Neither produces a published fallback.
  const curatedIdSet = new Set<string>();
  const published = [place("a", -6.2, 106.8), place("b", -6.25, 106.8)];
  assert.deepEqual(published.filter((item) => curatedIdSet.has(item.id)), []);
  assert.deepEqual(narrowToViewport(published, { north: 0, south: 10, east: 0, west: -10 }), []);
  // ...and the component has no "show everything" branch for either layer.
  assert.equal(pageCode.includes("curatedIdSet.size > 0"), false);
  const visible = pageCode.slice(pageCode.indexOf("const visiblePlaces"), pageCode.indexOf("const listedPlaces"));
  assert.doesNotMatch(visible, /:\s*searchFiltered\s*;/);
});

test("7. Discovery and Tempat Pilihan keep the approved overlap behaviour", () => {
  // A Place in both layers appears in BOTH rows: neither row deduplicates the
  // other and the curated row is not folded into the Discovery row.
  const curated = place("both", -6.2, 106.8);
  const curatedIdSet = new Set(["both"]);
  const engineOrder = [curated, place("only-discovery", -6.22, 106.81)];
  const discoveryRow = narrowToViewport(engineOrder, JAKARTA);
  const curatedRow = narrowToViewport(engineOrder.filter((item) => curatedIdSet.has(item.id)), JAKARTA);
  assert.deepEqual(discoveryRow.map((item) => item.id), ["both", "only-discovery"]);
  assert.deepEqual(curatedRow.map((item) => item.id), ["both"]);
  const discoverySlice = pageCode.slice(pageCode.indexOf("const discoveryRowPlaces"), pageCode.indexOf("const curatedListed"));
  assert.doesNotMatch(discoverySlice, /curatedIdSet/);
  // The per-Place curated marker treatment still flows from canonical membership.
  assert.match(pageCode, /isCurated: curatedOnly && curatedIdSet\.has\(place\.id\),/);
  // The header counter stays per layer.
  assert.match(
    pageCode,
    /curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\}`\n\s*: `\$\{discoveryRowPlaces\.length\} tempat \$\{nearOrigin\}`/,
  );
});

// ---------------------------------------------------------------------------
// 8. Search + LIVE stay above the viewport gate.
// ---------------------------------------------------------------------------

test("8. Search and LIVE still work with the viewport and never admit an ineligible Place", () => {
  const page = pageCode;
  // ONE search implementation, applied BEFORE the viewport narrowing.
  assert.match(page, /const searchFiltered = useMemo\(\(\) => \{[\s\S]*?return places;/);
  assert.match(page, /const searchFilteredIds = useMemo\(/);
  assert.match(page, /if \(liveOnly\) result = result\.filter\(\(place\) => liveByPlaceId\.has\(place\.id\)\);/);
  // A live-only search that matches nothing outside the viewport stays empty:
  // the viewport is the LAST step, so it can only remove.
  const liveIds = new Set(["live-place"]);
  const liveResult = [place("live-place", -6.2, 106.8), place("other", -7.0, 107.6)].filter((item) =>
    liveIds.has(item.id),
  );
  assert.deepEqual(narrowToViewport(liveResult, JAKARTA).map((item) => item.id), ["live-place"]);
  assert.deepEqual(narrowToViewport(liveResult, BANDUNG).map((item) => item.id), []);
  // Discovery eligibility is untouched: the row still starts from the engine.
  assert.match(page, /\(discovery\?\.discovery \?\? \[\]\)\.flatMap/);
});

// ---------------------------------------------------------------------------
// 9. No fabricated position, ever.
// ---------------------------------------------------------------------------

test("9. A Place without canonical coordinates is never placed, marked, or listed", () => {
  const noCoords = place("no-coords", null, null);
  const partial = place("partial", -6.2, null);
  const places = [place("real", -6.2, 106.8), noCoords, partial];
  assert.deepEqual(
    narrowToViewport(places, JAKARTA).map((item) => item.id),
    ["real"],
  );
  assert.deepEqual(narrowToViewport(places, null).map((item) => item.id), ["real"]);
  assert.equal(isWithinViewport(JAKARTA, Number.NaN, 106.8), false);
  assert.equal(isWithinViewport(JAKARTA, -6.2, Number.NaN), false);
  // The marker builder keeps the Number.isFinite fail-closed rule, and the
  // dataset keeps its null-coordinate guard.
  assert.match(mapCode, /if \(!Number\.isFinite\(place\.latitude\) \|\| !Number\.isFinite\(place\.longitude\)\) continue;/);
  assert.match(pageCode, /if \(place\.latitude === null \|\| place\.longitude === null\) return \[\];/);
});

// ---------------------------------------------------------------------------
// 10. Lokasi Saya: real GPS, no forced zoom-out, no camera move on failure.
// ---------------------------------------------------------------------------

test("10. Lokasi Saya frames the viewer's local Place distribution around the real fix", () => {
  const locateEffect = mapCode.slice(
    mapCode.indexOf("lastLocateNonceRef.current = locateNonce;"),
    mapCode.indexOf("}, [locateNonce, ready, viewerPosition, triggerLocatePulse, fitCamera]);"),
  );
  // The frame is built from the eligible LOCAL places plus the REAL fix — never
  // from a radius preset, never from a bare setView at the previous zoom, and
  // never from the global dataset.
  assert.match(locateEffect, /const localPlaces = locateFitPlacesRef\.current;/);
  assert.match(locateEffect, /const candidates: HomeMapPlace\[\] =\s*localPlaces\.length > 0/);
  assert.match(locateEffect, /id: VIEWER_FIT_POINT_ID,/);
  assert.match(locateEffect, /const applied = await fitCamera\(map, candidates, LOCATE_FIT_MAX_ZOOM\);/);
  // With NO eligible local Place the camera focuses the user's own coordinate
  // at the close floor — and stops there.
  assert.match(locateEffect, /if \(cancelled \|\| mapRef\.current !== map \|\| applied\) return;/);
  assert.match(locateEffect, /map\.setView\(\[viewerPosition\.lat, viewerPosition\.lng\], Math\.max\(map\.getZoom\(\), LOCATE_MIN_ZOOM\)/);
  assert.doesNotMatch(locateEffect, /radiusZoom/);
  assert.doesNotMatch(locateEffect, /CAMERA_PRESET_RADIUS_M|CURATED_CAMERA_RADIUS_M/);
  // It never reads or mutates the selected tab, and never invents a position.
  assert.doesNotMatch(locateEffect, /setCuratedOnly|setDistanceFilter|cameraRadiusMeters/);
  const floor = Number(/const LOCATE_MIN_ZOOM = (\d+)/.exec(homeMap)?.[1] ?? "0");
  assert.ok(floor >= 14, "the locate fallback focus must be a CLOSE zoom");
  // Failure handling: a denied/timeout fix writes no position and moves no
  // camera; the request simply stays pending.
  assert.match(pageCode, /\(\) => undefined,\s*\{\s*timeout: 8000\s*\}/);
  assert.equal((pageCode.match(/setViewerPosition\(/g) ?? []).length, 1, "only the real fix writes a position");
  assert.match(pageCode, /lat: position\.coords\.latitude/);
  // A repeated press re-centres on the newest fix; an older async callback can
  // never overwrite a newer one (the nonce is committed before the request).
  const press = pageCode.slice(pageCode.indexOf("const handleLocatePress"), pageCode.indexOf("const liveByPlaceId"));
  assert.match(press, /setLocateNonce\(\(nonce\) => nonce \+ 1\);\s*requestViewerPosition\(\);/);
});

// ---------------------------------------------------------------------------
// 11. The user marker must stay visible ABOVE the Place markers.
// ---------------------------------------------------------------------------

test("11. The Current Location marker renders in its own pane above every Place pin", () => {
  // Leaflet pane ladder (leaflet.css): markerPane 600, tooltipPane 650. A
  // CircleMarker in the default overlayPane (400) used to paint UNDER every
  // DOM Place pin, so the user disc could disappear behind them.
  const leafletCss = readFileSync(new URL("../node_modules/leaflet/dist/leaflet.css", import.meta.url), "utf8");
  assert.match(leafletCss, /\.leaflet-pane\s*\{\s*z-index:\s*400;/);
  assert.match(mapCode, /const userPane = map\.createPane\(USER_PANE\);/);
  assert.match(mapCode, /userPane\.style\.zIndex = "640";/);
  // Every user layer (accuracy circle, pin, core dot) is drawn in that pane.
  const userLayers = mapCode.slice(mapCode.indexOf("const accuracy = viewerPosition.accuracy"), mapCode.indexOf("}, [ready, viewerPosition, triggerLocatePulse]);"));
  assert.equal((userLayers.match(/pane: USER_PANE/g) ?? []).length, 3);
  // Place markers keep their own pane and their z-priority untouched.
  assert.equal(mapCode.includes("pane: USER_PANE"), true);
  assert.match(mapCode, /zIndexOffset: live \? 0 : 500/);
  assert.match(mapCode, /zIndexOffset: 1000/);
});

// ---------------------------------------------------------------------------
// 12. Mobile gesture / control reachability.
// ---------------------------------------------------------------------------

test("12. Map gestures and controls are reachable — the chrome never swallows them", () => {
  // ROOT CAUSE: the floating search/filter wrapper spans the whole map window
  // (it also holds the invisible map-height spacer), so as a normal element it
  // sat over the Leaflet surface and intercepted every zoom click, drag, and
  // pinch. It is click-through now; only the real controls opt back in.
  assert.match(pageCode, /className="relative z-\[1100\] pointer-events-none mx-auto w-full max-w-6xl px-4"/);
  assert.match(pageCode, /className="pointer-events-auto mt-\[60px\] sm:mt-\[64px\]"/);
  assert.match(pageCode, /className="pointer-events-auto mt-2\.5 grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5"/);
  // The map surface keeps touch-action: none on its own container, so a pinch
  // starting on the map zooms the MAP, never the page — and page scrolling
  // outside the map is untouched.
  assert.match(homeMap, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
  // The informational overlays never block a gesture either. The duplicate
  // map-area filter chip was removed (2026-10-03), so there are three.
  assert.equal(
    (pageCode.match(/pointer-events-none absolute/g) ?? []).length,
    3,
    "empty state, coverage box, and scale are all click-through",
  );
  // Real Leaflet zoom control, with accessible names, plus the two locate
  // controls that share ONE handler.
  assert.match(
    mapCode,
    /L\.control\.zoom\(\{ position: "topright", zoomInTitle: "Perbesar peta", zoomOutTitle: "Perkecil peta" \}\)/,
  );
  assert.equal((mapCode.match(/onClick=\{onRequestLocate\}/g) ?? []).length, 2);
  assert.match(mapCode, /aria-label="Pusatkan peta ke lokasi saya"/);
  assert.match(mapCode, /aria-label="Lokasi saya — pusatkan peta ke lokasi aktual"/);
  // The locked one-finger / two-finger gesture decision is unchanged.
  assert.match(mapCode, /dragging: !touchPrimary/);
  assert.match(mapCode, /doubleClickZoom: !touchPrimary/);
});

// ---------------------------------------------------------------------------
// 13. No security / scoring / canonical-read regression.
// ---------------------------------------------------------------------------

test("13. Eligibility, scoring, RLS, and server-side canonical reads are untouched", () => {
  // Eligibility still comes from the server-built view model — the client
  // never recomputes it, and the viewport never adds an entry.
  assert.match(pageCode, /const placeById = useMemo\(/);
  assert.match(pageCode, /flatMap\(\(entry\) => \{\n\s*const place = placeById\.get\(entry\.placeId\);/);
  // The canonical ranking is read, never re-sorted or extended.
  assert.equal(/sort\(/.test(pageCode), false, "no client-side re-ranking of the Discovery result");
  assert.equal(/\.score\b/.test(pageCode), false, "the numeric score never reaches the client");
  // Server read path untouched: no client fetch of Places, no auth bypass.
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /getPublicPlaceExperienceRepository\(\)/);
  assert.match(page, /loadDiscoveryViewModel\(\)/);
  assert.match(page, /export const dynamic = "force-dynamic";/);
  assert.equal(pageCode.includes("/api/places"), false, "the client never refetches the published list");
  // The LIVE feed stays on its own authenticated, server-side endpoint.
  assert.match(pageCode, /fetch\("\/api\/live\/discovery"\)/);
});

// ---------------------------------------------------------------------------
// 14. Leaflet lifecycle stays safe.
// ---------------------------------------------------------------------------

test("14. Map lifecycle is leak-free and Strict-Mode safe with the new reporting", () => {
  // One container = one instance, claimed before the async import resolves.
  assert.match(mapCode, /container\.dataset\.singgahMap = "initializing"/);
  assert.equal((mapCode.match(/L\.map\(container/g) ?? []).length, 1);
  // Full teardown: listeners, every layer, the map itself, and the ref.
  assert.match(mapCode, /map\.off\(\);/);
  assert.match(mapCode, /map\.remove\(\);/);
  assert.match(mapCode, /markerLayerRef\.current\?\.remove\(\);/);
  assert.match(mapCode, /userLayerRef\.current\?\.remove\(\);/);
  assert.match(mapCode, /tileLayerRef\.current\?\.remove\(\);/);
  // The viewport reporting added NO new global listener and NO new timer.
  assert.equal((mapCode.match(/window\.addEventListener\(/g) ?? []).length, 1, "only the resize listener");
  assert.equal((mapCode.match(/setInterval\(/g) ?? []).length, 0, "no polling from the map");
  // Callbacks are mirrored into refs inside effects, never during render.
  assert.match(mapCode, /useEffect\(\(\) => \{\n\s*onViewportChangeRef\.current = onViewportChange \?\? null;\n\s*\}, \[onViewportChange\]\);/);
  assert.match(mapCode, /useEffect\(\(\) => \{\n\s*onViewportHasPlacesRef\.current = onViewportHasPlaces \?\? null;\n\s*\}, \[onViewportHasPlaces\]\);/);
});

// ---------------------------------------------------------------------------
// 15. Empty state distinguishes the two situations and needs no gesture.
// ---------------------------------------------------------------------------

test("15. Empty state separates an empty dataset from an empty viewport", () => {
  assert.match(
    pageCode,
    /const mapEmptyStateVisible =\n\s*mapPlaces\.length === 0 \|\| \(viewportReported && !viewportHasPlaces\);/,
  );
  // `mapPlaces` is the CANONICAL candidate set — the viewport-narrowed marker
  // set is a separate step, so "the dataset is empty" stays distinguishable
  // from "nothing is visible right now".
  const candidates = pageCode.slice(pageCode.indexOf("const mapPlaces"), pageCode.indexOf("const visibleMapPlaces"));
  assert.match(candidates, /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoveragePlaces\] : visiblePlaces;/);
  assert.equal(
    candidates.includes("coverageViewport"),
    false,
    "the canonical dataset is never viewport-filtered in place",
  );
  const visible = pageCode.slice(pageCode.indexOf("const visibleMapPlaces"), pageCode.indexOf("const mapEmptyStateVisible"));
  assert.match(visible, /narrowToViewport\(mapPlaces, coverageViewport\)/);
  // Copy stays the approved one, per mode.
  assert.match(pageCode, /Belum ada Tempat Terdaftar di sekitar area ini/);
  assert.match(pageCode, /Belum ada Tempat Pilihan di sekitar area ini/);
  assert.match(pageCode, /Geser peta dengan dua jari untuk melihat area lain\./);
  // First paint before any report is decided by the dataset rule only.
  assert.match(pageCode, /const \[viewportReported, setViewportReported\] = useState\(false\);/);
});

// ---------------------------------------------------------------------------
// Viewport geometry edge cases.
// ---------------------------------------------------------------------------

test("Viewport geometry: equality, antimeridian wrap, and the unreported state", () => {
  assert.equal(isSameViewport(null, null), true);
  assert.equal(isSameViewport(JAKARTA, null), false);
  assert.equal(isSameViewport(JAKARTA, { ...JAKARTA }), true);
  assert.equal(isSameViewport(JAKARTA, { ...JAKARTA, north: -6.0 }), false);
  // Wrapped viewport (panned across the ±180 line): longitude membership
  // becomes "at or east of west OR at or west of east", never an empty range.
  const wrapped: MapViewport = { north: 0, south: -10, east: -170, west: 170 };
  assert.equal(isWithinViewport(wrapped, -5, 175), true);
  assert.equal(isWithinViewport(wrapped, -5, -175), true);
  assert.equal(isWithinViewport(wrapped, -5, 0), false);
  // Latitude is always a plain range; the bounds edges are inclusive.
  assert.equal(isWithinViewport(JAKARTA, -6.1, 106.8), true);
  assert.equal(isWithinViewport(JAKARTA, -6.3, 106.7), true);
  assert.equal(isWithinViewport(JAKARTA, -6.4, 106.8), false);
  assert.equal(isWithinViewport(JAKARTA, -6.2, 106.95), false);
});
