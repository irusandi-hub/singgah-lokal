import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const code = stripComments(pageCode);

// The map stage and the results section, located by their real anchors so the
// DOM-order assertions cannot drift with unrelated edits.
const stageStart = code.indexOf('<section className="relative isolate overflow-hidden bg-[#d9dfd2]">');
const stageEnd = code.indexOf("\n      </section>", stageStart);
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
  assert.match(mapStage, /Dua jari untuk geser/);
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
  assert.match(resultsSection, /aria-pressed=\{curatedOnly\}/);
});

test("T2.4 the map surface stays fully interactive with no floating card", () => {
  // Nothing floats over the map's bottom edge any more, and the map itself is
  // untouched — still the real Leaflet surface with its own gestures.
  assert.doesNotMatch(mapStage, /pointer-events-none absolute inset-x-0 bottom-3 z-\[1100\]/);
  assert.match(mapCode, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
  assert.match(mapCode, /scrollWheelZoom: true/);
  assert.equal(mapCode.includes("dragging: false"), false);
  // The gesture hint is click-through, so it cannot swallow the gesture it
  // describes either.
  assert.match(code, /pointer-events-none absolute bottom-12 left-3 z-\[1100\]/);
});

test("T2.5 the moved curated tab lives in the results sheet, on no overlay tier", () => {
  const tabStart = code.indexOf("aria-pressed={curatedOnly}");
  // The button's handler precedes its aria-pressed attribute, so the slice has
  // to reach BACK over the whole button, not only forward from the attribute.
  const tab = code.slice(tabStart - 900, tabStart + 600);
  assert.ok(tabStart > stageEnd, "the curated tab renders BELOW the map stage");
  assert.doesNotMatch(tab, /z-\[1100\]|z-\[1200\]/);
  // One control, with the same handler and exclusivity state.
  assert.match(tab, /activateCuratedFilter\(\)/);
  assert.match(tab, /setLiveOnly\(next\.liveOnly\);/);
  assert.equal((code.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length, 1);
});

test("T2.6 the cleared map bottom edge: empty state, hint, and attribution cannot collide", () => {
  // Vertical stack from the bottom of the map: attribution (22px offset), the
  // click-through gesture hint at bottom-12 (48px), the empty-state card at
  // bottom-32 (128px). Each band is clear of the next.
  const ATTRIBUTION_OFFSET = 22;
  const HINT_BOTTOM_OFFSET = 48; // bottom-12
  const EMPTY_STATE_BOTTOM_OFFSET = 128; // bottom-32
  assert.ok(ATTRIBUTION_OFFSET < HINT_BOTTOM_OFFSET, "the hint clears the credit");
  assert.ok(HINT_BOTTOM_OFFSET < EMPTY_STATE_BOTTOM_OFFSET, "the hint clears the empty state");
  assert.match(code, /absolute bottom-12 left-3 z-\[1100\]/);
  assert.match(code, /absolute inset-x-0 bottom-32 z-\[1100\] flex justify-center px-4/);
  // No bottom-anchored panel remains, and the scale bar stays gone.
  assert.doesNotMatch(mapStage, /absolute bottom-9 right-4 z-\[1100\]/);
  assert.doesNotMatch(code, /mapScale/);
  // The search bar keeps the one floating chrome column.
  assert.match(code, /relative z-\[1100\] pointer-events-none mx-auto w-full max-w-6xl px-4/);
  // The control column is measured from the TOP of the stage: compass/locate at
  // 190px, one 40px-tile column. The Leaflet +/- stack is gone (gesture-only
  // zoom), so no Home-scoped Leaflet offset remains in globals.css.
  assert.doesNotMatch(globalsCss, /singgah-home-map \.leaflet-top\.leaflet-right/);
  assert.match(mapCode, /absolute right-3 top-\[190px\] z-\[1100\] flex flex-col items-center gap-2/);
  // The retired bottom-left coverage chip must not come back.
  assert.equal(code.includes("bottom-9 left-4 z-[1100]"), false);
});

test("T2.6b the moved curated tab fits the smallest supported viewport", () => {
  // 360px is the documented floor. The tab is one compact, non-wrapping chip
  // (12px bold, px-3.5, min 44px tall) hanging on the sheet's top edge, so it
  // can neither wrap nor overflow at any supported width.
  const VIEWPORT = 360;
  const chipWidth = 28 + 8 + 4 + "Tempat Pilihan".length * 6.6;
  assert.ok(chipWidth < VIEWPORT - 32, "the tab fits inside a 360px viewport");
  const tabStart = code.indexOf("aria-pressed={curatedOnly}");
  const tab = code.slice(tabStart - 900, tabStart + 600);
  assert.match(tab, /whitespace-nowrap/);
  assert.match(tab, /min-h-11/);
  assert.match(tab, /absolute -top-11 left-4/);
  assert.match(tab, /text-xs font-bold/);
  assert.equal((tab.match(/<button/g) ?? []).length, 1, "one control on the seam");
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
    (code.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length,
    1,
    "the curated tab exists exactly once (no duplicate)",
  );
});

// ---------------------------------------------------------------------------
// TASK 3 — the map canvas is bigger, and the camera was NOT changed.
// ---------------------------------------------------------------------------

test("T3.1 the map window is larger than it was, on mobile and on desktop", () => {
  // VISUAL REFINEMENT (2026-10-05): the visible map window keeps growing —
  // 60vh (66vh from `sm:`), floor 470px, ceiling 700px — because "map
  // maximum visual presence within the existing layout" is the approved
  // direction. The height still comes ONLY from the reclaimed bands: the
  // floating panel got more compact in the same pass.
  assert.match(code, /<div aria-hidden className="h-\[60vh\] min-h-\[470px\] max-h-\[700px\] sm:h-\[66vh\]" \/>/);
  // The previous band is gone entirely.
  assert.doesNotMatch(code, /h-\[56vh\] min-h-\[460px\] max-h-\[680px\] sm:h-\[62vh\]/);
  assert.doesNotMatch(code, /h-\[42vh\] min-h-\[440px\] max-h-\[560px\] sm:h-\[46vh\]/);
});

test("T3.2 the larger floor clears the remaining control column", () => {
  // The zoom stack that used to define the ladder's bottom was removed on
  // 2026-10-18 (gesture-only zoom). The column now ends with "Lokasi Saya" at
  // 238..278, which the 470px floor clears with room to spare.
  const COMPASS_TOP = 190;
  const LOCATE_TOP = COMPASS_TOP + 40 + 8;
  const COLUMN_BOTTOM = LOCATE_TOP + 40;
  const FLOOR = 470;
  assert.ok(FLOOR > 460, "the floor keeps its size");
  assert.ok(FLOOR > COLUMN_BOTTOM, "the control column is never clipped");
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

test("T3.4 the spacer stays a presentational, non-degenerate Leaflet box", () => {
  const spacer = code.match(/<div aria-hidden className="(h-\[60vh\][^"]*)" \/>/);
  assert.ok(spacer, "the map spacer is present and marked aria-hidden");
  // vh-driven with a real floor and ceiling, so the Leaflet container is never
  // zero-height at any supported viewport.
  assert.match(spacer![1], /min-h-\[470px\]/);
  assert.match(spacer![1], /max-h-\[700px\]/);
  assert.match(spacer![1], /sm:h-\[66vh\]/);
});

// ---------------------------------------------------------------------------
// TASK 4 — nothing else moved.
// ---------------------------------------------------------------------------

test("T4.1 search, filters, and the marker ladder are unchanged", () => {
  assert.match(code, /className="pointer-events-auto mt-\[60px\] sm:mt-\[64px\]"/);
  assert.match(code, /pointer-events-auto mt-2\.5 grid w-full min-w-0 grid-cols-\[auto_repeat\(3,minmax\(0,1fr\)\)\] gap-1\.5/);
  assert.match(code, /toggleLiveFilter\(liveOnly, curatedOnly\)/);
  assert.match(code, /setDistanceFilter\(filter\)/);
  assert.match(mapCode, /zIndexOffset: isCurated \? 900 : live \? 0 : 500/);
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
    (code.match(/className="h-full w-full"/g) ?? []).length,
    2,
    "card wrappers are equal-height grid items",
  );
});

test("T4.3 the map stage remains the single clipping boundary", () => {
  assert.match(code, /<section className="relative isolate overflow-hidden bg-\[#d9dfd2\]">/);
  assert.equal(mapCode.includes("clip-path"), false);
  assert.equal(mapCode.includes("pointer-events-none"), false, "the map itself is never made click-through");
});

test("T4.4 the results section no longer overlaps the map", () => {
  // The old `-mt-5` tuck pulled the panel up under the map frame; the floating
  // card now owns that seam, so the two must not share it.
  assert.doesNotMatch(code, /relative z-10 -mt-5 rounded-t-\[24px\]/);
  assert.match(code, /relative z-10 rounded-t-\[24px\] bg-brand-cream/);
});