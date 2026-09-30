import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * VIEWPORT-AWARE MAP EMPTY STATE (PO, 2026-09-30)
 *
 * Problem: the overlay was keyed on `mapPlaces.length === 0` only. A mode
 * whose dataset HAD Places could show an empty map (Places outside the real
 * Leaflet viewport) with NO overlay, and the old copy never mentioned the
 * two-finger gesture that is required to move the map (single-finger pan is
 * LOCKED OFF on touch-primary devices).
 *
 * Locked behavior:
 * 1. HomeMap evaluates the REAL Leaflet viewport (getBounds + contains) over
 *    the canonical marker positions — never an invented dataset or fallback
 *    coordinate.
 * 2. It reports `onViewportHasPlaces` on readiness (initial state needs no
 *    user gesture), on every FINISHED move/zoom (moveend/zoomend — not
 *    during gestures), after each marker-set rebuild, and on resize.
 * 3. Reports are deduped (only on change) and the long-lived map listeners
 *    always call through a ref, so no stale closure survives a re-render.
 * 4. HomeDiscovery shows the overlay when the dataset is empty OR the map
 *    reported an empty viewport; it disappears/appears live as the user
 *    pans/zooms between populated and empty areas.
 * 5. Final copy — MODE BIASA: "Belum ada Tempat Terdaftar di sekitar area
 *    ini" / MODE TEMPAT PILIHAN: "Belum ada Tempat Pilihan di sekitar area
 *    ini"; description (both): "Geser peta dengan dua jari untuk melihat
 *    area lain."
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

// --- A. Viewport-aware plumbing ---

test("HomeMap exposes the viewport-status callback and never derives it from dataset length", () => {
  // The callback is a typed optional prop, destructured, and mirrored into a
  // ref every render (long-lived map listeners can never hold a stale one).
  assert.match(homeMap, /onViewportHasPlaces\?: \(hasPlaces: boolean\) => void;/);
  assert.match(mapCode, /onViewportHasPlaces,/);
  assert.match(mapCode, /onViewportHasPlacesRef\.current = onViewportHasPlaces \?\? null/);
});

test("Status is evaluated on moveend + zoomend only — never per-frame during a gesture", () => {
  // moveend fires once per FINISHED move/pan/zoom (two-finger pan, pinch,
  // zoom control, or programmatic preset flight); zoomend right after it for
  // zooms. No move/movestart/zoom listener is registered.
  assert.match(mapCode, /map\.on\("moveend", \(\) => \{[\s\S]*?evaluateViewportStatus\(\);/);
  assert.match(mapCode, /map\.on\("zoomend", evaluateViewportStatus\);/);
  assert.equal(/map\.on\("move"/.test(mapCode), false, "no continuous move listener");
  assert.equal(/map\.on\("zoom"/.test(mapCode), false, "no zoom-start listener");
  assert.equal(/map\.on\("movestart"/.test(mapCode), false);
});

test("Evaluation reads the REAL Leaflet viewport over canonical marker positions", () => {
  // getBounds + contains — the actual on-screen area, not a heuristic.
  assert.match(mapCode, /const bounds = map\.getBounds\(\)/);
  assert.match(mapCode, /bounds\.contains\(\[lat, lng\]\)/);
  // The mirror holds ONLY canonical coordinates that receive a marker — the
  // same fail-closed Number.isFinite rule as the marker builder below.
  assert.match(mapCode, /if \(!Number\.isFinite\(place\.latitude\) \|\| !Number\.isFinite\(place\.longitude\)\) continue;\n\s*markerPositions\.push\(\[place\.latitude, place\.longitude\]\);/);
  // No fallback/invented coordinate anywhere in the evaluation.
  assert.equal(/markerPositionsRef\.current = \[\[/.test(mapCode), false);
});

test("Initial state: the first status is computed when the map is ready — no user move required", () => {
  // The readiness timer (invalidateSize settle) performs the first
  // evaluation, so Leaflet readiness alone decides the initial overlay.
  assert.match(mapCode, /if \(mapRef\.current === map\) \{\n\s*invalidate\(map\);\n\s*evaluateViewportStatus\(\);\n\s*\}/);
});

test("Marker-set rebuilds and resizes re-evaluate the viewport status", () => {
  // After the marker loop: status against the NEW set (the final call inside
  // the marker effect's async body, right before its cleanup registration).
  assert.match(mapCode, /evaluateViewportStatus\(\);\n\s*\}\)\(\);\n\n\s*return \(\) => \{\n\s*cancelled = true;/);
  // The empty-set early return also reports (dataset emptied → overlay).
  assert.match(mapCode, /if \(currentPlaces\.length === 0\) \{\n\s*evaluateViewportStatus\(\);\n\s*return;\n\s*\}/);
  // Resize/invalidateSize can change the visible area without a map move.
  assert.match(mapCode, /const onWindowResize = \(\) => \{\n\s*const map = mapRef\.current;\n\s*if \(map\) invalidate\(map\);\n\s*evaluateViewportStatus\(\);\n\s*\};/);
});

test("Reports are deduped and the overlay flips exactly when visibility flips", () => {
  // Report ONLY on change — no re-render storms from the moveend burst.
  assert.match(mapCode, /if \(hasPlaces !== lastViewportHasPlacesRef\.current\) \{[\s\S]*?report\(hasPlaces\);/);
});

test("Teardown stays complete: no listener leak and no stale callback capture", () => {
  // map.off() (existing full teardown) still runs; no extra global listeners
  // were added.
  assert.match(mapCode, /map\.off\(\)/);
  const globalAdds = mapCode.match(/window\.addEventListener\(/g) ?? [];
  assert.equal(globalAdds.length, 1, "only the pre-existing resize listener");
  // The callback is mirrored into the ref inside an effect — never during
  // render (react-hooks/refs), so no stale closure can survive a re-render.
  assert.match(mapCode, /useEffect\(\(\) => \{\n\s*onViewportHasPlacesRef\.current = onViewportHasPlaces \?\? null;\n\s*\}, \[onViewportHasPlaces\]\);/);
});

// --- B. HomeDiscovery consumption ---

test("Overlay keys on dataset-empty OR reported-empty-viewport, not dataset length alone", () => {
  // The compound condition with the readiness gate.
  assert.match(pageCode, /const mapEmptyStateVisible =\n\s*mapPlaces\.length === 0 \|\| \(viewportReported && !viewportHasPlaces\);/);
  // The map reports into stable state (useCallback — never a fresh closure).
  assert.match(pageCode, /const handleViewportHasPlaces = useCallback\(\(hasPlaces: boolean\) => \{/);
  assert.match(pageCode, /onViewportHasPlaces=\{handleViewportHasPlaces\}/);
  // The old dataset-only gate is gone.
  assert.equal(/\{mapPlaces\.length === 0 && \(/.test(pageCode), false);
});

test("The callback does not touch dataset, camera presets, or marker design", () => {
  // Camera preset mapping and map dataset stay exactly as locked before.
  assert.match(pageCode, /cameraRadiusMeters=\{\n?\s*curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]\n?\s*\}/);
  // The map dataset memo (up to the empty-state flag) never references the
  // callback — dataset composition is untouched.
  const mapDataset = pageCode.slice(pageCode.indexOf("const mapPlaces"), pageCode.indexOf("const mapEmptyStateVisible"));
  assert.match(mapDataset, /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoveragePlaces\] : visiblePlaces;/);
  assert.doesNotMatch(mapDataset, /matchesDistance/);
  assert.doesNotMatch(mapDataset, /onViewportHasPlaces/);
  // Marker design untouched (same base pin, per-Place CURATED/NORMAL
  // treatments on that one shape).
  assert.match(mapCode, /const pinColor = isCurated \? BRAND_SECONDARY : BRAND_BROWN/);
});

// --- C. Final copy (verbatim) ---

test("Copy: mode biasa + Tempat Pilihan titles and the two-finger description are verbatim", () => {
  assert.match(pageCode, /Belum ada Tempat Terdaftar di sekitar area ini/);
  assert.match(pageCode, /Belum ada Tempat Pilihan di sekitar area ini/);
  assert.match(pageCode, /Geser peta dengan dua jari untuk melihat area lain\./);
  // The two titles are the curatedOnly branch of ONE overlay.
  assert.match(
    pageCode,
    /curatedOnly\n\s*\? "Belum ada Tempat Pilihan di sekitar area ini"\n\s*: "Belum ada Tempat Terdaftar di sekitar area ini"/,
  );
  // The description mentions the two-finger gesture exactly once.
  assert.equal((pageCode.match(/Geser peta dengan dua jari/g) ?? []).length, 1);
});

test("Deprecated copy must not return", () => {
  for (const phrase of [
    "Belum ada Tempat dengan koordinat di peta",
    "Peta hanya menampilkan Tempat dengan koordinat resmi",
    "Tempat lain tetap ada di daftar",
    "Geser peta untuk melihat area lain",
  ]) {
    assert.equal(pageCode.includes(phrase), false, `deprecated copy: ${phrase}`);
  }
});
