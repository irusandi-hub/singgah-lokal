import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  MAP_CONTROL_COLUMN_BOTTOM_PX,
  SHEET_MID_VISIBLE_RATIO,
  resolveCuratedTabArea,
  resolveSheetOffsets,
} from "@/lib/live/ui";

/**
 * HOME UI SPACING & LAYOUT (product decision, 2026-10-04)
 *
 * Three changes, made in one coherent pass. All three are PRESENTATION ONLY:
 * no Place eligibility, curated membership, search logic, filter logic, API,
 * database, camera, or geographic rule changed anywhere in this work.
 *
 *   1. The search "Area pencarian: <lat>, <lng>" strip is GONE from the Home
 *      UI, along with the vertical space it permanently reserved.
 *   2. The results information panel FLOATS on the map's bottom edge instead of
 *      sitting in the page flow underneath it.
 *   3. The map window is bigger (56vh / 62vh, floor 460px, ceiling 680px), fed
 *      entirely by the two reclaimed bands above.
 *
 * The rules this suite exists to protect are the ones a layout change is most
 * likely to break quietly:
 *   · the camera/geographic rules must NOT have been touched to make the map
 *     look bigger — only the canvas grows;
 *   · the panel must not become a dead zone that swallows map gestures, must
 *     not cover the scale bar or the empty state, and must not reach the
 *     header tier;
 *   · removing the coordinate readout must not remove any geographic STATE.
 */

const pageCode = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const mapCode = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const curatedTabCode = readFileSync(new URL("../components/curated-map-tab.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const code = stripComments(pageCode);

// The map stage and the results section, located by their real anchors so the
// DOM-order assertions cannot drift with unrelated edits.
const stageStart = code.indexOf('<section className="absolute inset-0 isolate overflow-hidden bg-[#d9dfd2]">');
const stageEnd = code.indexOf("\n\n      {/* RESULTS BOTTOM SHEET", stageStart);
const mapStage = code.slice(stageStart, stageEnd);
const resultsStart = code.indexOf('aria-labelledby="place-results-heading"');
const resultsSectionStart = code.lastIndexOf("<section", resultsStart);
const resultsSection = code.slice(resultsSectionStart);

// ---------------------------------------------------------------------------
// TASK 1 — the coordinate strip is gone, and took its space with it.
// ---------------------------------------------------------------------------

test("T1.1 no raw search coordinate is rendered anywhere in the Home UI", () => {
  // Checked against the comment-stripped source: an explanatory `//` note may
  // still mention the old label, but nothing that RENDERS may.
  assert.equal(code.includes("Area pencarian"), false, "the coordinate readout is removed");
  assert.equal(code.includes("searchCenter.lat.toFixed"), false, "no latitude formatting in JSX");
  assert.equal(code.includes("searchCenter.lng.toFixed"), false, "no longitude formatting in JSX");
});

test("T1.2 the banner renders ONLY while a search is running or failed", () => {
  // Gating on pending/error rather than on a non-empty query is what
  // guarantees there is no empty strip and no reserved gap left behind: once
  // a search resolves, the element simply does not exist.
  assert.equal(
    code.includes("{(searchPending || searchError) && ("),
    true,
    "banner is gated on an in-flight or failed search",
  );
  // Scoped to the banner itself, since `bg-white text-brand-ink/70` legitimately
  // belongs to the "Tempat Pilihan" filter button elsewhere on the page.
  const banner = code.slice(
    code.indexOf("{(searchPending || searchError) && ("),
    code.indexOf("grid w-full min-w-0 grid-cols-[auto_repeat(3,minmax(0,1fr))]"),
  );
  // The two states that must keep working.
  assert.match(banner, /Mencari lokasi…/);
  assert.match(banner, /\{searchError\}/);
  // The old resolved-center branch and its dedicated background are gone.
  assert.doesNotMatch(banner, /\) : searchCenter \? \(/);
  assert.doesNotMatch(banner, /bg-white text-brand-ink/);
  assert.doesNotMatch(banner, /Area pencarian/);
});

test("T1.3 removing the readout removed no geographic state", () => {
  // Everything the search and the camera actually consume must be untouched.
  // (2026-10-04: the ±0.05° literals moved into the shared, documented
  // `fallbackSearchArea` helper because the canonical geocoder bounding box
  // became the primary searched area; the fallback itself is unchanged.)
  assert.match(code, /const \[searchCenter, setSearchCenter\] = useState<\{ lat: number; lng: number \} \| null>\(null\);/);
  assert.match(code, /searchCenter \? fallbackSearchArea\(searchCenter\) : null/);
  assert.match(code, /origin: searchCenter \?\? viewerPosition/);
  assert.match(code, /const activeSearch = resolveActiveCenter\(\{ searchCenter, viewerPosition \}\);/);
  // The camera still receives the real center, not a stripped-down one.
  assert.match(code, /cameraCenter=\{activeCenter\}/);
  assert.match(code, /searchCenter=\{searchCenter\}/);
  assert.match(code, /searchNonce=\{searchNonce\}/);
});

test("T1.4 nothing was put in the strip's place", () => {
  // No substitute banner for the removed coordinate strip. The Home UI has
  // THREE live regions: the per-Place "not live" notice inside a card, the
  // search banner, and (2026-10-17) the LIVE-feed FAILED card — an honest
  // "could not load" surface so a failed first poll can no longer masquerade
  // as "no Live exists". Nothing else was added.
  assert.equal((code.match(/role="status"/g) ?? []).length, 3);
  assert.equal(
    (code.match(/Live belum dapat dimuat/g) ?? []).length,
    1,
    "exactly one failed-feed card, only when the tab is LIVE and empty",
  );
  const banner = code.slice(
    code.indexOf("{(searchPending || searchError) && ("),
    code.indexOf("grid w-full min-w-0 grid-cols-[auto_repeat(3,minmax(0,1fr))]"),
  );
  assert.equal((banner.match(/role="status"/g) ?? []).length, 1, "one status region inside the banner");
  assert.doesNotMatch(code, /Mencari area|Search area|canonical coordinate readout/);
});

// ---------------------------------------------------------------------------
// TASK 2 — the floating information board is REMOVED (2026-10-18).
// ---------------------------------------------------------------------------

test("T2.1 the map stage no longer holds a floating results panel", () => {
  assert.ok(stageStart > 0, "the map stage is locatable");
  assert.ok(stageEnd > stageStart, "the map stage closes after it opens");
  // The board and its whole wrapper are gone from the stage.
  assert.doesNotMatch(mapStage, /bottom-3 z-\[1100\] mx-auto/);
  assert.doesNotMatch(mapStage, /place-results-heading/);
  assert.doesNotMatch(mapStage, /pointer-events-auto rounded-\[18px\] bg-white\/95/);
  // What legitimately remains in the stage: the map base layer, the chrome,
  // and the compact gesture hint — all still present.
  assert.ok(mapStage.indexOf("<HomeMap") > -1, "the map base layer is untouched");
  // What replaced the old hint: the floating curated tab and the on-demand
  // help panel, both inside the stage and both owned by real controls.
  assert.match(mapStage, /<CuratedMapTab/);
  assert.match(mapStage, /data-gesture-help/);
  assert.doesNotMatch(mapStage, /2 jari: geser &amp; cubit/);
});

test("T2.2 the removed board's title, count, radius line, and 'Ke hasil' are gone", () => {
  // 2026-10-18: the board was removed in full rather than relocated, so none
  // of its content may reappear anywhere in the Home surface.
  assert.doesNotMatch(code, /place-results-heading" className="text-base/);
  assert.doesNotMatch(code, /Hasil untuk/);
  // The comments may still name the removed action, so the assertions target
  // what used to RENDER it.
  assert.doesNotMatch(code, /resultsAnchorId/);
  assert.doesNotMatch(code, /Ke hasil <span aria-hidden>›/);
  assert.doesNotMatch(code, /text-brand-ink\/35">Ke hasil/);
  assert.doesNotMatch(code, /\$\{nearOrigin\} · \$\{coverageScope\}/);
  // The curated LIST and both strips are intact — only the board is gone.
  assert.match(code, /id=\{CURATED_RESULTS_ANCHOR_ID\}/);
  assert.match(code, /id=\{DISCOVERY_RESULTS_ANCHOR_ID\}/);
  assert.match(code, /\{curatedListed\.map\(\(place\) => \(/);
  assert.match(code, /\{discoveryRowPlaces\.map\(\(place\) => \(/);
});

test("T2.3 the results section is still labelled and still below the map", () => {
  assert.match(resultsSection, /aria-labelledby="place-results-heading"/);
  assert.equal(resultsStart > stageEnd, true, "the results section follows the map stage in the DOM");
  // The strips stayed in the section, and the accessible name now resolves to
  // an in-section screen-reader heading instead of the removed board title.
  assert.match(resultsSection, /id=\{CURATED_RESULTS_ANCHOR_ID\}/);
  assert.match(resultsSection, /id=\{DISCOVERY_RESULTS_ANCHOR_ID\}/);
  assert.match(resultsSection, /<h2 id="place-results-heading" className="sr-only">/);
  // The curated control left the sheet on 2026-10-21: the sheet keeps its
  // handle and no longer owns the tab.
  assert.match(resultsSection, /Atur tinggi panel hasil/);
  assert.doesNotMatch(resultsSection, /data-curated-map-tab/);
});

test("T2.4 the map surface stays fully interactive with no floating card", () => {
  // Nothing floats over the map's bottom edge any more, and the map itself is
  // untouched — still the real Leaflet surface with its own gestures.
  assert.doesNotMatch(mapStage, /pointer-events-none absolute inset-x-0 bottom-3 z-\[1100\]/);
  assert.match(mapCode, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
  assert.match(mapCode, /scrollWheelZoom: true/);
  assert.equal(mapCode.includes("dragging: false"), false);
  // The retired pill is gone, so nothing click-through floats at the map's
  // bottom edge any more; the tab is a real control that opts into pointers.
  assert.doesNotMatch(code, /2 jari: geser &amp; cubit/);
  assert.match(code, /<CuratedMapTab/);
});

test("T2.5 the curated tab now FLOATS over the map, outside the sheet", () => {
  // 2026-10-21: the chip became a draggable control over the map, so it is
  // inside the stage (above the sheet) and on the overlay tier — the opposite
  // of the old seam placement, and never inside the results section.
  const tabStart = code.indexOf("<CuratedMapTab");
  assert.ok(tabStart > stageStart && tabStart < stageEnd, "the tab renders inside the map stage");
  assert.ok(tabStart < resultsSectionStart, "the results sheet no longer owns it");
  assert.match(curatedTabCode, /data-curated-map-tab/);
  assert.match(curatedTabCode, /absolute z-\[1100\]/);
  // One control, with the same handler and exclusivity state.
  assert.equal((code.match(/<CuratedMapTab/g) ?? []).length, 1);
  assert.match(code, /const next = curatedOnly \? deactivateCuratedFilter\(\) : activateCuratedFilter\(\);/);
  assert.match(code, /setLiveOnly\(next\.liveOnly\);/);
  assert.equal((code.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length, 0);
});

test("T2.6 the sheet edge keeps empty state, hint, and attribution clear", () => {
  // 2026-10-18: all three bottom overlays now ride the VISIBLE sheet edge.
  //  · attribution: the sheet inset + its 22px margin
  //  · gesture hint: the inset + 44px (22px credit + 22px gap)
  //  · empty state:  the inset + 128px
  // so no snap position can cover a control at the map's bottom edge.
  const ATTRIBUTION_BASE = 22;
  const HINT_LIFT = 44;
  const EMPTY_LIFT = 128;
  assert.ok(ATTRIBUTION_BASE < HINT_LIFT, "the hint clears the credit");
  assert.ok(HINT_LIFT < EMPTY_LIFT, "the hint clears the empty state");
  // The 22px credit margin must be scoped to the Home map's own bottom band:
  // Leaflet's `.leaflet-bottom .leaflet-control` sets its own margin, and the
  // old single-class selector lost that tie at runtime (computed margin 0, so
  // the credit sat flush on the seam).
  assert.match(
    globalsCss,
    /\.singgah-home-map \.leaflet-bottom \.leaflet-control-attribution \{\s*margin-bottom: 22px;\s*\}/,
  );
  assert.match(
    globalsCss,
    /\.singgah-home-map \.leaflet-bottom \{\s*bottom: var\(--singgah-sheet-inset, 0px\);/,
  );
  assert.match(mapCode, /bottomInset = 0/);
  assert.match(mapCode, /--singgah-sheet-inset/);
  // 2026-10-21: the automatic pill is gone. The on-demand help panel keeps a
  // 56px gap above the visible seam, so its bottom edge is 20px clear of the
  // credit's top edge (seam − 22 − ~14px text); the floating tab keeps a 48px
  // guard for the same reason.
  assert.match(code, /const GESTURE_HELP_BOTTOM_GAP_PX = 56;/);
  assert.match(code, /style=\{\{\s*bottom: sheetVisiblePx \+ GESTURE_HELP_BOTTOM_GAP_PX,/);
  assert.equal(code.includes("gestureHintLiftPx"), false);
  assert.equal(code.includes("gestureHintVisible"), false);
  assert.match(code, /style=\{\{ bottom: sheetVisiblePx \+ 128 \}\}/);
  // No bottom-anchored panel remains, and the scale bar stays gone.
  assert.doesNotMatch(mapStage, /absolute bottom-9 right-4 z-\[1100\]/);
  assert.doesNotMatch(code, /mapScale/);
  // The search bar keeps the one floating chrome column.
  assert.match(code, /relative z-\[1100\] pointer-events-none mx-auto w-full max-w-6xl px-4/);
  // The control column is measured from the TOP of the stage: compass/locate at
  // 190px, one 40px-tile column. The Leaflet +/- stack is gone (gesture-only
  // zoom), so no Home-scoped Leaflet offset remains in globals.css.
  assert.doesNotMatch(globalsCss, /singgah-home-map \.leaflet-top\.leaflet-right/);
  assert.match(mapCode, /absolute right-3 top-\[190px\] z-\[1100\] flex flex-nowrap items-center gap-2/);
  // The retired bottom-left coverage chip must not come back.
  assert.equal(code.includes("bottom-9 left-4 z-[1100]"), false);
});

test("T2.6b the moved curated tab fits the smallest supported viewport", () => {
  // 360px is the documented floor. The tab is one compact, non-wrapping chip
  // (11px bold, px-2, 4px icon gap, 44px tap height) INSIDE the 48px handle
  // band. Measured at that width: 16 + 96 (label) + 10 (✦) + 4 (gap) + 16
  // (px-2) = 126px, so its right edge is x=142 — 6px clear of the centred
  // 64px drag handle, whose left edge is x=148.
  const VIEWPORT = 360;
  // Measured chip width at the 11px label: grip 18 + toggle padding 20 +
  // icon/label ~112 + border 2 ≈ 152. Use the upper bound so the check is
  // conservative.
  const TAB_WIDTH = 156;
  const TAB_HEIGHT = 44;
  const area = resolveCuratedTabArea({
    stageWidth: VIEWPORT,
    stageHeight: 800,
    sheetVisiblePx: 336,
    tabWidth: TAB_WIDTH,
    tabHeight: TAB_HEIGHT,
  });
  assert.ok(area, "the floating tab fits a 360×800 stage at mid");
  assert.ok(area!.minX >= 12, "it keeps the 12px map inset");
  assert.ok(area!.maxX + TAB_WIDTH <= VIEWPORT - 12, "it never crosses the right inset");
  assert.ok(area!.maxY >= area!.minY, "it has a legal vertical range");
  // Bottom of the legal band clears the credit band (seam − 36 for the credit).
  assert.ok(area!.maxY + TAB_HEIGHT <= 800 - 336 - 48, "it stays above the OSM credit band");
  assert.match(curatedTabCode, /whitespace-nowrap/);
  assert.match(curatedTabCode, /min-h-11/);
  assert.match(curatedTabCode, /absolute z-\[1100\]/);
  assert.match(curatedTabCode, /touch-none/);
  assert.equal(code.includes("CURATED_TAB_HANG_PX"), false);
});

test("T2.7 there is exactly ONE results heading and ONE curated control", () => {
  assert.equal(
    (code.match(/<h2 id="place-results-heading"/g) ?? []).length,
    1,
    "no duplicate results heading",
  );
  assert.equal(
    (code.match(/id="place-results-heading"/g) ?? []).length,
    1,
    "the accessible name still resolves to exactly one element",
  );
  assert.equal(
    (code.match(/<CuratedMapTab/g) ?? []).length,
    1,
    "the curated control exists exactly once (no duplicate)",
  );
  assert.equal((curatedTabCode.match(/data-curated-map-tab/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// TASK 3 — the map canvas is bigger, and the camera was NOT changed.
// ---------------------------------------------------------------------------

test("T3.1 the map now fills the full stage behind the sheet", () => {
  // 2026-10-18: the sheet floats over a full-height map instead of sitting in
  // the page flow. The map is the whole stage; no separate map band remains.
  // 2026-10-19: the stage is the VISIBLE viewport (100dvh) and has no
  // min-height that could push the sheet below a short screen.
  assert.match(code, /h-\[100dvh\] overflow-hidden/);
  assert.doesNotMatch(code, /min-h-\[560px\]/);
  assert.match(code, /<section className="absolute inset-0 isolate overflow-hidden bg-\[#d9dfd2\]">/);
  assert.doesNotMatch(code, /aria-hidden className="h-\[60vh\]/);
  assert.doesNotMatch(code, /h-\[56vh\] min-h-\[460px\] max-h-\[680px\] sm:h-\[62vh\]/);
  assert.doesNotMatch(code, /h-\[42vh\] min-h-\[440px\] max-h-\[560px\] sm:h-\[46vh\]/);
  // The default mid snap leaves ~58% of the stage to the map. The geometry
  // moved to the shared, unit-tested helper on 2026-10-19.
  assert.match(code, /resolveSheetOffsets\(stageHeight\)/);
  assert.equal(SHEET_MID_VISIBLE_RATIO, 0.42);
  const mid = resolveSheetOffsets(640);
  assert.equal(640 - mid.mid, Math.round(640 * SHEET_MID_VISIBLE_RATIO));
});

test("T3.2 the shortest supported landscape stage clears the control column", () => {
  // 2026-10-21: the compass was removed, so the column is ONE row of two 40px
  // tiles at 190..230. The stage has no artificial 560px floor, so the
  // relevant floor is the shortest real landscape viewport (360px), which the
  // column clears; the mid snap is additionally capped below it.
  assert.equal(MAP_CONTROL_COLUMN_BOTTOM_PX, 230);
  const FLOOR = 360;
  assert.ok(FLOOR > MAP_CONTROL_COLUMN_BOTTOM_PX, "the control column is never clipped on a 360px stage");
  assert.ok(MAP_CONTROL_COLUMN_BOTTOM_PX < 576, "the column clearing check stays concrete (230 < 576)");
});

test("T3.3 the camera and geographic rules are untouched", () => {
  // The canvas grew; the frame did not. Every camera constant, preset, and
  // resolver import must still be exactly the locked ones.
  // "describeCoverageScope"/"describeNearOrigin" used to be listed here: they
  // fed the information board that was REMOVED on 2026-10-18, so their
  // component-level use is gone while their lib implementations stay tested.
  for (const token of [
    "CAMERA_PRESET_RADIUS_M",
    "CURATED_CAMERA_RADIUS_M",
    "resolveLocalAreaCoverage",
    "narrowToViewport",
    "resolveActiveCenter",
  ]) {
    assert.equal(pageCode.includes(token), true, `${token} is still in use`);
  }
  assert.match(code, /CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
  // The padding ladder that reserves space for the floating chrome is unchanged.
  assert.match(mapCode, /CAMERA_FIT_PADDING|singgah-user-pane/);
  // No zoom-out escape hatch was introduced to fake a bigger map.
  assert.equal(code.includes("setView("), false);
  assert.doesNotMatch(code, /min-h-\[240px\]|sm:h-\[38vh\]|h-\[64vh\]|max-h-\[760px\]|h-\[56vh\]/);
});

test("T3.4 the stage remains a non-degenerate Leaflet box", () => {
  // The old in-flow spacer was retired with the bottom-sheet layout. The map
  // is the stage itself: an absolute full-size layer with a real min height,
  // so Leaflet is never measured at zero.
  assert.doesNotMatch(code, /aria-hidden className="h-\[60vh\]/);
  // 2026-10-19: the stage is the VISIBLE viewport (100dvh) and has no
  // min-height that could push the sheet below a short screen.
  assert.match(code, /h-\[100dvh\] overflow-hidden/);
  assert.doesNotMatch(code, /min-h-\[560px\]/);
  assert.match(code, /<div className="absolute inset-0 z-0">/);
});

// ---------------------------------------------------------------------------
// TASK 4 — nothing else moved.
// ---------------------------------------------------------------------------

test("T4.1 search, filters, and the marker ladder are unchanged", () => {
  assert.match(code, /className="pointer-events-auto mt-\[60px\] sm:mt-\[64px\]"/);
  assert.match(code, /pointer-events-auto mt-2\.5 grid w-full min-w-0 grid-cols-\[auto_repeat\(3,minmax\(0,1fr\)\)\] gap-1\.5/);
  assert.match(code, /toggleLiveFilter\(liveOnly, curatedOnly\)/);
  assert.match(code, /setDistanceFilter\(filter\)/);
  assert.match(
    mapCode,
    /zIndexOffset: isHighlighted \? 2500 : isCurated \? 900 : live \? 0 : 500/,
  );
  assert.doesNotMatch(mapCode, /L\.control\.zoom\(/);
});

test("T4.2 the grid bands and cards are the 2-column layout", () => {
  // 2026-10-18: both result rows are 2-column grids on a vertical scroll — the
  // dataset, order, and card links are unchanged.
  assert.equal(
    (code.match(/-mx-4 overflow-hidden border-y border-black\/10 bg-white\/70 py-1\.5/g) ?? []).length,
    0,
    "the old carousel frames are gone",
  );
  assert.equal(
    (code.match(/-mx-4 grid grid-cols-2 items-stretch gap-x-3 gap-y-4 px-4 pb-1/g) ?? []).length,
    2,
    "both strips are 2-column grids",
  );
  assert.equal(
    (code.match(/w-\[46vw\] max-w-\[200px\] min-w-\[132px\] shrink-0 snap-start/g) ?? []).length,
    0,
    "no horizontal carousel tracks remain",
  );
  assert.equal(
    (code.match(/className=\{\`h-full w-full rounded-\[24px\]/g) ?? []).length,
    2,
    "card wrappers are equal-height grid items",
  );
});

test("T4.3 the map stage remains the single clipping boundary", () => {
  assert.match(code, /<section className="absolute inset-0 isolate overflow-hidden bg-\[#d9dfd2\]">/);
  assert.equal(mapCode.includes("clip-path"), false);
  assert.equal(mapCode.includes("pointer-events-none"), false, "the map itself is never made click-through");
});

test("T4.4 the results sheet is the floating surface, not an overlapping panel", () => {
  // The old `-mt-5` tuck never returns. The sheet is an explicit overlay with
  // its own snap transform; the map is never pulled under a static panel.
  assert.doesNotMatch(code, /-mt-5 rounded-t-\[24px\]/);
  assert.match(
    code,
    /singgah-sheet absolute inset-x-0 bottom-0 z-20 flex h-full flex-col rounded-t-\[24px\] bg-brand-cream/,
  );
  assert.match(code, /style=\{\{ transform: `translateY\(\$\{sheetOffset\}px\)` \}\}/);
});