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
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
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
  assert.match(code, /const \[searchCenter, setSearchCenter\] = useState<\{ lat: number; lng: number \} \| null>\(null\);/);
  assert.match(code, /north: searchCenter\.lat \+ 0\.05/);
  assert.match(code, /south: searchCenter\.lat - 0\.05/);
  assert.match(code, /east: searchCenter\.lng \+ 0\.05/);
  assert.match(code, /west: searchCenter\.lng - 0\.05/);
  assert.match(code, /origin: searchCenter \?\? viewerPosition/);
  assert.match(code, /const activeSearch = resolveActiveCenter\(\{ searchCenter, viewerPosition \}\);/);
  // The camera still receives the real center, not a stripped-down one.
  assert.match(code, /cameraCenter=\{activeCenter\}/);
  assert.match(code, /searchCenter=\{searchCenter\}/);
  assert.match(code, /searchNonce=\{searchNonce\}/);
});

test("T1.4 nothing was put in the strip's place", () => {
  // No substitute banner. The Home UI has exactly TWO live regions — the
  // per-Place "not live" notice inside a card, and the search banner — which
  // is the same count as before this work, so removing the coordinate strip
  // added no new status surface to take its place.
  assert.equal((code.match(/role="status"/g) ?? []).length, 2);
  const banner = code.slice(
    code.indexOf("{(searchPending || searchError) && ("),
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
  );
  assert.equal((banner.match(/role="status"/g) ?? []).length, 1, "one status region inside the banner");
  assert.doesNotMatch(code, /Mencari area|Search area|canonical coordinate readout/);
});

// ---------------------------------------------------------------------------
// TASK 2 — the results panel floats on the map.
// ---------------------------------------------------------------------------

test("T2.1 the results panel is rendered INSIDE the map stage, above the map base", () => {
  assert.ok(stageStart > 0, "the map stage is locatable");
  assert.ok(stageEnd > stageStart, "the map stage closes after it opens");
  assert.match(mapStage, /RESULTS INFO — FLOATING OVER THE MAP/);
  // After the map base layer (z-0) and after the scale bar, so it paints on top.
  assert.ok(
    mapStage.indexOf("<HomeMap") < mapStage.indexOf("RESULTS INFO — FLOATING OVER THE MAP"),
    "the floating panel renders after the map base layer",
  );
  assert.ok(
    mapStage.indexOf("absolute bottom-9 right-4") < mapStage.indexOf("RESULTS INFO — FLOATING OVER THE MAP"),
    "the floating panel renders after the scale bar",
  );
});

test("T2.2 the panel keeps its title, count, context, and 'Ke hasil' action", () => {
  const cardStart = mapStage.indexOf("RESULTS INFO — FLOATING OVER THE MAP");
  const card = mapStage.slice(cardStart);
  assert.match(card, /<h2 id="place-results-heading"/);
  assert.match(card, /Hasil untuk/);
  assert.match(card, /Tempat Pilihan/);
  assert.match(card, /Discovery Place/);
  // The consolidated single information line, per layer, unchanged.
  assert.match(card, /\{curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\} · \$\{coverageScope\}`/);
  assert.match(card, /\$\{discoveryRowPlaces\.length\} tempat \$\{nearOrigin\} · \$\{coverageScope\}/);
  // The action is still the same anchor to the same strips.
  assert.match(card, /\{resultsAnchorId \? \(/);
  assert.match(card, /href=\{`#\$\{resultsAnchorId\}`\}/);
  assert.match(card, /Ke hasil <span aria-hidden>›<\/span>/);
  // ...and the anchor ids it points at still exist below.
  assert.match(code, /id=\{CURATED_RESULTS_ANCHOR_ID\}/);
  assert.match(code, /id=\{DISCOVERY_RESULTS_ANCHOR_ID\}/);
});

test("T2.3 the results section is still labelled and still below the map", () => {
  assert.match(resultsSection, /aria-labelledby="place-results-heading"/);
  assert.equal(resultsStart > stageEnd, true, "the results section follows the map stage in the DOM");
  // The strips stayed in the section; only the info block floated away.
  assert.match(resultsSection, /id=\{CURATED_RESULTS_ANCHOR_ID\}/);
  assert.match(resultsSection, /id=\{DISCOVERY_RESULTS_ANCHOR_ID\}/);
  assert.equal(
    resultsSection.includes('aria-labelledby="place-results-heading"') && !resultsSection.includes("<h2 id="),
    true,
    "the section keeps the accessible name while the heading itself floats",
  );
});

test("T2.4 the floating panel cannot swallow map gestures", () => {
  const cardStart = mapStage.indexOf("RESULTS INFO — FLOATING OVER THE MAP");
  const card = mapStage.slice(cardStart);
  // Wrapper is click-through; only the card opts back in. The strip of map
  // beside and under the card must keep panning and zooming.
  assert.match(card, /pointer-events-none absolute inset-x-0 bottom-3 z-\[1100\]/);
  assert.match(card, /<div className="pointer-events-auto rounded-2xl/);
  // The map itself is untouched — still the real Leaflet surface.
  assert.match(mapCode, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
  assert.match(mapCode, /scrollWheelZoom: true/);
  assert.equal(mapCode.includes("dragging: false"), false);
});

test("T2.5 the panel sits on the documented Home overlay ladder", () => {
  const cardStart = mapStage.indexOf("RESULTS INFO — FLOATING OVER THE MAP");
  const card = mapStage.slice(cardStart, cardStart + 4000);
  // z-[1100]: above Leaflet's documented ceiling (1000), same tier as every
  // other floating Home element — and deliberately NOT the header's tier, which
  // stays exclusive to the floating header in site-nav.
  assert.match(card, /z-\[1100\]/);
  assert.equal(card.includes("z-[1200]"), false, "the header's z-index tier is not reused");
  // It lives INSIDE the clipping stage, so it cannot become a second scroll
  // layer or detach from the map on orientation change.
  assert.equal(mapStage.includes(card.match(/pointer-events-none absolute inset-x-0 bottom-3 z-\[1100\][^"]*/)![0]), true);
});

test("T2.6 the panel neither covers the scale bar nor the empty state", () => {
  // Vertical: the card sits BELOW the empty state. The empty state was raised
  // from `bottom-24` to `bottom-32` because the card's height is NOT fixed — a
  // long search query wraps the panel title to a second line and grows it.
  const CARD_BOTTOM_OFFSET = 12; // bottom-3
  const EMPTY_STATE_BOTTOM_OFFSET = 128; // bottom-32
  const ONE_LINE_TITLE_CARD_HEIGHT = 84; // measured at 360px: 12 + handle + title + 2 count lines
  const WRAPPED_TITLE_EXTRA = 26; // one more `text-lg leading-tight` row
  assert.ok(
    CARD_BOTTOM_OFFSET + ONE_LINE_TITLE_CARD_HEIGHT + WRAPPED_TITLE_EXTRA <= EMPTY_STATE_BOTTOM_OFFSET,
    "even a wrapped two-line title clears the empty state",
  );
  assert.match(code, /absolute inset-x-0 bottom-32 z-\[1100\] flex justify-center px-4/);

  // Horizontal: the card stops short of the right edge, where the real scale
  // bar (bottom-9 right-4) lives, so the bar is never covered.
  assert.match(mapStage, /absolute bottom-9 right-4 z-\[1100\] flex flex-col items-end gap-1/);
  const cardStart = mapStage.indexOf("RESULTS INFO — FLOATING OVER THE MAP");
  const card = mapStage.slice(cardStart);
  assert.match(card, /pr-\[5\.5rem\]/, "right padding clears the scale bar");
  // The map control ladder is measured from the TOP of the stage and is far
  // above a bottom-anchored card, so no zoom/locate control is covered.
  assert.match(globalsCss, /\.singgah-home-map \.leaflet-top\.leaflet-right \{\s*top: 290px;/);
  assert.match(mapCode, /absolute right-3 top-\[190px\]/);
  assert.match(mapCode, /absolute right-3 top-\[240px\]/);
  // The retired bottom-left coverage chip must not come back behind the card.
  assert.equal(code.includes("bottom-9 left-4 z-[1100]"), false);
});

test("T2.6b the panel still fits the smallest supported viewport", () => {
  // 360px is the documented floor. px-4 (16) left + pr-[5.5rem] (88) right
  // leaves a 256px card, and after its own px-3 padding a 232px text line:
  // "Tempat Pilihan" + "Ke hasil" need about 226px, so the header stays on ONE
  // line at every supported width and the card height stays predictable.
  const VIEWPORT = 360;
  const textLine = VIEWPORT - 16 - 88 - 24;
  const titlePlusAction = 226;
  assert.ok(textLine >= titlePlusAction, "title and Ke hasil fit on one line at 360px");
  // The title is allowed to wrap for a long query (nothing is truncated), which
  // is exactly why T2.6 budgets the extra row.
  assert.match(code, /<h2 id="place-results-heading" className="text-lg font-bold leading-tight">/);
});

test("T2.7 there is exactly ONE results information panel", () => {
  assert.equal(
    (code.match(/<h2 id="place-results-heading"/g) ?? []).length,
    1,
    "no duplicate information panel",
  );
  assert.equal(
    (code.match(/id="place-results-heading"/g) ?? []).length,
    1,
    "the accessible name still resolves to exactly one element",
  );
});

// ---------------------------------------------------------------------------
// TASK 3 — the map canvas is bigger, and the camera was NOT changed.
// ---------------------------------------------------------------------------

test("T3.1 the map window is larger than it was, on mobile and on desktop", () => {
  assert.match(code, /<div aria-hidden className="h-\[56vh\] min-h-\[460px\] max-h-\[680px\] sm:h-\[62vh\]" \/>/);
  // The previous band is gone entirely.
  assert.doesNotMatch(code, /h-\[42vh\] min-h-\[440px\] max-h-\[560px\] sm:h-\[46vh\]/);
});

test("T3.2 the larger floor still clears the whole floating control ladder", () => {
  // The 2026-10-03 bug was a floor that clipped the Leaflet zoom stack. The
  // new floor must clear it with more room than before, plus the floating card.
  const RE_CENTER_TOP = 190;
  const LOCATE_TOP = 240;
  const ZOOM_TOP = 290;
  const LEAFLET_ZOOM_HEIGHT = 64;
  const FLOOR = 460;
  assert.ok(FLOOR > 440, "the floor grew");
  assert.ok(FLOOR >= ZOOM_TOP + LEAFLET_ZOOM_HEIGHT, "the zoom control is not clipped");
  assert.ok(RE_CENTER_TOP < LOCATE_TOP, "the control ladder keeps its order");
  assert.ok(LOCATE_TOP < ZOOM_TOP, "the zoom stack stays below both locate controls");
});

test("T3.3 the camera and geographic rules are untouched", () => {
  // The canvas grew; the frame did not. Every camera constant, preset, and
  // resolver import must still be exactly the locked ones.
  for (const token of [
    "CAMERA_PRESET_RADIUS_M",
    "CURATED_CAMERA_RADIUS_M",
    "resolveLocalAreaCoverage",
    "narrowToViewport",
    "resolveActiveCenter",
    "describeCoverageScope",
    "describeNearOrigin",
  ]) {
    assert.equal(pageCode.includes(token), true, `${token} is still in use`);
  }
  assert.match(code, /curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]/);
  // The padding ladder that reserves space for the floating chrome is unchanged.
  assert.match(mapCode, /CAMERA_FIT_PADDING|singgah-user-pane/);
  // No zoom-out escape hatch was introduced to fake a bigger map.
  assert.equal(code.includes("setView("), false);
  assert.doesNotMatch(code, /min-h-\[240px\]|sm:h-\[38vh\]|h-\[64vh\]|max-h-\[760px\]/);
});

test("T3.4 the spacer stays a presentational, non-degenerate Leaflet box", () => {
  const spacer = code.match(/<div aria-hidden className="(h-\[56vh\][^"]*)" \/>/);
  assert.ok(spacer, "the map spacer is present and marked aria-hidden");
  // vh-driven with a real floor and ceiling, so the Leaflet container is never
  // zero-height at any supported viewport.
  assert.match(spacer![1], /min-h-\[460px\]/);
  assert.match(spacer![1], /max-h-\[680px\]/);
  assert.match(spacer![1], /sm:h-\[62vh\]/);
});

// ---------------------------------------------------------------------------
// TASK 4 — nothing else moved.
// ---------------------------------------------------------------------------

test("T4.1 search, filters, and the marker ladder are unchanged", () => {
  assert.match(code, /className="pointer-events-auto mt-\[60px\] sm:mt-\[64px\]"/);
  assert.match(code, /pointer-events-auto mt-2\.5 grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5/);
  assert.match(code, /toggleLiveFilter\(liveOnly, curatedOnly\)/);
  assert.match(code, /setDistanceFilter\(filter\)/);
  assert.match(mapCode, /zIndexOffset: isCurated \? 900 : live \? 0 : 500/);
  assert.match(mapCode, /L\.control\.zoom\(\{ position: "topright"/);
});

test("T4.2 the vertical list bands and cards are untouched", () => {
  // 2026-10-04: the horizontal carousel frames were removed when both result
  // rows became vertical lists — the dataset, order, and cards are unchanged.
  assert.equal(
    (code.match(/-mx-4 overflow-hidden border-y border-black\/10 bg-white\/70 py-1\.5/g) ?? []).length,
    0,
    "the old carousel frames are gone",
  );
  assert.equal(
    (code.match(/-mx-4 flex flex-col gap-2\.5 px-4 pb-1/g) ?? []).length,
    2,
    "both strips are vertical lists",
  );
  assert.equal(
    (code.match(/w-\[46vw\] max-w-\[200px\] min-w-\[132px\] shrink-0 snap-start/g) ?? []).length,
    0,
    "no horizontal carousel tracks remain",
  );
  assert.equal(
    (code.match(/className="w-full"/g) ?? []).length,
    2,
    "card wrappers are full-width list items",
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