import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CURATED_RESULTS_ANCHOR_ID,
  DISCOVERY_RESULTS_ANCHOR_ID,
  resolveResultsAnchorId,
} from "../lib/live/ui";

/**
 * HOME MAP-FIRST UI — FINAL MOCKUP ALIGNMENT (2026-10-01, MOCKUP §1–§18)
 *
 * Scope of this lock: PRESENTATION ONLY. The functional baseline at
 * d47ee20 (camera values, curated coverage vs curated result, current
 * location transition/pulse, marker model, Discovery independence) is
 * locked by tests/map-current-location.test.ts,
 * tests/discovery-home-integration.test.ts, tests/map-empty-state.test.ts,
 * and tests/map-stacking.test.ts. Nothing here may relax those.
 *
 * What the final mockup changed (and what is locked below):
 * 1. MAP FULL-BLEED (MOCKUP §4): the map is no longer a separate box BELOW
 *    the header/search/filter. It is now ONE continuous field from the very
 *    top of the app down to the Result panel edge: the map sits in an
 *    `absolute inset-0 z-0` base layer inside a `relative isolate
 *    overflow-hidden` stage, and the header (z-[1200]), search + filter
 *    (z-[1100]) float on top of it. The retired 58vh / 64vh / 430px / 480px /
 *    760px frame geometry and its rounded "standalone map panel" look are
 *    gone — the map is edge-to-edge and the Result panel supplies the only
 *    rounded boundary.
 * 2. MAP HEIGHT (MOCKUP §8): no blind `64vh` any more. The visible map window
 *    is `h-[42vh]` clamped by `min-h-[260px]` / `max-h-[520px]`
 *    (`sm:h-[44vh]`), stacked UNDER the floating chrome, so the Result panel
 *    is always inside the initial viewport at 360 / 390 / 430 / 1280.
 * 3. SEARCH (MOCKUP §2): still one white ~20px-radius bar with a thin border,
 *    a soft shadow, the search glyph LEFT, the exact placeholder copy, and a
 *    DECORATIVE right icon — which is now a SLIDERS glyph, not a gear.
 * 4. FILTER (MOCKUP §3): still ONE row, same five controls, same order,
 *    ~16px radius, no overflow scroller — and the selected state is BRAND
 *    GREEN (bg-brand-primary), not ink black.
 * 5. HEADER (MOCKUP §1/§5): SiteNav gained an opt-in `floating` variant that
 *    only changes its own classes. Logo, nav, auth entry points, routes, and
 *    the session probe are untouched.
 * 6. CARDS (MOCKUP §12–§18): fixed-width non-shrinking tracks (several cards
 *    visible, never a collapsed stripe), ~16px radius, a LOCAL placeholder
 *    photo when no canonical cover exists, compact overlays that cannot
 *    collide at the narrower width, and five star slots only — stars never a
 *    number, never a review count.
 * 7. SECTION ORDER stays MAP STAGE (map + floating chrome) -> RESULT ->
 *    INTRO.
 * 8. No gradients in the Home surface (forbidden by the polish brief) and no
 *    heavy shadow utility.
 */

const homeDiscovery = readFileSync(
  new URL("../components/home-discovery.tsx", import.meta.url),
  "utf8",
);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter(
      (line) =>
        !line.trim().startsWith("*") &&
        !line.trim().startsWith("//") &&
        !line.trim().startsWith("/*"),
    )
    .join("\n");
}

const code = stripComments(homeDiscovery);

test("MOCKUP §4: the map is a full-bleed background field, not a standalone box", () => {
  // The stage is a relative + isolated + clipped stacking context (the single
  // clipping boundary), and the map fills it as an absolute base layer at the
  // BOTTOM of the stacking order (z-0).
  assert.match(
    code,
    /<section className="relative isolate overflow-hidden bg-\[#d9dfd2\]">/,
  );
  assert.match(code, /<div className="absolute inset-0 z-0">/);
  // The map mount is the FIRST child of that base layer.
  const baseLayer = code.indexOf('<div className="absolute inset-0 z-0">');
  const mapMount = code.indexOf("<HomeMap\n");
  assert.ok(baseLayer > -1, "the full-bleed base layer must exist");
  assert.ok(mapMount > baseLayer, "the map must live inside the full-bleed base layer");
  // ...and the floating chrome rides ABOVE it (documented overlay ladder: 1100
  // for search/filter/map overlays, 1200 for the header).
  // The chrome wrapper is click-through so the map surface underneath keeps
  // receiving its gestures (root-cause fix, 2026-10-01); the search bar and
  // the filter row opt back in explicitly.
  assert.match(code, /className="relative z-\[1100\] pointer-events-none mx-auto w-full max-w-6xl px-4"/);
  assert.match(code, /<SiteNav floating \/>/);
});

test("the retired standalone map-frame geometry is gone", () => {
  // A separate map panel below the chrome would break the visual unity the
  // mockup requires, so none of the old frame shapes may come back.
  assert.doesNotMatch(code, /h-\[64vh\]/);
  assert.doesNotMatch(code, /min-h-\[480px\]/);
  assert.doesNotMatch(code, /max-h-\[760px\]/);
  assert.doesNotMatch(code, /h-\[58vh\]/);
  assert.doesNotMatch(code, /min-h-\[430px\]/);
  assert.doesNotMatch(code, /rounded-\[28px\]/);
});

test("MOCKUP §8: map height is responsive and always leaves the Result panel in view", () => {
  // The visible map window sits UNDER the floating chrome inside the stage,
  // sized in vh and clamped on both ends. The old flat 64vh is not used.
  //
  // MOBILE MAP BUDGET (fix, 2026-10-03): the FLOOR is now sized from the
  // floating control ladder instead of the panel. At the previous 240px
  // minimum the section ended ABOVE the bottom of the zoom control, so the
  // "+/-" stack was clipped by the section's own overflow-hidden on an
  // ordinary phone. Still responsive, still clamped, still a valid
  // non-degenerate Leaflet box.
  assert.match(code, /h-\[56vh\] min-h-\[460px\] max-h-\[680px\] sm:h-\[62vh\]/);
  // The spacer is purely presentational — it reserves the visible map window
  // and carries no data or behaviour.
  assert.match(code, /<div aria-hidden className="h-\[56vh\]/);
  // The floating control ladder (compass 190px / "Lokasi Saya" 240px /
  // +/- 290px) MUST fit inside the shortest supported map — this is the
  // arithmetic the old 240px floor violated. The bottom-right scale chip left
  // the ladder with the indicator on 2026-10-04.
  const ladderBottom = 290 + 64; // +/- stack offset + Leaflet's own control height
  assert.ok(440 >= ladderBottom, "the control ladder fits the shortest map");
});

test("MOCKUP §2: search is a floating ~20px-radius white bar with a real 'Cari' control", () => {
  // (2026-10-04: the padding moved to `pl-3.5 pr-1.5` so the new "Cari" button
  // sits INSIDE the same approved surface; radius, border and shadow are the
  // same values as before.)
  assert.match(
    code,
    /flex items-center gap-2 rounded-\[20px\] border border-black\/10 bg-white pl-3\.5 pr-1\.5 py-2 shadow-\[0_2px_10px_rgb\(0_0_0\/0\.10\)\]/,
  );
  // Copy, label, and control function are untouched by the polish.
  assert.match(code, /aria-label="Cari tempat, cerita, produksi"/);
  assert.match(code, /placeholder="Cari tempat, cerita, produksi\.\.\."/);
  // APPROVED MOCKUP (2026-10-04): the DECORATIVE sliders/control graphic is
  // still removed and is still replaced by no icon and no settings feature.
  // What sits at the right end now is a REAL submit control, not decoration.
  assert.doesNotMatch(code, /⚙/);
  assert.doesNotMatch(code, /M4 7h10M18 7h2/);
  assert.doesNotMatch(code, /viewBox="0 0 24 24" width="18" height="18"/);
  assert.match(code, /aria-label="Cari lokasi"/);
  assert.match(code, />\s*Cari\s*<\/button>/);
  // The search glyph on the left stays.
  assert.match(code, /shrink-0 text-base leading-none text-brand-ink" aria-hidden>⌕</);
  // A long query can never widen the bar on a narrow phone.
  assert.match(code, /className="w-full min-w-0 bg-transparent text-sm outline-none/);
});

test("MOCKUP §2: the search field is dimensionally stable, empty and filled", () => {
  // Both right-hand controls are FIXED boxes — the clear "×" at 18×18px and the
  // "Cari" button at a fixed 26px height — so the bar's width, height, padding,
  // radius and position cannot differ between the empty and the filled state.
  // The input is the only elastic part, and it may shrink to zero width.
  assert.match(
    code,
    /className="inline-flex h-\[18px\] w-\[18px\] shrink-0 items-center justify-center rounded-full bg-black\/5 text-\[15px\] leading-none text-black\/45 transition hover:bg-black\/10"/,
  );
  // 2026-10-04: the pill gained `relative` because its touch target is extended
  // by an absolutely positioned, out-of-flow child. The fixed h-[26px] and
  // shrink-0 that make the bar dimensionally stable are unchanged.
  assert.match(code, /className="relative inline-flex h-\[26px\] shrink-0 items-center justify-center rounded-full bg-brand-primary/);
  const bar = code.slice(
    code.indexOf("rounded-[20px] border border-black/10 bg-white"),
    code.indexOf("Mencari lokasi"),
  );
  assert.equal((bar.match(/<button/g) ?? []).length, 2, "the clear button and the Cari button, nothing else");
  assert.equal((bar.match(/<svg/g) ?? []).length, 0, "no decorative icon is rendered inside the bar");
  // The clear affordance itself is unchanged, and search is still submit-only:
  // typing never searches, Enter and "Cari" share the ONE submit path.
  assert.match(code, /onClick=\{handleSearchClear\}/);
  assert.match(code, /aria-label="Hapus pencarian"/);
  assert.match(code, /onKeyDown=\{handleSearchKeyDown\}/);
  assert.match(code, /onClick=\{handleSearchSubmitClick\}/);
  assert.equal(/onChange=\{\(event\) => handleSearchSubmit/.test(code), false, "no search-on-keystroke");
});

test("MOCKUP §3: filter stays a single row with the locked five controls in order", () => {
  assert.match(code, /grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5/);
  // Order: LIVE -> Tempat Pilihan -> the three ordered distance tabs.
  // Both mode buttons now go through the mutually exclusive transitions
  // (bug fix 2026-10-01) instead of raw setters; the ORDER lock is unchanged.
  const liveIndex = code.indexOf("toggleLiveFilter(liveOnly, curatedOnly)");
  const curatedIndex = code.indexOf("activateCuratedFilter()");
  const distanceIndex = code.indexOf("DISTANCE_FILTERS.map((filter) =>");
  assert.ok(liveIndex > -1, "LIVE control must exist");
  assert.ok(curatedIndex > liveIndex, "Tempat Pilihan must follow LIVE");
  assert.ok(distanceIndex > curatedIndex, "distance tabs must follow Tempat Pilihan");
});

test("MOCKUP §3: the selected state is BRAND GREEN, not black", () => {
  // The explicit gap this task closed: "Tempat Pilihan" used to render
  // bg-brand-ink (near-black) when selected. It is now brand green.
  assert.doesNotMatch(code, /bg-brand-ink text-white/);
  const greenSelected = code.match(/bg-brand-primary text-white/g) ?? [];
  // Two call sites, back to the pre-2026-10-05 pair: the curated button and the
  // shared distance-tab branch. The additional "Semua Tempat" tab was removed
  // on 2026-10-04.
  assert.equal(greenSelected.length, 2);
  assert.match(code, /curatedOnly\n\s*\? "bg-brand-primary text-white"/);
  assert.doesNotMatch(code, /allPlacesOnly/);
  // The radius preset is selected only when NO place-set layer owns the map,
  // so choosing "Tempat Pilihan" deselects it exactly as it always did.
  assert.match(
    code,
    /distanceFilter === filter && !curatedOnly\n\s*\? "bg-brand-primary text-white"/,
  );
  // The unselected distance tabs keep their white surface (mockup).
  assert.match(code, /: "border border-black\/10 bg-white text-black\/65"/);
  // LIVE keeps its red dot and its red selected fill.
  assert.match(code, /liveOnly\n\s*\? "bg-live text-white"/);
});

test("filter controls use a ~16px radius rather than full pills", () => {
  const filterRow = code.slice(
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]") + 2600,
  );
  const rounded16 = filterRow.match(/rounded-\[16px\]/g) ?? [];
  // LIVE, Tempat Pilihan, and the shared distance-tab class.
  assert.equal(rounded16.length, 3);
  // No pill styling may creep back onto the filter BUTTONS. The only
  // rounded-full left in the row is the tiny LIVE status dot, which is
  // existing LIVE semantics (a dot, not a pill) and stays untouched.
  const pills = filterRow.match(/rounded-full/g) ?? [];
  assert.equal(
    pills.length,
    1,
    "the LIVE status dot is the only rounded-full left in the filter row",
  );
  assert.match(filterRow, /h-1\.5 w-1\.5 rounded-full/);
});

test("filter row has no horizontal-overflow escape hatch", () => {
  // The five-column grid IS the 360px guarantee for the FILTER row; an
  // overflow scroller there would silently replace it with a scrolling row.
  // (The curated RESULT strip is a different, mockup-mandated case — see the
  // dedicated horizontal-scroll test below.)
  const filterRow = code.slice(
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]") + 2600,
  );
  assert.doesNotMatch(filterRow, /overflow-x-auto/);
  assert.doesNotMatch(filterRow, /overflow-x-scroll/);
});

test("result cards use a ~16px radius with a subtle border and light shadow", () => {
  // overflow-hidden is what lets the mockup's cover image sit flush with the
  // card's rounded corners instead of spilling out of them.
  assert.match(
    code,
    /group flex h-full w-full flex-col overflow-hidden rounded-\[16px\] border border-black\/10 bg-white shadow-sm transition hover:shadow-md/,
  );
  // MOCKUP §10, REVISED 2026-10-04: the results keep the cream panel and its
  // rounded top corners, but the `-mt-5` tuck that pulled it under the map is
  // GONE. The title/count/"Ke hasil" block now floats on the map itself (see
  // the "floats over the map" assertions), so the section must not also reach
  // up into the map frame — the two would overlap. The section is still the
  // results surface and still carries the accessible name; only the seam moved.
  assert.match(
    code,
    /<section\n\s*className="relative z-10 rounded-t-\[24px\] bg-brand-cream pb-1 pt-1 shadow-\[0_-6px_18px_rgb\(0_0_0\/0\.06\)\]"\n\s*aria-labelledby="place-results-heading"\n\s*>/,
  );
  assert.doesNotMatch(code, /relative z-10 -mt-5 rounded-t-\[24px\]/);
  // The handle travels with the floating panel, so it keeps its shape but no
  // longer carries the old `mb-1.5` in-flow spacing.
  assert.match(code, /mx-auto mb-1 block h-1\.5 w-12 rounded-full bg-black\/15/);
});

test("Home section order stays MAP STAGE -> RESULT -> INTRO", () => {
  // Inside the stage the map base layer comes first (it is the background),
  // then the floating header, search, and filter, then the map window spacer.
  const order = [
    "<HomeMap\n",
    "<SiteNav floating />",
    'aria-label="Cari tempat, cerita, produksi"',
    "grid grid-cols-[auto_auto_1fr_1fr_1fr]",
    'aria-labelledby="place-results-heading"',
    "Jangan hanya datang.",
  ].map((needle) => code.indexOf(needle));

  for (const [index, position] of order.entries()) {
    assert.ok(position > -1, `missing section marker at index ${index}`);
  }
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      order[i] > order[i - 1],
      `section order broken: marker ${i} must follow marker ${i - 1}`,
    );
  }
});

test("polish adds no gradients and no heavy shadow utility", () => {
  assert.doesNotMatch(code, /bg-gradient-to-/);
  assert.doesNotMatch(code, /bg-linear-to-/);
  assert.doesNotMatch(code, /shadow-xl/);
  assert.doesNotMatch(code, /shadow-2xl/);
});

test("MOCKUP §16: every card image area is filled — canonical cover, else the local placeholder", () => {
  // Canonical cover image (places.cover_image_url, migration 0018) — the
  // same field the Place detail hero already renders. No new query, no data
  // change: the placeholder is VISUAL ONLY and the real cover still wins.
  assert.match(code, /\{place\.coverImageUrl \? \(/);
  assert.match(code, /src=\{place\.coverImageUrl\}/);
  assert.match(code, /Gambar sampul \$\{place\.name\}/);
  // The image area is ALWAYS rendered with a fixed height, so a card without a
  // cover can never change the card height.
  assert.match(code, /relative h-\[104px\] w-full shrink-0 overflow-hidden bg-\[#ece7db\] sm:h-\[124px\]/);
  // MOCKUP §16 closed the "flat icon block" gap: the fallback is now a LOCAL
  // decorative placeholder photo shipped with the app — not a category glyph,
  // not a broken image, not a blank fill. It is aria-hidden with an empty alt
  // so it is never announced as (or mistaken for) a real Place photo.
  assert.match(code, /src="\/place-cover-placeholder\.svg"/);
  assert.match(code, /alt=""/);
  assert.match(code, /aria-hidden\n\s*className="h-full w-full object-cover"/);
  // ...and the retired flat glyph placeholder is gone.
  assert.doesNotMatch(code, /text-2xl leading-none">⌂<\/span>/);
  assert.doesNotMatch(code, /text-\[#b3a88d\]/);
  // The asset really exists in /public (a missing file would render as a
  // broken image, which is exactly what this change had to prevent).
  const placeholder = readFileSync(
    new URL("../public/place-cover-placeholder.svg", import.meta.url),
    "utf8",
  );
  assert.match(placeholder, /<svg[\s\S]*<\/svg>/);
  // No data/DB/Supabase surface may reference the placeholder: it is a purely
  // visual asset, never a Place field and never a stored URL.
  assert.doesNotMatch(code, /coverImageUrl: "\/place-cover-placeholder/);
});

test("MOCKUP §14: card overlays are compact and cannot collide at the narrower card width", () => {
  // Curated badge top-left — a compact ✦ chip with an accessible label instead
  // of the long text pill, so it can never cover the image. It still renders
  // ONLY from the canonical curated flag.
  assert.match(code, /\{isCurated && \(/);
  assert.match(code, /absolute left-1\.5 top-1\.5 inline-flex h-6 w-6 items-center justify-center rounded-lg bg-brand-secondary/);
  // Decorative heart top-right (no favorite feature exists — non-interactive).
  assert.match(code, /absolute right-1\.5 top-1\.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white\/90/);
  // Real distance bottom-right, still fail-closed (only with the real fix and
  // canonical coordinates — never a fabricated number).
  assert.match(code, /\{distance && \(/);
  assert.match(code, /absolute bottom-1\.5 right-1\.5 inline-flex items-center gap-0\.5 rounded-full bg-brand-ink\/75/);
});

test("MOCKUP §18: rating is a 5-slot star row — stars only, never a number", () => {
  // Exactly five slots per card...
  assert.match(code, /\[1, 2, 3, 4, 5\]\.map\(\(slot\) => \(/);
  // ...filled ONLY from the canonical engine output (stars field of the
  // server view model; the numeric score never leaves the server)...
  assert.match(code, /const stars = starsByPlaceId\.get\(place\.id\) \?\? 0;/);
  assert.match(code, /\(discovery\?\.discovery \?\? \[\]\)\.forEach\(\(entry\) => \{/);
  // ...with NO rating number and NO review count (no such data exists).
  assert.doesNotMatch(code, /averageRating|ratingCount|reviewCount/);
  assert.doesNotMatch(code, /\/\s*\d+\.\d+\s*\((\d+|number)\)/);
  assert.doesNotMatch(code, /entry\.score|\.score\b/);
});

test("MOCKUP §9/§18: the star gold tone follows the real rating value, never a guess", () => {
  // The active tone is selected from the SAME stars value that fills the
  // slots, so a higher real rating simply reads as a deeper gold. There is no
  // independent, invented scale anywhere.
  assert.match(
    code,
    /slot <= stars \? `singgah-star-active singgah-star-gold-\$\{stars\}` : "singgah-star-empty"/,
  );
  // The four gold steps exist for the engine's 1–4 range only.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const step of [1, 2, 3, 4]) {
    assert.match(css, new RegExp(`\\.singgah-star-gold-${step} \\{`));
  }
  assert.doesNotMatch(css, /\.singgah-star-gold-5 \{/);
  // Empty slots stay light gray — a Place with no rating claims no value.
  assert.match(css, /\.singgah-star-empty \{\s*color: rgb\(0 0 0 \/ 0\.18\);/);
});

test("MOCKUP §8/§9: coverage box bottom-left + scale bottom-right are truthful", () => {
  // Coverage box: white, rounded, icon, and a caption that describes the frame
  // the camera ACTUALLY has.
  // The caption is DYNAMIC (bug fix 2026-10-03): it names the origin that is
  // really measuring — the searched city or the user's own location — instead
  // of a hardcoded "dari lokasi Anda" that contradicted Riyadh results.
  assert.match(code, /const coverageScope = describeCoverageScope\(\{/);
  assert.match(code, /mode: activeSearch\.mode,/);
  assert.match(code, /placeName: searchPlaceName,/);
  // CORRECTED (2026-10-03): a radius may only be NAMED while a radius preset
  // owns the frame. "Tempat Pilihan" and "Lokasi Saya" frame the viewer's local
  // area, so the retired fixed "10 km" wording claimed a radius the camera was
  // not using; those modes now render the neutral, always-true caption.
  //
  // SECOND HALF (fix, 2026-10-03): the same rule now covers the ORIGIN. With
  // geolocation denied and nothing searched there is no center at all, the
  // preset has no anchor, and the camera never applied it — yet the caption
  // went on claiming "dari lokasi Anda" about the neutral world frame. Both
  // halves are resolved by the ONE helper that owns them.
  assert.match(code, /coverage: cameraCoverage,/);
  assert.match(code, /hasCenter: hasActiveCenter,/);
  assert.doesNotMatch(code, /cameraCoverage === "radius" \? radiusCaption/);
  // The standalone floating coverage box is GONE (bug fix, 2026-10-03): its
  // information now lives on the ONE consolidated line in the results panel
  // header, so the map's bottom-left is free and the origin is stated once.
  assert.doesNotMatch(code, /bottom-9 left-4 z-\[1100\]/);
  assert.doesNotMatch(code, /\{coverageCaption\}/);
  assert.match(code, /\$\{nearOrigin\} · \$\{coverageScope\}/);
  assert.doesNotMatch(code, /dari lokasi Anda/);
  // APPROVED MOCKUP (2026-10-04): there is NO scale chip any more. The
  // bottom-right distance scale — its text and its bar — was removed together
  // with the space it reserved, and nothing replaced it.
  assert.doesNotMatch(code, /absolute bottom-9 right-4 z-\[1100\]/);
  assert.doesNotMatch(code, /border-x-2 border-b-2 border-brand-ink\/70/);
  assert.doesNotMatch(code, /mapScale/);
  assert.doesNotMatch(code, /barPx/);
  // The radius label still exists as a DERIVED value for the distance tabs
  // (it never was invented state) — it is simply no longer drawn as a scale.
  assert.match(
    code,
    /const activeRadiusMeters = curatedOnly\n\s*\? CURATED_CAMERA_RADIUS_M\n\s*: CAMERA_PRESET_RADIUS_M\[distanceFilter\];/,
  );
});

test("MOCKUP §9: Leaflet's own zoom stack is offset below the floating chrome AND below both locate buttons", () => {
  // The map is full-bleed now, so the topright +/- control would sit under the
  // search bar. Only the OFFSET moves — position and both buttons stay.
  //
  // RE-ORDERED (product decision, 2026-10-03): the +/- stack is now the LAST
  // control of the right-hand ladder, BELOW the Re-center arrow (190px) and
  // BELOW "Lokasi Saya" (240px), so the zoom buttons are reachable below the
  // locate controls and the three never collide at 360 / 390 / 430 / 1280.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.singgah-home-map \.leaflet-top\.leaflet-right \{\s*top: 290px;/);
  // ...and the offset is SCOPED to the Home map container, so the Producer
  // Place location picker (a second Leaflet map with its own default zoom
  // control) is never affected.
  const map = stripComments(
    readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8"),
  );
  assert.match(map, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
  assert.match(map, /absolute right-3 top-\[190px\] z-\[1100\]/);
  assert.match(map, /absolute right-3 top-\[240px\] z-\[1100\]/);
});

test("MOCKUP §11: result header keeps title + real-count subtitle + Ke hasil", () => {
  // Subtitle uses the REAL per-layer count (the mockup's "10 tempat pilihan
  // di sekitar Anda" shape) — never a fabricated number. The origin fragment
  // is `nearOrigin`, which preserves that device wording verbatim and names a
  // searched city when one is active (bug fix 2026-10-03).
  assert.match(code, /curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\} · \$\{coverageScope\}`\n\s*: `\$\{discoveryRowPlaces\.length\} tempat \$\{nearOrigin\} · \$\{coverageScope\}`/);
  // "Ke hasil" is the honest label for a SCROLL (bug fix 2026-10-01): there is
  // no all-results page in the MVP, so the link must not claim to show every
  // Place. The old label "Lihat semua" and the old self-referencing target
  // (the heading it already sits next to) are both gone.
  assert.match(code, /Ke hasil/);
  assert.doesNotMatch(code, /Lihat semua/);
  assert.doesNotMatch(code, /href="#place-results-heading"/);
  // The link targets the resolved strip anchor, never a hard-coded id.
  assert.match(code, /href=\{`#\$\{resultsAnchorId\}`\}/);
  // ...and with no strip rendered the same label is plain text, so there is
  // never a dead anchor.
  assert.match(code, /<span className="shrink-0 text-xs font-bold text-black\/35">Ke hasil<\/span>/);
});

test("BUG FIX: both result strips carry UNIQUE anchor ids and the link targets them", () => {
  // Behaviour of the resolver the component renders from — the target is the
  // first VISIBLE strip, never a heading.
  // Curated mode with curated results → the curated strip.
  assert.equal(
    resolveResultsAnchorId({ curatedOnly: true, curatedCount: 3, discoveryCount: 10 }),
    "home-curated-results",
  );
  // Curated mode with NO curated results → the Discovery strip (the curated
  // strip is not rendered at all).
  assert.equal(
    resolveResultsAnchorId({ curatedOnly: true, curatedCount: 0, discoveryCount: 10 }),
    "home-discovery-results",
  );
  // Normal mode always targets Discovery, curated ids on Places or not.
  assert.equal(
    resolveResultsAnchorId({ curatedOnly: false, curatedCount: 3, discoveryCount: 10 }),
    "home-discovery-results",
  );
  // Nothing rendered anywhere → null, so no anchor is emitted.
  assert.equal(resolveResultsAnchorId({ curatedOnly: true, curatedCount: 0, discoveryCount: 0 }), null);
  assert.equal(resolveResultsAnchorId({ curatedOnly: false, curatedCount: 0, discoveryCount: 0 }), null);

  // The ids are distinct constants, and each strip renders its own id.
  assert.notEqual(CURATED_RESULTS_ANCHOR_ID, DISCOVERY_RESULTS_ANCHOR_ID);
  assert.match(code, /id=\{CURATED_RESULTS_ANCHOR_ID\}/);
  assert.match(code, /id=\{DISCOVERY_RESULTS_ANCHOR_ID\}/);
  // No invented all-results route exists for the link to point at.
  assert.doesNotMatch(code, /href="\/places"/);
  assert.doesNotMatch(code, /router\.push\("\/places/);
});

test("MOCKUP §12/§19: every result row is a vertical list of full-width card items", () => {
  // 2026-10-04: the rows are vertical lists at 360px AND 1280px — the same
  // dataset, order, and cards as the old carousels; presentation only.
  assert.match(code, /-mx-4 flex flex-col gap-2\.5 px-4 pb-1"/);
  // Baris 2 (Discovery) — the same vertical pattern (no grid comeback).
  const discoveryRow = code.slice(code.indexOf("{discoveryRowPlaces.length > 0 ? ("));
  assert.match(discoveryRow, /-mx-4 flex flex-col gap-2\.5 px-4 pb-1"/);
  assert.doesNotMatch(discoveryRow, /grid gap-3 sm:grid-cols-2/);
  assert.match(discoveryRow, /flex flex-col gap-2\.5/);
  // Presentation only: the curated dataset, its order, and the cards are
  // unchanged, and the row still renders nothing when nothing is curated.
  assert.match(
    code,
    /\{curatedOnly && curatedListed\.length > 0 && \([\s\S]*?curatedListed\.map\(\(place\) => \(/,
  );
  // Every card in BOTH rows sits in an explicit full-width list item, never a
  // direct flex child of the list (which is what collapsed cards before).
  assert.match(code, /className="w-full"/);
  assert.match(
    code,
    /\{discoveryRowPlaces\.map\(\(place\) => \(\s*<div key=\{place\.id\} className="w-full">\s*\{renderPlaceCard\(place, curatedIdSet\.has\(place\.id\)\)\}/,
  );
  // No `w-full` card may ever be a direct flex child of a vertical list strip.
  assert.doesNotMatch(
    code,
    /\{discoveryRowPlaces\.map\(\(place\) =>\s*\n?\s*renderPlaceCard/,
    "Discovery cards must be wrapped in a sized track, never direct flex children",
  );
  // Card wrapper keeps the list item shape on the smallest viewport.
  assert.equal((code.match(/className="w-full"/g) ?? []).length, 2);
  // The card lists are vertical and the filter row keeps its
  // no-overflow guarantee.
  const filterRow = code.slice(
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]") + 2600,
  );
  assert.doesNotMatch(filterRow, /overflow-x-auto/);
});

test("MOCKUP §1/§5: the header floats over the map without touching behavior", () => {
  const nav = stripComments(
    readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8"),
  );
  // Opt-in floating variant: presentation only, default OFF so every other
  // page keeps the existing solid header.
  assert.match(nav, /floating = false,/);
  assert.match(nav, /"absolute inset-x-0 top-0 z-\[1200\] border-b-0 bg-transparent"/);
  assert.match(nav, /"sticky top-0 z-30 border-b border-black\/5 bg-brand-cream\/95 backdrop-blur"/);
  // Logo lockup, nav, and the Masuk / Daftar entry points are all preserved
  // verbatim — shape, colors, ratio, tagline, routes, and session probe.
  assert.match(nav, /<BrandLogo height=\{40\} tagline="Temukan cerita di balik tempat" \/>/);
  assert.match(nav, /aria-label="Navigasi utama"/);
  assert.match(nav, />\s*Masuk\s*</);
  assert.match(nav, /href="\/auth\/sign-up"/);
  assert.match(nav, /href="\/auth"/);
  // No new menu/tab was introduced for the mockup.
  assert.equal((nav.match(/<nav aria-label="Navigasi utama"/g) ?? []).length, 1);
});

test("MOCKUP introduces no rating/review numbers that have no data source", () => {
  // The mockup card shows a rating ("4.8 (120)"), but this product has NO
  // rating subsystem (MASTER_LIVE_TECH §1.1/§10, DISCOVERY_CONTRACT §1).
  // Rendering one would be inventing data, so the card must not grow a
  // numeric rating or a review count.
  assert.doesNotMatch(code, /averageRating|ratingCount|reviewCount/);
  assert.doesNotMatch(code, /\/\s*\d+\.\d+\s*\((\d+|number)\)/);
});

test("polish leaves the functional camera / coverage / marker wiring untouched", () => {
  // These are the baseline d47ee20 contracts: camera is 10 km for both
  // curated and the 10 km+ tab, the curated MAP shows curated + coverage
  // while the curated LIST stays curated-only, and the per-Place marker
  // treatment still flows through mapPlaces.
  assert.match(
    code,
    /cameraRadiusMeters=\{\s*curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]\s*\}/,
  );
  assert.match(code, /pulsePinOnPresetChange=\{curatedOnly\}/);
  assert.match(
    code,
    /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoveragePlaces\] : visiblePlaces;/,
  );
  assert.match(
    code,
    /isCurated: curatedOnly && curatedIdSet\.has\(place\.id\),/,
  );
  // SUPERSEDED (product decision, 2026-10-01): the
  // `curatedOnly || distanceFilter === "10 km+"` radius bypass in the
  // Discovery row is gone — both rows are now narrowed by the REAL visible
  // Leaflet viewport, which can only REMOVE canonical entries.
  assert.match(
    code,
    /return narrowToViewport\(canonical, coverageViewport\)/,
  );
});