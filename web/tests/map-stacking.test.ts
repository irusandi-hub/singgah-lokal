import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * MAP STACKING ARCHITECTURE (root-cause fix, 2026-09-25)
 *
 * Evidence chain (verified against the shipped leaflet 1.9.4 sources):
 * 1. leaflet.css gives Leaflet panes/controls high z-indexes inside the map:
 *    .leaflet-tile-pane z-index:200, .leaflet-map-pane z-index:400,
 *    .leaflet-tooltip-pane 650, .leaflet-control-container 800,
 *    .leaflet-control 800/1000.
 * 2. leaflet-src.js _initLayout(): if the container has no
 *    position:absolute|relative|fixed|sticky, Leaflet sets ONLY
 *    container.style.position = 'relative' — no z-index. A positioned
 *    element with z-index:auto creates NO stacking context, so every
 *    Leaflet pane z-index competes DIRECTLY with sibling React overlays in
 *    the map frame's stacking context.
 * 3. The React overlays used to sit at z-10/z-20 — below tile pane 200 —
 *    so after a strong mobile drag the tiles painted OVER the
 *    "Belum ada Place..." empty-state card.
 *
 * The architecture that must stay locked:
 * - The Leaflet container is a CLOSED stacking context (relative + z-0), so
 *   ALL Leaflet panes are trapped at the base layer of the map frame.
 * - React overlays use an explicit ladder ABOVE Leaflet's documented
 *   ceiling (max control z-index = 1000): 1100 for badges/cards/locate
 *   button, 1200 for the bottom sheet.
 * - The map frame stays the single clipping boundary (relative + isolate +
 *   overflow-hidden) and no masking/pseudo-element workaround is used.
 *
 * MOCKUP 2026-10-01 (§4/§5): the frame became the FULL-BLEED Home map stage —
 * the map moved into an `absolute inset-0 z-0` base layer and the header,
 * search, and filter now float above it. The ladder is unchanged: map 0,
 * React overlays 1100, floating header 1200 (in site-nav.tsx).
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const leafletCss = readFileSync(new URL("../node_modules/leaflet/dist/leaflet.css", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

test("Leaflet 1.9.4 pane z-indexes exceed the old React overlay ladder (root-cause evidence)", () => {
  // The bug can only exist if Leaflet panes/controls actually carry
  // z-indexes above the old overlay values (z-10/z-20) — this pins the
  // evidence so the test fails loudly if the Leaflet version's behavior
  // changes underneath us.
  assert.match(leafletCss, /\.leaflet-tile-pane\s*\{\s*z-index:\s*200;/);
  // The map pane's z-index 400 comes from the shared .leaflet-pane rule.
  assert.match(leafletCss, /\.leaflet-pane\s*\{\s*z-index:\s*400;/);
  assert.match(leafletCss, /\.leaflet-control\s*\{[\s\S]*?z-index:\s*800;/);
  assert.match(leafletCss, /\.leaflet-top,\s*\.leaflet-bottom\s*\{[\s\S]*?z-index:\s*1000;/);
});

test("Map container is a closed stacking context that traps every Leaflet pane", () => {
  const mapCode = stripComments(homeMap);
  // relative + z-0 on the SAME element that owns the Leaflet instance:
  // Leaflet's _initLayout then skips its inline position:relative (it only
  // sets position when none exists) and — crucially — z-0 forces a stacking
  // context, so tile/map/tooltip/control panes (200–1000) can never climb
  // above sibling React overlays.
  assert.match(mapCode, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
});

test("React map overlays sit above Leaflet's documented z-index ceiling (1000)", () => {
  const mapCode = stripComments(homeMap);
  const pageCode = stripComments(homeDiscovery);
  // Lokasi Saya button (inside the map component).
  assert.match(mapCode, /z-\[1100\][^"]*"/);
  // Empty-state card, coverage box and scale (map stage overlays).
  // MOCKUP §4 (2026-10-01): the map is now the full-bleed background of Home,
  // so the empty-state card anchors near the BOTTOM of the stage (clear of the
  // coverage box) instead of the stage's vertical middle — but it still rides
  // strictly above the Leaflet control ceiling, which is the actual lock here.
  // COMPACT (bug fix 2026-10-03): the card is now a centered, content-sized
  // box instead of a full-width panel that covered a large part of the map.
  assert.match(
    pageCode,
    /absolute inset-x-0 bottom-32 z-\[1100\] flex justify-center px-4/,
    "empty-state card must ride above the Leaflet control ceiling",
  );
  assert.match(pageCode, /w-fit max-w-\[min\(20rem,100%\)\] rounded-xl bg-white\/95 px-3 py-1\.5/);
  // The DUPLICATE "Tempat Pilihan" chip is gone (bug fix 2026-10-03): the map
  // stage repeated the filter bar's own control as a second chip. The filter
  // itself is untouched in the main bar; only the duplicate is removed.
  assert.equal(pageCode.includes("top-[152px]"), false, "duplicate map-area filter chip must not return");
  assert.equal(
    /absolute left-4 top-\[\d+px\] z-\[1100\] rounded-full bg-brand-primary/.test(pageCode),
    false,
    "duplicate status chip must not return",
  );
});

// --- PO decision 2026-09-25: the map frame stays fully visible ---

test("No Place preview/bottom sheet may ever cover the map surface", () => {
  const pageCode = stripComments(homeDiscovery);
  // The old in-map bottom sheet must not come back in any form.
  assert.equal(/bottom-0 left-0 right-0/.test(pageCode), false, "no absolute bottom strip inside the map frame");
  assert.equal(pageCode.includes("Lihat Tempat"), false, "no Place CTA floating over the map");
  assert.equal(/rounded-t-\[28px\]\s+bg-white/.test(pageCode), false, "no bottom-sheet card over the map");
  // The only z-[1200] layer in the app is now the FLOATING HEADER in
  // site-nav.tsx (MOCKUP §5) — never a sheet over the map surface.
  assert.equal(pageCode.includes("z-[1200]"), false, "no z-[1200] overlay layer inside the map stage");
});

test("Place detail still lives in the results section below the map", () => {
  const pageCode = stripComments(homeDiscovery);
  // The discovery list below the map stays the Place-detail surface
  // (Stage 3 renamed its default heading to "Discovery Place").
  assert.match(pageCode, /aria-labelledby="place-results-heading"/);
  assert.match(pageCode, /Discovery Place/);
  assert.match(pageCode, /href=\{live \? `\/live\/\$\{live.sessionId\}` : `\/places\/\$\{place.id\}`\}/);
});

test("No legacy low overlay z-index survives inside the map frame", () => {
  const pageCode = stripComments(homeDiscovery);
  const mapCode = stripComments(homeMap);
  // The old buggy values must not reappear on map overlays.
  for (const code of [pageCode, mapCode]) {
    assert.equal(/top-1\/2 z-10 /.test(code), false, "empty-state card must not use z-10");
    assert.equal(/bottom-0 left-0 right-0 z-20 /.test(code), false, "bottom sheet must not use z-20");
    assert.equal(/top-\[76px\] z-\[800\]/.test(code), false, "locate button must not sit at Leaflet control level");
  }
});

test("Map frame remains the single clipping boundary; no masking workaround", () => {
  const pageCode = stripComments(homeDiscovery);
  // Frame: positioned, isolated, clipped. MOCKUP §4 (2026-10-01) turned the
  // standalone rounded map panel into the full-bleed Home stage, so the
  // radius/border moved to the Result panel below — the architectural
  // requirement that makes this the single clipping boundary (relative +
  // isolate + overflow-hidden) is unchanged.
  assert.match(pageCode, /<section className="relative isolate overflow-hidden bg-\[#d9dfd2\]">/);
  const mapCode = stripComments(homeMap);
  // No pseudo/masking workaround and no drag disabling to hide the bug.
  assert.equal(mapCode.includes("pointer-events-none"), false);
  assert.equal(mapCode.includes("clip-path"), false);
  assert.equal(mapCode.includes("dragging: false"), false);
});

test("Overlays render as siblings AFTER the map inside the frame (DOM order fallback)", () => {
  const pageCode = stripComments(homeDiscovery);
  const mapMount = pageCode.indexOf("<HomeMap\n");
  assert.ok(mapMount > 0, "HomeMap must be rendered by HomeDiscovery");
  // The in-map Place bottom sheet was removed (PO 2026-09-25), the duplicate
  // filter chip was removed (2026-10-03), and the floating COVERAGE BOX was
  // consolidated into the results panel (2026-10-03): the map stage now keeps
  // only the empty-state card above the floating results panel. The bottom-right
  // distance scale left the stage too, with its indicator, on 2026-10-04.
  //
  // The RESULTS panel floats on the map's bottom edge instead of sitting under
  // it (2026-10-04). Like the empty state it is a sibling rendered AFTER the
  // map, so the DOM-order fallback still holds for it too.
  const emptyCard = pageCode.indexOf("bottom-32 z-[1100]");
  const floatingResults = pageCode.indexOf("absolute inset-x-0 bottom-3 z-[1100]");
  assert.equal(pageCode.includes("bottom-9 left-4 z-[1100]"), false, "the floating coverage box is consolidated away");
  assert.equal(pageCode.indexOf("bottom-9 right-4 z-[1100]"), -1, "the distance scale is removed, not moved");
  for (const [name, index] of [
    ["empty-state card", emptyCard],
    ["floating results panel", floatingResults],
  ] as const) {
    assert.ok(index > mapMount, `${name} must come after the map in DOM order`);
  }
});

test("MOCKUP §4/§5: the floating header, search, and filter stay above the map surface", () => {
  const pageCode = stripComments(homeDiscovery);
  // The floating chrome rides the documented ladder above Leaflet's ceiling
  // (1000): header 1200, search/filter and map overlays 1100, map 0. Tiles can
  // therefore never paint over the chrome in any drag/zoom state.
  assert.match(pageCode, /<div className="absolute inset-0 z-0">/);
  // The chrome wrapper is CLICK-THROUGH (product decision, 2026-10-01): it
  // spans the whole map window (it also holds the invisible map-height
  // spacer), so as a normal pointer target it used to swallow every zoom /
  // drag / pinch on the map surface. pointer-events-none lets the map receive
  // them again; the search bar and filter row opt back in explicitly.
  assert.match(pageCode, /className="relative z-\[1100\] pointer-events-none mx-auto w-full max-w-6xl px-4"/);
  assert.match(pageCode, /className="pointer-events-auto mt-\[60px\] sm:mt-\[64px\]"/);
  assert.match(pageCode, /className="pointer-events-auto mt-2\.5 grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5"/);
  const nav = stripComments(readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8"));
  assert.match(nav, /"absolute inset-x-0 top-0 z-\[1200\] border-b-0 bg-transparent"/);
});
