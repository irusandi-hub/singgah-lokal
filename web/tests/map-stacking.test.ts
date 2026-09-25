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
 *   overflow-hidden + rounded) and no masking/pseudo-element workaround is
 *   used.
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
  assert.match(mapCode, /className="relative z-0 h-full w-full touch-none"/);
});

test("React map overlays sit above Leaflet's documented z-index ceiling (1000)", () => {
  const mapCode = stripComments(homeMap);
  const pageCode = stripComments(homeDiscovery);
  // Lokasi Saya button (inside the map component).
  assert.match(mapCode, /z-\[1100\][^"]*"/);
  // Empty-state card and radius/status badge (map frame overlays).
  assert.match(
    pageCode,
    /absolute inset-x-6 top-1\/2 z-\[1100\] -translate-y-1\/2 rounded-2xl bg-white\/95/,
    "empty-state card must ride above the Leaflet control ceiling",
  );
  assert.match(pageCode, /absolute left-5 top-5 z-\[1100\] rounded-full/);
});

// --- PO decision 2026-09-25: the map frame stays fully visible ---

test("No Place preview/bottom sheet may ever cover the map surface", () => {
  const pageCode = stripComments(homeDiscovery);
  // The old in-map bottom sheet must not come back in any form.
  assert.equal(/bottom-0 left-0 right-0/.test(pageCode), false, "no absolute bottom strip inside the map frame");
  assert.equal(pageCode.includes("z-[1200]"), false, "no bottom-sheet overlay layer");
  assert.equal(pageCode.includes("Lihat Tempat"), false, "no Place CTA floating over the map");
  assert.equal(/rounded-t-\[28px\]\s+bg-white/.test(pageCode), false, "no bottom-sheet card over the map");
});

test("Place detail still lives in the results section below the map", () => {
  const pageCode = stripComments(homeDiscovery);
  // The discovery list below the map stays the Place-detail surface.
  assert.match(pageCode, /aria-labelledby="place-results-heading"/);
  assert.match(pageCode, /Tempat di sekitar/);
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
  // Frame: positioned, isolated, clipped, rounded.
  assert.match(
    pageCode,
    /relative isolate h-\[58vh\] min-h-\[430px\] overflow-hidden rounded-\[28px\]/,
  );
  const mapCode = stripComments(homeMap);
  // No pseudo/masking workaround and no drag disabling to hide the bug.
  assert.equal(mapCode.includes("pointer-events-none"), false);
  assert.equal(mapCode.includes("clip-path"), false);
  assert.equal(mapCode.includes("dragging: false"), false);
});

test("Overlays render as siblings AFTER the map inside the frame (DOM order fallback)", () => {
  const pageCode = stripComments(homeDiscovery);
  const mapMount = pageCode.indexOf("<HomeMap");
  assert.ok(mapMount > 0, "HomeMap must be rendered by HomeDiscovery");
  // The in-map Place bottom sheet was removed (PO 2026-09-25): the map frame
  // keeps only the empty-state card and the radius/status badge above it.
  const emptyCard = pageCode.indexOf("top-1/2 z-[1100]");
  const badge = pageCode.indexOf("left-5 top-5 z-[1100]");
  for (const [name, index] of [
    ["empty-state card", emptyCard],
    ["radius badge", badge],
  ] as const) {
    assert.ok(index > mapMount, `${name} must come after the map in DOM order`);
  }
});
