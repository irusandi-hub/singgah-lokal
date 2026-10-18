import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * APPROVED HOME/MAP MOCKUP — search field and floating results panel (2026-10-04).
 *
 * Three corrections are locked here, and they interlock:
 *
 *  1. THE SEARCH FIELD'S RIGHT END IS EMPTY. The decorative sliders/settings
 *     graphic is removed and replaced by nothing — no icon, no button, no
 *     filter. The search glyph on the left, the placeholder, and the
 *     submit-only Enter search are unchanged.
 *
 *  2. THE SEARCH FIELD IS DIMENSIONALLY STABLE. Width, height, padding, radius,
 *     position, and alignment must be identical in the empty and the filled
 *     state, so typing or clearing can never resize or shift it. The ONE
 *     conditional control (the clear "×") occupies a fixed 18×18 box — exactly
 *     the footprint the removed graphic had — which is what makes this true by
 *     construction rather than by coincidence.
 *
 *  3. THE FLOATING RESULTS PANEL MATCHES THE SEARCH FIELD. Same column, same
 *     cap, same padding: the panel's left and right edges are the search
 *     field's left and right edges at every supported width. The reserved strip
 *     the panel used to keep for the (now removed) distance scale is gone, and
 *     no substitute padding was introduced.
 */

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const pageCode = stripComments(homeDiscovery);

/** The floating chrome column the search bar lives in. */
const SEARCH_COLUMN = 'className="relative z-[1100] pointer-events-none mx-auto w-full max-w-6xl px-4"';

const bar = pageCode.slice(
  pageCode.indexOf("rounded-[18px] border border-black/5 bg-white"),
  pageCode.indexOf("Mencari lokasi"),
);

// ---------------------------------------------------------------------------
// 1. The search field's right end is empty.
// ---------------------------------------------------------------------------

test("no settings/filter graphic is rendered inside the search field", () => {
  assert.equal((bar.match(/<svg/g) ?? []).length, 0, "no icon of any kind on the right end");
  assert.doesNotMatch(bar, /M4 7h10M18 7h2/);
  assert.doesNotMatch(bar, /<circle cx="16"/);
  assert.doesNotMatch(pageCode, /viewBox="0 0 24 24" width="18" height="18"/);
  // The left search glyph, the placeholder, and the accessible name stay.
  assert.match(bar, /shrink-0 text-\[15px\] leading-none text-brand-ink\/70" aria-hidden>⌕</);
  assert.match(bar, /placeholder="Cari tempat, cerita, produksi\.\.\."/);
  assert.match(bar, /aria-label="Cari tempat, cerita, produksi"/);
});

test("the only controls in the bar are the existing clear '×' and the real 'Cari' submit", () => {
  // 2026-10-04: the "Cari" button is a REAL control that runs the one submit
  // path — not a decorative icon standing in for the removed settings graphic.
  // No decorative icon exists: the sliders SVG stays gone.
  assert.equal((bar.match(/<button/g) ?? []).length, 2);
  assert.match(bar, /aria-label="Hapus pencarian"/);
  assert.match(bar, /aria-label="Cari lokasi"/);
  assert.match(bar, /onClick=\{handleSearchSubmitClick\}/);
  // No filter/settings affordance appeared anywhere on the search surface.
  assert.doesNotMatch(pageCode, /aria-label="(Setelan|Filter|Pengaturan)/);
  assert.equal(/onClick=\{\(\) => set(ShowFilters|FiltersOpen)/.test(pageCode), false);
  // And the tab row — the one real filter surface — is unchanged in kind
  // (four columns since the curated tab moved below the map on 2026-10-18).
  assert.match(pageCode, /grid grid-cols-\[auto_1fr_1fr_1fr\] gap-1\.5/);
});

test("search stays submit-only: no search-on-keystroke", () => {
  assert.match(bar, /onKeyDown=\{handleSearchKeyDown\}/);
  assert.match(pageCode, /const handleSearchSubmit = useCallback\(async/);
  assert.doesNotMatch(bar, /onChange=\{\(event\) => handleSearchSubmit/);
  // Typing only updates the DRAFT query state; the rows read `submittedQuery`,
  // which only this submit path sets.
  assert.match(bar, /onChange=\{\(event\) => handleSearchChange\(event\.target\.value\)\}/);
  assert.match(pageCode, /const searchFiltered = useMemo\(\(\) => \{\s*const normalizedQuery = submittedQuery\.trim\(\)/);
});

// ---------------------------------------------------------------------------
// 2. Identical outer dimensions, empty and filled.
// ---------------------------------------------------------------------------

test("the bar's own box is a single, unconditional class list", () => {
  // Padding, radius, border, and shadow are on the flex row itself and are not
  // part of any conditional, so they cannot differ between states. (2026-10-04:
  // the padding moved to `pl-3.5 pr-1.5` so the two controls sit inside the
  // same approved surface rather than floating past it. VISUAL REFINEMENT
  // 2026-10-05: the surface geometry is unchanged; only the radius (18px, from
  // the shared ladder), the border weight (`black/5`), and the shadow moved.)
  assert.match(
    pageCode,
    /<div className="flex items-center gap-2 rounded-\[18px\] border border-black\/5 bg-white py-2 pl-3\.5 pr-1\.5 shadow-\[0_4px_16px_rgb\(0_0_0\/0\.08\)\] ring-1 ring-black\/\[0\.02\]">/,
  );
  // The row is the bar's only sized element: there is no second wrapper that
  // could change width with the query.
  assert.equal((bar.match(/rounded-\[18px\]/g) ?? []).length, 1);
});

test("the conditional control occupies a FIXED 18×18 box, so the bar never resizes", () => {
  // The removed graphic was 18×18. Keeping that exact footprint for the only
  // state-dependent element is what makes the empty and filled bars the same
  // height: the input's own line box governs in BOTH states.
  assert.match(
    bar,
    /className="inline-flex h-\[18px\] w-\[18px\] shrink-0 items-center justify-center rounded-full bg-black\/5 text-\[15px\] leading-none text-black\/40 transition hover:bg-black\/10"/,
  );
  // No padding-derived box (p-1) whose height depended on the glyph's own line
  // height, and no font-size that could differ from the removed SVG.
  assert.doesNotMatch(bar, /className="shrink-0 rounded-full bg-black\/5 p-1/);
});

test("a long query cannot widen the field or overflow a narrow phone", () => {
  // `w-full min-w-0` lets the input shrink below its content width inside the
  // flex row, so a long query can neither push the row wider nor scroll the
  // page horizontally at 360px.
  assert.match(bar, /className="w-full min-w-0 bg-transparent text-sm outline-none/);
  assert.match(pageCode, /mx-auto w-full max-w-6xl px-4/);
  // The clear button is shrink-0, so it is never the thing that gives way.
  assert.match(bar, /shrink-0 items-center justify-center/);
});

// ---------------------------------------------------------------------------
// 3. The results surface: no floating panel, one control in its band.
test("the 'Cari' control is usable on touch and by keyboard", () => {
  // 2026-10-04 (review): the pill is 26px tall, which reads fine on desktop but
  // is a small thumb target, and it had NO visible keyboard focus. Both are
  // fixed without touching layout, which is what the assertions below pin.
  //
  // The hit area is extended by an ABSOLUTELY positioned, out-of-flow child, so
  // the bar's height, padding, radius and position are untouched by it.
  assert.match(bar, /relative inline-flex h-\[26px\] shrink-0/);
  assert.match(bar, /aria-hidden\s*\n?\s*className="pointer-events-auto absolute -inset-x-1 -bottom-2 top-0"/);
  // DOWNWARD ONLY: the floating header is `absolute top-0` and already overlaps
  // the pill's top edge, so growing the target upward would steal taps meant
  // for the header controls. Asserted here so it cannot regress.
  assert.doesNotMatch(bar, /absolute -inset-y-2/);
  assert.doesNotMatch(bar, /absolute -top-2/);
  // A keyboard user can see where they are. The ring is used rather than an
  // outline because the browser's default outline resolved to WHITE on the
  // white bar and was invisible in the real rendered page.
  assert.match(bar, /focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black\/45/);
  assert.match(bar, /ring-offset-2/);
  // The pending state is a real disabled state, not only a visual one.
  assert.match(bar, /disabled=\{searchPending\}/);
  assert.match(bar, /disabled:opacity-60/);
});

test("the extended 'Cari' hit area cannot eat the bar's other controls", () => {
  // The overlay must stay inside the bar: the clear "×" sits immediately to
  // its left, so an oversized or full-width overlay would swallow the clear.
  const overlay = bar.slice(bar.indexOf("absolute -inset-x-1 -bottom-2"));
  assert.ok(overlay.indexOf("Hapus pencarian") === -1 || overlay.indexOf("Hapus pencarian") > 0);
  // It is decorative only — no label, no role, and it cannot be tabbed to.
  const spanStart = bar.lastIndexOf("<span", bar.indexOf("absolute -inset-x-1 -bottom-2"));
  const overlayTag = bar.slice(spanStart, bar.indexOf("/>", spanStart) + 2);
  assert.match(overlayTag, /^<span\s+aria-hidden/);
  assert.doesNotMatch(overlayTag, /tabIndex|role=/);
});

// ---------------------------------------------------------------------------

test("the floating results panel and its column are GONE", () => {
  // 2026-10-18: the "Tempat Pilihan" information board that floated on the
  // map's bottom edge was removed in full, so no bottom-anchored panel column
  // exists any more and the search column is the only floating chrome column.
  assert.ok(pageCode.includes(SEARCH_COLUMN), "the search column is unchanged");
  assert.equal(
    pageCode.includes('absolute inset-x-0 bottom-3 z-[1100] mx-auto w-full max-w-6xl px-4'),
    false,
    "no floating results panel column remains",
  );
  assert.doesNotMatch(pageCode, /resultsPanelRef/);
  assert.doesNotMatch(pageCode, /bottom-3 z-\[1100\] mx-auto/);
});

test("the reserved strip for the removed distance scale is gone", () => {
  const panel = pageCode.slice(pageCode.indexOf("absolute inset-x-0 bottom-3 z-[1100]"), pageCode.indexOf("</section>"));
  assert.doesNotMatch(panel.slice(0, 200), /pr-\[/, "no right padding is reserved for anything");
  assert.doesNotMatch(pageCode, /pr-\[5\.5rem\]/);
  // Nothing replaced the scale: no distance readout, bar, or measurement label
  // is rendered anywhere on the map stage.
  assert.doesNotMatch(pageCode, /mapScale|barPx|metersPerPixel/);
  assert.equal(pageCode.indexOf("bottom-9 right-4 z-[1100]"), -1);
});

test("the results sheet keeps the handle and the moved curated tab", () => {
  const sheetStart = pageCode.indexOf('className="relative z-10 rounded-t-[24px] bg-brand-cream');
  const sheet = pageCode.slice(sheetStart, pageCode.indexOf('id={CURATED_RESULTS_ANCHOR_ID}'));
  // The sheet keeps its cream surface, rounded top, and the small handle —
  // now at the sheet's own top edge rather than on a floating card.
  assert.match(sheet, /rounded-t-\[24px\] bg-brand-cream/);
  assert.match(sheet, /block h-1 w-10 rounded-full bg-black\/10/);
  // The board's title/count/radius/"Ke hasil" content is GONE (2026-10-18).
  assert.doesNotMatch(sheet, /place-results-heading" className="text-base/);
  assert.doesNotMatch(sheet, /nearOrigin|coverageScope|Ke hasil|resultsAnchorId/);
  // The section's accessible name survives as a screen-reader heading, and the
  // curated layer tab lives here — exactly once, with its documented handler.
  assert.match(sheet, /<h2 id="place-results-heading" className="sr-only">/);
  assert.equal((pageCode.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length, 1);
  assert.match(sheet, /activateCuratedFilter\(\)/);
});

test("the moved curated tab cannot overflow or wrap on a narrow phone", () => {
  const tabStart = pageCode.indexOf("aria-pressed={curatedOnly}");
  // The handler precedes the attribute, so the slice reaches back over the
  // whole button.
  const tab = pageCode.slice(tabStart - 700, tabStart + 500);
  // One compact, non-wrapping control — no fixed pixel width and no second
  // tab beside it.
  assert.match(tab, /whitespace-nowrap/);
  assert.doesNotMatch(tab, /w-\[\d+px\]/);
  assert.equal((tab.match(/<button/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// 4. The OSM attribution needs no panel-height lift any more
// ---------------------------------------------------------------------------

test("the OSM attribution keeps its base offset and no panel measurement remains", () => {
  // The board that covered the map's bottom edge is removed (2026-10-18), so
  // nothing can cover the credit and the measured/published lift is gone with
  // it. The attribution keeps the pre-existing 22px offset.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.leaflet-control-attribution \{\s*margin-bottom: 22px;\s*\}/);
  assert.doesNotMatch(css, /--singgah-results-panel-height/);
  assert.doesNotMatch(pageCode, /--singgah-results-panel-height/);
  assert.doesNotMatch(pageCode, /new ResizeObserver\(apply\)/);
  // The gesture hint sits ABOVE the attribution band (bottom-12 = 48px, vs the
  // credit's 22px offset + its own line), so it can never cover it either.
  assert.match(pageCode, /absolute bottom-12 left-3 z-\[1100\][\s\S]{0,220}Dua jari untuk geser/);
  // The attribution itself is untouched: Leaflet's own control, fed by the
  // tile layer's OSM attribution string (pinned in live-hardening /
  // map-local-area-coverage) — never removed or replaced.
});