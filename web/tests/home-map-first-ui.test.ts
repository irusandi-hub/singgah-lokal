import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * HOME MAP-FIRST UI POLISH (PO, 2026-09-30)
 *
 * Scope of this lock: PRESENTATION ONLY. The functional baseline at
 * d47ee20 (camera values, curated coverage vs curated result, current
 * location transition/pulse, marker model, Discovery independence) is
 * locked by tests/map-current-location.test.ts,
 * tests/discovery-home-integration.test.ts, tests/map-empty-state.test.ts,
 * and tests/map-stacking.test.ts. Nothing here may relax those.
 *
 * The polish intent: clean / premium / modern / compact / map-first /
 * subtle. The map is the primary visual element of Home; search, filter,
 * and results support it.
 *
 * Locked geometry and its responsive rationale:
 * 1. Map frame: h-[64vh] clamped by min-h-[480px] / max-h-[760px],
 *    ~24px radius, subtle border, light shadow, still a clipping boundary
 *    (relative + isolate + overflow-hidden). The clamp is what keeps the
 *    map dominant AND overflow-free at 360px and at 1280px desktop.
 * 2. Search: ~20px radius, compact vertical padding, subtle border, and
 *    NO heavy shadow.
 * 3. Filter: still ONE row, same five controls, same order, ~16px radius
 *    (not full pills), no horizontal-overflow escape hatch (no
 *    overflow-x-auto), because the grid columns are what guarantee 360px.
 * 4. Result cards: ~18px radius, subtle border, light shadow, and the
 *    results sit as a white panel with rounded top corners + a small
 *    centered handle that VISUALLY MERGES with the map above it (MOCKUP
 *    2026-10-01 §10/§11 — still a normal section in page flow, never an
 *    overlay covering the map surface). Cards carry an image area ALWAYS:
 *    the canonical cover wins, a neutral dummy area is the visual
 *    placeholder when no cover exists (MOCKUP §13 — replacing the previous
 *    fail-closed null render, per the explicit mockup contract).
 * 5. Section order stays HEADER -> SEARCH -> FILTER -> MAP -> RESULT ->
 *    INTRO.
 * 6. No gradients anywhere in the Home surface (forbidden by the polish
 *    brief), and no heavy shadow utility.
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

test("map frame is the primary Home visual element with a clamped height", () => {
  assert.match(
    code,
    /<section className="relative isolate h-\[64vh\] min-h-\[480px\] max-h-\[760px\] overflow-hidden rounded-\[24px\] border border-black\/10 bg-\[#d9dfd2\] shadow-sm">/,
  );
});

test("map frame remains a clipping boundary and the retired 58vh/430px/28px frame is gone", () => {
  // relative + isolate + overflow-hidden is the Leaflet stacking lock.
  assert.match(code, /relative isolate h-\[64vh\][^"]*overflow-hidden/);
  assert.doesNotMatch(code, /h-\[58vh\]/);
  assert.doesNotMatch(code, /min-h-\[430px\]/);
  assert.doesNotMatch(code, /rounded-\[28px\]/);
});

test("search surface is compact with a ~20px radius and no heavy shadow", () => {
  assert.match(
    code,
    /flex items-center gap-3 rounded-\[20px\] border border-black\/10 bg-white px-4 py-3 shadow-sm/,
  );
  // Copy, label, and control function are untouched by the polish.
  assert.match(code, /aria-label="Cari tempat, cerita, produksi"/);
});

test("filter stays a single row with the locked five controls in order", () => {
  assert.match(
    code,
    /<div className="mb-4 grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5 pb-1">/,
  );
  // Order: LIVE -> Tempat Pilihan -> the three ordered distance tabs.
  const liveIndex = code.indexOf("setLiveOnly((value) => !value)");
  const curatedIndex = code.indexOf("setCuratedOnly(true)");
  const distanceIndex = code.indexOf("DISTANCE_FILTERS.map((filter) =>");
  assert.ok(liveIndex > -1, "LIVE control must exist");
  assert.ok(curatedIndex > liveIndex, "Tempat Pilihan must follow LIVE");
  assert.ok(distanceIndex > curatedIndex, "distance tabs must follow Tempat Pilihan");
});

test("filter controls use a ~16px radius rather than full pills", () => {
  const rounded16 = code.match(/rounded-\[16px\]/g) ?? [];
  // LIVE, Tempat Pilihan, and the shared distance-tab class.
  assert.equal(rounded16.length, 3);
  // No pill styling may creep back onto the filter BUTTONS. The only
  // rounded-full left in the row is the tiny LIVE status dot, which is
  // existing LIVE semantics (a dot, not a pill) and stays untouched.
  const filterRow = code.slice(
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]") + 2600,
  );
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

test("result cards use an ~18px radius with a subtle border and light shadow", () => {
  // overflow-hidden is what lets the mockup's cover image sit flush with the
  // card's rounded corners instead of spilling out of them.
  assert.match(
    code,
    /group flex w-full flex-col overflow-hidden rounded-\[18px\] border border-black\/10 bg-white shadow-sm transition hover:shadow-md/,
  );
  // MOCKUP §10: the results are a white panel that visually merges with the
  // map (small negative margin + rounded top corners + centered handle).
  assert.match(
    code,
    /<section\n\s*className="relative z-10 -mt-5 rounded-t-\[24px\] bg-brand-cream pb-2 pt-3"\n\s*aria-labelledby="place-results-heading"\n\s*>/,
  );
  assert.match(code, /mx-auto mb-2\.5 block h-1\.5 w-12 rounded-full bg-black\/15/);
});

test("Home section order stays HEADER -> SEARCH -> FILTER -> MAP -> RESULT -> INTRO", () => {
  const order = [
    "<SiteNav />",
    'aria-label="Cari tempat, cerita, produksi"',
    "grid grid-cols-[auto_auto_1fr_1fr_1fr]",
    "h-[64vh] min-h-[480px]",
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

test("MOCKUP §2 search keeps its icon, copy, single compact surface, and the decorative right icon", () => {
  assert.match(
    code,
    /flex items-center gap-3 rounded-\[20px\] border border-black\/10 bg-white px-4 py-3 shadow-sm/,
  );
  // The existing search glyph and the exact placeholder copy are preserved,
  // plus the mockup's right-side settings/sliders icon — DECORATIVE only
  // (aria-hidden, non-interactive: no search-settings feature is invented).
  assert.match(code, /placeholder="Cari tempat, cerita, produksi\.\.\."/);
  assert.match(code, /<span aria-hidden className="shrink-0 text-lg text-black\/45">⚙<\/span>/);
});

test("MOCKUP 2026-10-01 §13: every card has an image area — cover wins, dummy is the placeholder", () => {
  // Canonical cover image (places.cover_image_url, migration 0018) — the
  // same field the Place detail hero already renders. No new query, no data
  // change: the dummy area is VISUAL ONLY and the real cover still wins.
  assert.match(code, /\{place\.coverImageUrl \? \(/);
  assert.match(code, /src=\{place\.coverImageUrl\}/);
  assert.match(code, /Gambar sampul \$\{place\.name\}/);
  // The image area is ALWAYS rendered — no cover means the neutral dummy
  // block (decorative category glyph, aria-hidden), never a card without an
  // image area (MOCKUP §13, replacing the previous ") : null}" fail-closed
  // render by explicit mockup contract).
  assert.match(code, /relative h-36 w-full shrink-0 overflow-hidden bg-\[#ece7db\]/);
  assert.match(code, /text-2xl leading-none">⌂<\/span>/);
  assert.match(code, /text-\[#b3a88d\]/);
  // MOCKUP §14: curated badge top-left, DECORATIVE heart top-right (no
  // favorite feature exists — non-interactive, aria-hidden), real distance
  // bottom-right and still fail-closed (only with the real fix + canonical
  // coordinates).
  assert.match(
    code,
    /\{isCurated && \(\s*<span className="absolute left-2 top-2 rounded-full bg-brand-secondary/,
  );
  assert.match(code, /absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-white\/90/);
  assert.match(
    code,
    /\{distance && \(\s*<span className="absolute bottom-2 right-2 rounded-full/,
  );
});

test("MOCKUP 2026-10-01 §16: rating is a 5-slot star row — stars only, never a number", () => {
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

test("MOCKUP 2026-10-01 §8/§9: coverage box bottom-left + scale bottom-right follow the ACTIVE radius", () => {
  // Coverage box: white, rounded, icon, and the truthful active radius.
  assert.match(code, /Menampilkan tempat dalam radius \{activeRadiusLabel\} dari lokasi Anda/);
  assert.match(code, /absolute bottom-6 left-4 z-\[1100\]/);
  // Scale: bottom-right with the bar; the label mirrors the same active
  // radius ("Tempat Pilihan" = 10 km, per the camera constants).
  assert.match(code, /absolute bottom-6 right-4 z-\[1100\]/);
  assert.match(code, /border-x-2 border-b-2 border-brand-ink\/70/);
  // The label derives from the EXACT preset that owns the camera — the same
  // constants, never an invented state.
  assert.match(
    code,
    /const activeRadiusMeters = curatedOnly\n\s*\? CURATED_CAMERA_RADIUS_M\n\s*: CAMERA_PRESET_RADIUS_M\[distanceFilter\];/,
  );
});

test("MOCKUP 2026-10-01 §11: result header keeps title + real-count subtitle + Lihat semua", () => {
  // Subtitle uses the REAL per-layer count (the mockup's "10 tempat pilihan
  // di sekitar Anda" shape) — never a fabricated number.
  assert.match(code, /curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan di sekitar Anda`\n\s*: `\$\{discoveryRowPlaces\.length\} tempat di sekitar Anda`/);
  // "Lihat semua" is a non-inventive affordance: it scrolls to the results
  // anchor — no all-results page exists to link to (nothing invented).
  assert.match(code, /href="#place-results-heading"/);
  assert.match(code, /Lihat semua/);
});

test("MOCKUP 2026-10-01 §12: every result row is a horizontal strip at every viewport", () => {
  // Baris 1 (curated) — same snap-strip at 360px AND 1280px.
  assert.match(
    code,
    /-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2/,
  );
  // Baris 2 (Discovery) — the same horizontal pattern (no grid comeback).
  const discoveryRow = code.slice(code.indexOf("{discoveryRowPlaces.length > 0 ? ("));
  assert.match(discoveryRow, /-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2/);
  assert.doesNotMatch(discoveryRow, /grid gap-3 sm:grid-cols-2/);
  // Presentation only: the curated dataset, its order, and the cards are
  // unchanged, and the row still renders nothing when nothing is curated.
  assert.match(
    code,
    /\{curatedOnly && curatedListed\.length > 0 && \([\s\S]*?curatedListed\.map\(\(place\) => \(/,
  );
  assert.match(code, /renderPlaceCard\(place, place\.isCurated\)/);
  // Card width keeps several cards visible on the smallest viewport.
  assert.match(code, /w-\[70vw\] max-w-\[300px\] shrink-0 snap-start/);
  // Only the card strips scroll horizontally; the filter row keeps its
  // no-overflow guarantee.
  const filterRow = code.slice(
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]"),
    code.indexOf("grid grid-cols-[auto_auto_1fr_1fr_1fr]") + 2600,
  );
  assert.doesNotMatch(filterRow, /overflow-x-auto/);
});

test("MOCKUP §1 header keeps the logo, nav, and Masuk untouched — spacing only", () => {
  const nav = stripComments(
    readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8"),
  );
  // Compact header spacing (py-4 -> py-3); the logo, the nav links, and the
  // Masuk / Daftar entry points are all preserved verbatim.
  assert.match(nav, /px-5 py-3/);
  assert.doesNotMatch(nav, /px-5 py-4/);
  assert.match(nav, /<BrandLogo height=\{40\} tagline="Temukan cerita di balik tempat" \/>/);
  assert.match(nav, /aria-label="Navigasi utama"/);
  assert.match(nav, />\s*Masuk\s*</);
  assert.match(nav, /href="\/auth\/sign-up"/);
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
  assert.match(
    code,
    /if \(curatedOnly \|\| distanceFilter === "10 km\+"\)/,
  );
});
