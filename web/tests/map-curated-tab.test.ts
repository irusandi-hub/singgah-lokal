import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CURATED_TAB_ATTRIBUTION_GUARD_PX,
  CURATED_TAB_DRAG_THRESHOLD_PX,
  CURATED_TAB_HANDLE_THRESHOLD_PX,
  CURATED_TAB_STORAGE_KEY,
  MAP_CONTROL_COLUMN_BOTTOM_PX,
  MAP_CONTROL_COLUMN_TOP_PX,
  clampCuratedTabDrag,
  resolveCuratedTabArea,
  resolveCuratedTabPosition,
  snapCuratedTabPlacement,
} from "../lib/live/ui";

/**
 * FLOATING "TEMPAT PILIHAN" TAB (2026-10-21).
 *
 * The tab is a real draggable control over the map now. This suite exercises the
 * SAME geometry helpers the component uses — bounds, drag clamping, edge
 * snapping, persistence shape — and pins the interaction contract that cannot
 * be expressed as pure math: the 8px tap/drag threshold, pointer capture,
 * keyboard operation, and the reset paths.
 *
 * It also pins the two companion changes from the same decision:
 *  · the OSM attribution stays (ODbL) but loses the Leaflet wordmark/flag and
 *    is styled smaller;
 *  · the compass is gone, and the control row is two 40px tiles.
 */

const tabSource = readFileSync(new URL("../components/curated-map-tab.tsx", import.meta.url), "utf8");
const mapSource = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

const TAB_WIDTH = 150;
const TAB_HEIGHT = 44;
const STAGE = { stageWidth: 390, stageHeight: 844 };
// 390×844 at the `mid` snap: the sheet covers 42% (354px).
const MID_SHEET = 354;

function area(overrides: Partial<Parameters<typeof resolveCuratedTabArea>[0]> = {}) {
  const value = resolveCuratedTabArea({
    ...STAGE,
    sheetVisiblePx: MID_SHEET,
    tabWidth: TAB_WIDTH,
    tabHeight: TAB_HEIGHT,
    ...overrides,
  });
  assert.ok(value, "the tab must have a legal area on a supported stage");
  return value;
}

// ---------------------------------------------------------------------------
// 1. Bounds — inside the visible map, clear of chrome, controls, credit, sheet
// ---------------------------------------------------------------------------

test("1.1 the default area starts below the chrome and above the credit", () => {
  const bounds = area();
  assert.equal(bounds.minX, 12);
  assert.equal(bounds.maxX, 390 - 12 - TAB_WIDTH);
  assert.equal(bounds.minY, MAP_CONTROL_COLUMN_TOP_PX);
  // Visible seam = 844 − 354 = 490. Bottom of the tab keeps the 48px guard.
  assert.equal(bounds.maxY, 490 - CURATED_TAB_ATTRIBUTION_GUARD_PX - TAB_HEIGHT);
  assert.ok(bounds.maxY + TAB_HEIGHT <= 490 - 36, "the tab clears the OSM credit's own band");
  assert.equal(bounds.rightMinY, MAP_CONTROL_COLUMN_BOTTOM_PX + 8);
});

test("1.2 the area shrinks with the sheet and disappears when it is full", () => {
  const smallSheet = area({ sheetVisiblePx: 48 });
  const midSheet = area();
  assert.ok(smallSheet.maxY > midSheet.maxY, "a lower sheet gives the tab more map");
  assert.equal(
    resolveCuratedTabArea({ ...STAGE, sheetVisiblePx: 844, tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT }),
    null,
    "no area at `full` — the tab hides with the map",
  );
  // Too short to hold the tab without covering the credit.
  assert.equal(
    resolveCuratedTabArea({ ...STAGE, stageHeight: 250, sheetVisiblePx: 0, tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT }),
    null,
  );
  // Too narrow for the chip.
  assert.equal(
    resolveCuratedTabArea({ stageWidth: 160, stageHeight: 844, sheetVisiblePx: MID_SHEET, tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT }),
    null,
  );
});

test("1.3 the default is bottom-LEFT, above the attribution", () => {
  const bounds = area();
  const position = resolveCuratedTabPosition(bounds, { side: "left", ratio: 1 });
  assert.equal(position.side, "left");
  assert.equal(position.x, 12);
  assert.equal(position.y, bounds.maxY);
  assert.ok(position.y + TAB_HEIGHT < 844 - MID_SHEET - 22, "above the credit's margin");
});

test("1.4 a right-side placement clears the control row", () => {
  const bounds = area();
  const position = resolveCuratedTabPosition(bounds, { side: "right", ratio: 1 });
  assert.equal(position.side, "right");
  assert.equal(position.x, bounds.maxX);
  assert.ok(position.y >= MAP_CONTROL_COLUMN_BOTTOM_PX + 8, "right edge starts below the controls");
  // On a stage with no room below the controls, the right edge falls back left.
  const short = area({ sheetVisiblePx: 560 });
  assert.equal(short.rightAvailable, false);
  assert.equal(resolveCuratedTabPosition(short, { side: "right", ratio: 0.5 }).side, "left");
});

// ---------------------------------------------------------------------------
// 2. Drag clamping
// ---------------------------------------------------------------------------

test("2.1 a drag is clamped to the four edges", () => {
  const bounds = area();
  const base = { area: bounds, stageWidth: 390, tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT };
  assert.deepEqual(clampCuratedTabDrag({ ...base, x: -500, y: -500 }), {
    x: bounds.minX,
    y: bounds.minY,
  });
  const bottomRight = clampCuratedTabDrag({ ...base, x: 10_000, y: 10_000 });
  assert.equal(bottomRight.x, bounds.maxX);
  assert.equal(bottomRight.y, bounds.maxY);
});

test("2.2 a drag into the control row is pushed below it, never over it", () => {
  const bounds = area();
  const clamped = clampCuratedTabDrag({
    area: bounds,
    stageWidth: 390,
    tabWidth: TAB_WIDTH,
    tabHeight: TAB_HEIGHT,
    x: bounds.maxX,
    y: 200,
  });
  assert.equal(clamped.x, bounds.maxX);
  assert.equal(clamped.y, MAP_CONTROL_COLUMN_BOTTOM_PX + 8);
});

test("2.3 when there is no room below, the drag stays left of the controls", () => {
  const bounds = area({ sheetVisiblePx: 560 }); // maxY 192 < 238
  const clamped = clampCuratedTabDrag({
    area: bounds,
    stageWidth: 390,
    tabWidth: TAB_WIDTH,
    tabHeight: TAB_HEIGHT,
    x: bounds.maxX,
    y: 200,
  });
  const columnLeft = 390 - 12 - 88;
  assert.ok(clamped.x + TAB_WIDTH <= columnLeft - 8, "the tab never overlaps the column");
  assert.ok(clamped.y + TAB_HEIGHT > MAP_CONTROL_COLUMN_TOP_PX);
});

// ---------------------------------------------------------------------------
// 3. Snapping and persistence
// ---------------------------------------------------------------------------

test("3.1 release snaps to the nearer edge", () => {
  const bounds = area();
  const base = { area: bounds, stageWidth: 390, tabWidth: TAB_WIDTH };
  assert.equal(snapCuratedTabPlacement({ ...base, x: 12, y: 300 }).side, "left");
  assert.equal(snapCuratedTabPlacement({ ...base, x: bounds.maxX, y: 300 }).side, "right");
  assert.equal(snapCuratedTabPlacement({ ...base, x: 195, y: 300 }).side, "right");
  // A right snap that cannot clear the controls falls back to the left edge.
  const short = area({ sheetVisiblePx: 560 });
  assert.equal(
    snapCuratedTabPlacement({ area: short, stageWidth: 390, tabWidth: TAB_WIDTH, x: short.maxX, y: 200 }).side,
    "left",
  );
});

test("3.2 the stored placement is portable: side + ratio, never pixels", () => {
  assert.equal(CURATED_TAB_STORAGE_KEY, "singgah.curatedTab");
  assert.match(tabSource, /JSON\.stringify\(next\)/);
  assert.match(tabSource, /side: parsed\.side === "right" \? "right" : "left",/);
  assert.match(tabSource, /Math\.min\(1, Math\.max\(0, parsed\.ratio\)\)/);
  // Round-trip: the same ratio lands on the same LEGAL position at any stage.
  const bounds = area();
  const placement = snapCuratedTabPlacement({
    area: bounds,
    stageWidth: 390,
    tabWidth: TAB_WIDTH,
    x: bounds.maxX,
    y: 300,
  });
  const first = resolveCuratedTabPosition(bounds, placement);
  const second = resolveCuratedTabPosition(area({ stageWidth: 360, stageHeight: 800, sheetVisiblePx: 336 }), placement);
  assert.equal(first.side, "right");
  assert.equal(second.side, "right");
  assert.ok(second.y <= 800 - 336 - CURATED_TAB_ATTRIBUTION_GUARD_PX - TAB_HEIGHT);
});

// ---------------------------------------------------------------------------
// 4. Tap vs drag, pointer capture, keyboard, reset
// ---------------------------------------------------------------------------

test("4.1 a tap toggles; a drag starts only past the documented threshold", () => {
  assert.equal(CURATED_TAB_DRAG_THRESHOLD_PX, 8);
  assert.equal(CURATED_TAB_HANDLE_THRESHOLD_PX, 2);
  assert.match(tabSource, /if \(!drag\.moved && Math\.hypot\(dx, dy\) <= threshold\) return;/);
  assert.match(tabSource, /const threshold = drag\.fromHandle \? CURATED_TAB_HANDLE_THRESHOLD_PX : CURATED_TAB_DRAG_THRESHOLD_PX;/);
  // Tap resolves on pointerup; the synthetic click is suppressed exactly once.
  assert.match(tabSource, /if \(!cancelled && drag\.onToggle\) \{/);
  assert.match(tabSource, /if \(suppressClickRef\.current\) \{\s*suppressClickRef\.current = false;\s*return;\s*\}/);
});

test("4.2 the gesture owns its pointer and does not leak to map/sheet/page", () => {
  assert.match(tabSource, /setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(tabSource, /onPointerMove=\{moveDrag\}/);
  assert.match(tabSource, /onPointerCancel=\{\(event\) => endDrag\(event, true\)\}/);
  assert.match(tabSource, /onLostPointerCapture=\{\(event\) => endDrag\(event, true\)\}/);
  // touch-action: none, plus the map below already locks one-finger pan and the
  // sheet handle is a different element.
  assert.match(tabSource, /touch-none/);
  assert.match(mapSource, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
  assert.match(mapSource, /dragging: !touchPrimary/);
});

test("4.3 keyboard: focusable, Enter/Space toggles, arrows move the tab", () => {
  assert.match(tabSource, /<button\s+data-curated-tab-toggle[\s\S]{0,300}type="button"/);
  assert.match(tabSource, /aria-pressed=\{pressed\}/);
  assert.match(tabSource, /onClick=\{handleToggleClick\}/);
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
    assert.ok(tabSource.includes(`event.key === "${key}"`), `${key} must move the tab`);
  }
  assert.match(tabSource, /CURATED_TAB_KEYBOARD_STEP_RATIO/);
  assert.match(tabSource, /const next: Placement = \{ side, ratio \};/);
});

test("4.4 reset lives ONLY on the grip double tap; the help panel has no action", () => {
  // Double tap on the grip is detected from the pointer sequence (touch-safe).
  assert.match(tabSource, /DOUBLE_TAP_MS = 350/);
  assert.match(tabSource, /if \(now - lastHandleTapRef\.current <= DOUBLE_TAP_MS\)/);
  assert.match(tabSource, /resetPlacement\(\)/);
  assert.match(tabSource, /sessionStorage\.removeItem\(CURATED_TAB_STORAGE_KEY\)/);
  // 2026-10-23: placement is session-scoped; an old localStorage value is
  // never read or written.
  assert.doesNotMatch(tabSource, /localStorage\.(?:get|set|remove)Item/);
  assert.match(tabSource, /sessionStorage\.getItem\(CURATED_TAB_STORAGE_KEY\)/);
  assert.match(tabSource, /sessionStorage\.setItem\(CURATED_TAB_STORAGE_KEY, raw\)/);
  assert.match(tabSource, /export function resetCuratedTabPlacement\(\)/);
  assert.match(tabSource, /notifyPlacementListeners\(\)/);
  // 2026-10-22: the reset BUTTON was removed from the "?" panel. The panel is
  // information only, so the double tap is the one and only reset control.
  const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
  assert.equal(home.includes("resetCuratedTabPlacement"), false, "no reset action in Home any more");
  assert.equal(home.includes("Kembalikan tab ke posisi awal"), false, "no reset button copy any more");
  assert.equal(home.includes("setCuratedTabResetNonce"), false);
});

test("4.5 the tab toggles BOTH ways; a drag never toggles", () => {
  const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
  assert.match(
    home,
    /const next = curatedOnly \? deactivateCuratedFilter\(\) : activateCuratedFilter\(\);/,
  );
  assert.match(home, /setCuratedOnly\(next\.curatedOnly\);/);
  assert.match(home, /setLiveOnly\(next\.liveOnly\);/);
  // The pressed state the tab renders is the real state, in both directions.
  assert.match(home, /pressed=\{curatedOnly\}/);
  assert.match(tabSource, /aria-pressed=\{pressed\}/);
  // A drag resolves to a SNAP and returns before the tap branch, so releasing
  // a drag can never call onToggle.
  const endDrag = tabSource.slice(tabSource.indexOf("const endDrag = useCallback"), tabSource.indexOf("const handleToggleClick"));
  assert.match(endDrag, /if \(drag\.moved && !cancelled && area && released\) \{[\s\S]*?return;/);
  assert.equal((endDrag.match(/onToggle\(\)/g) ?? []).length, 1, "only the tap branch toggles");
});

test("4.6 the tab hides at `full` and leaves no residue in the sheet", () => {
  assert.match(tabSource, /if \(stageHeight > 0 && sheetVisiblePx >= stageHeight\) return null;/);
  const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
  assert.equal(home.includes("CURATED_TAB_HANG_PX"), false);
  // The old sheet tab is gone; the header band keeps only the handle.
  assert.equal((home.match(/<CuratedMapTab/g) ?? []).length, 1);
  assert.equal((home.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length, 0);
});

// ---------------------------------------------------------------------------
// 5. OSM attribution — still there, smaller, no Leaflet branding
// ---------------------------------------------------------------------------

test("5.1 the Leaflet prefix/flag is removed, the OSM credit and link remain", () => {
  assert.match(mapSource, /map\.attributionControl\.setPrefix\(false\);/);
  // The tile layer's own credit string is untouched: link, target, rel, name.
  assert.match(
    mapSource,
    /const OSM_ATTRIBUTION =\s*'&copy; <a href="https:\/\/www\.openstreetmap\.org\/copyright" target="_blank" rel="noreferrer">OpenStreetMap<\/a> contributors';/,
  );
  assert.match(mapSource, /attribution: OSM_ATTRIBUTION/);
});

test("5.2 the credit is 9–10px with a translucent, readable surface", () => {
  assert.match(css, /\.singgah-home-map \.leaflet-control-attribution \{[\s\S]*?font-size: 9\.5px;/);
  assert.match(css, /\.singgah-home-map \.leaflet-control-attribution \{[\s\S]*?background: rgb\(255 255 255 \/ 0\.82\);/);
  assert.match(css, /\.singgah-home-map \.leaflet-control-attribution \{[\s\S]*?padding: 1px 6px;/);
  assert.match(css, /\.singgah-home-map \.leaflet-control-attribution a \{\s*color: var\(--brand-primary\);/);
  // Still lifted above the visible sheet seam.
  assert.match(css, /\.singgah-home-map \.leaflet-bottom \.leaflet-control-attribution \{\s*margin-bottom: 22px;/);
});

// ---------------------------------------------------------------------------
// 6. Compass removed; the old map column is gone too
// ---------------------------------------------------------------------------

test("6.1 no compass and no old map control column survive", () => {
  const mapCode = mapSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.equal(mapCode.includes("Arah peta: utara ke atas"), false);
  assert.equal(mapCode.includes("compass"), false);
  assert.equal(mapCode.includes('role="img"\n'), false);
  assert.equal(css.includes("compass ("), false);
  // 2026-10-23: both tiles left the map. No overlay column, no leftover space.
  assert.doesNotMatch(mapSource, /absolute right-3 top-\[190px\]/);
  assert.doesNotMatch(mapSource, /onClick=\{onRequestLocate\}/);
  assert.doesNotMatch(mapSource, /data-gesture-hint-recall/);
  assert.equal(MAP_CONTROL_COLUMN_BOTTOM_PX, 230, "legacy geometry constant is unchanged");
  // The controls still exist on their new surfaces, with the same handlers.
  const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
  const nav = readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8");
  // 2026-10-25: TWO surfaces now carry the SAME handler — the filter row's
  // 44px cell and the no-location explainer's action. Both are the existing
  // path; no second locate implementation was introduced, which is what this
  // exact count keeps honest (a third would be a new path).
  assert.equal((home.match(/onClick=\{handleLocatePress\}/g) ?? []).length, 2);
  assert.equal((nav.match(/onClick=\{onShowGestureHint\}/g) ?? []).length, 1);
  assert.match(mapSource, /zoomControl: false/);
});
