import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * HOME RESULTS SHEET — short viewport + interaction wiring (2026-10-19).
 *
 * The audited commit (3cb4cc4) anchored a full-height sheet to a stage declared
 * `h-[100svh] min-h-[560px]`. On any visible height under 560px the stage was
 * taller than the screen, so the handle/sheet bottom sat below the fold. This
 * suite locks the repair and the interaction rules that were verified only by
 * inspection before:
 *
 *  - the stage is the visible viewport and has no trailing minimum;
 *  - snap offsets come from `resolveSheetOffsets` (the pure math is tested in
 *    home-sheet-snap-math.test.ts) and the measured height is not clamped up;
 *  - one pointer owns a drag; capture is released explicitly; a lost capture
 *    settles the sheet instead of leaving it mid-drag;
 *  - the list scrolls only in `full`, while the map keeps its touch gestures;
 *  - the handle stays focusable, named, and keyboard-operable;
 *  - OSM attribution and the floating map controls are never covered at
 *    small/mid, and the "Peta" button is the only exit from full;
 *  - marker ↔ card selection is scoped by Place id per row (no duplicate ids).
 *
 * Layout pixels at 360/390 cannot be measured by a source contract. The
 * spacing invariants those widths depend on (no fixed tab width, no wrap, the
 * tab and "Peta" in opposite corners, the control column above the mid snap)
 * are asserted instead; the pure snap math covers the vertical geometry.
 */

const discovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const ui = readFileSync(new URL("../lib/live/ui.ts", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = stripComments(discovery);
const mapCode = stripComments(map);

test("the stage follows the visible viewport instead of a 560px minimum", () => {
  assert.match(code, /className="relative h-\[100dvh\] overflow-hidden bg-brand-cream text-brand-ink"/);
  assert.doesNotMatch(code, /min-h-\[560px\]/);
  assert.doesNotMatch(code, /Math\.max\(320, node\.clientHeight\)/);
  assert.match(code, /setStageHeight\(Math\.max\(0, node\.clientHeight\)\)/);
  // Orientation changes and mobile browser chrome both re-measure.
  assert.match(code, /new ResizeObserver\(measure\)/);
  assert.match(code, /window\.addEventListener\("resize", measure\)/);
});

test("snap offsets use the shared, tested geometry and mid is the default", () => {
  assert.match(code, /resolveSheetOffsets\(stageHeight\)/);
  assert.match(ui, /export function resolveSheetOffsets\(stageHeightPx: number\)/);
  assert.match(code, /useState<SheetPosition>\("mid"\)/);
  assert.match(code, /const sheetOffset = dragOffset \?\? settledOffset;/);
  assert.match(code, /const sheetVisiblePx = Math\.max\(0, stageHeight - sheetOffset\)/);
});

test("one pointer owns the drag, and capture loss settles the sheet", () => {
  assert.match(code, /if \(dragRef\.current\) return;/);
  assert.match(code, /setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(code, /hasPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(code, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(code, /onPointerUp=\{endSheetDrag\}/);
  assert.match(code, /onPointerCancel=\{endSheetDrag\}/);
  assert.match(code, /onLostPointerCapture=\{endSheetDrag\}/);
  // The release point is authoritative, and a stale flick velocity cannot add
  // an extra snap after the finger has stopped.
  assert.match(code, /const releasedY = event\?\.clientY \?\? drag\.lastY;/);
  assert.match(code, /performance\.now\(\) - drag\.lastT > 100 \? 0 : drag\.velocity/);
  // The settle/flick decision is the shared, unit-tested helper.
  assert.match(code, /resolveSheetDrop\(\{/);
  assert.match(ui, /export function resolveSheetDrop\(input: \{/);
});

test("the sheet drag never becomes a page or list scroll", () => {
  assert.match(code, /className="inline-flex h-11 w-16 touch-none cursor-grab/);
  // The header handle owns the drag; the list is the only scroll surface, and
  // only when the sheet is full.
  assert.match(code, /sheetPosition === "full"\s*\? "overflow-y-auto overscroll-contain pb-24 pt-14"\s*: "overflow-hidden pb-8"/);
  // The map keeps its locked gesture split: one finger is not a pan on touch.
  assert.match(mapCode, /dragging: !touchPrimary/);
  assert.match(mapCode, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
});

test("the handle stays focusable, named, and keyboard-operable", () => {
  assert.match(code, /aria-label="Atur tinggi panel hasil"/);
  assert.match(code, /aria-expanded=\{sheetPosition === "full"\}/);
  assert.match(code, /onKeyDown=\{handleSheetKeyDown\}/);
  assert.match(code, /event\.key === "ArrowUp"/);
  assert.match(code, /event\.key === "ArrowDown"/);
  assert.match(code, /event\.key === "Home"/);
  assert.match(code, /event\.key === "End"/);
  assert.match(code, /event\.key === "Enter" \|\| event\.key === " "/);
  // Reduced motion removes the transform transition.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.singgah-sheet \{\s*transition: none;/);
});

test("OSM attribution and map controls stay above the visible sheet edge", () => {
  assert.match(code, /bottomInset=\{sheetVisiblePx\}/);
  assert.match(css, /\.singgah-home-map \.leaflet-bottom \{\s*bottom: var\(--singgah-sheet-inset, 0px\);/);
  assert.match(css, /\.leaflet-control-attribution \{\s*margin-bottom: 22px;/);
  assert.match(mapCode, /--singgah-sheet-inset": `\$\{Math\.max\(0, bottomInset\)\}px`/);
  // The control column is a fixed 40px pair ending at 278px; the mid geometry
  // test above proves the sheet top stays below it on the supported stages.
  assert.match(mapCode, /absolute right-3 top-\[190px\] z-\[1100\] flex flex-col items-center gap-2/);
});

test("the tab is one instance, stays attached to the sheet, and keeps LIVE exclusive", () => {
  assert.equal((code.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length, 1);
  assert.match(code, /const next = activateCuratedFilter\(\);/);
  assert.match(code, /setLiveOnly\(next\.liveOnly\)/);
  // Full: inside the header (top centre-left). Small/mid: hanging above the
  // seam. Either way it travels with the sheet, and "Peta" owns the opposite
  // bottom-right corner.
  // Full: the tab sits BELOW the 64px header (top-16) so it cannot overlap
  // the centred 64px handle at 360/390px; the list reserves pt-14 for it.
  assert.match(code, /sheetPosition === "full" \? "left-4 top-16" : "-top-11 left-4"/);
  assert.match(code, /absolute bottom-6 right-4 z-30 inline-flex min-h-11/);
  const tabAt = code.indexOf("aria-pressed={curatedOnly}");
  const tab = code.slice(tabAt - 900, tabAt + 900);
  assert.match(tab, /whitespace-nowrap/);
  assert.doesNotMatch(tab, /w-\[\d+px\]/, "the tab keeps its intrinsic width on 360/390px");
});

test("the only way out of full is the Peta control, which returns to mid", () => {
  assert.match(code, /\{sheetPosition === "full" && \(/);
  assert.match(code, /onClick=\{\(\) => setSheetSnap\("mid"\)\}/);
  assert.match(code, /aria-label="Kembali ke peta"/);
  assert.match(code, />\s*Peta\s*<\/button>/);
});

test("marker selection and card scroll are joined by the canonical Place id", () => {
  assert.match(code, /highlightedPlaceId=\{pressedPlaceId \?\? selectedPlaceId\}/);
  assert.match(code, /onSelectPlace=\{selectPlaceFromMap\}/);
  assert.match(code, /cardRefs\.current\.get\(`curated:\$\{pendingScrollPlaceId\}`\) \?\?/);
  assert.match(code, /cardRefs\.current\.get\(`discovery:\$\{pendingScrollPlaceId\}`\)/);
  assert.match(code, /cardRefs\.current\.set\(key, node\)/);
  // Row-scoped ids: a Place listed in both rows must not duplicate the id.
  assert.match(code, /id=\{`place-card-curated-\$\{place\.id\}`\}/);
  assert.match(code, /id=\{`place-card-discovery-\$\{place\.id\}`\}/);
  assert.equal((code.match(/id=\{`place-card-\$\{place\.id\}`\}/g) ?? []).length, 0);
  assert.match(code, /data-place-card-id=\{place\.id\}/);
});
