import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * CALM HOME MAP — VISUAL REFINEMENT (2026-10-21)
 *
 * WHAT THE SOURCE CAN AND CANNOT DO. The Home map draws OpenStreetMap
 * standard RASTER tiles (`tile.openstreetmap.org/{z}/{x}/{y}.png`, Leaflet
 * 1.9.x). Each tile is one flattened PNG: the provider exposes no style
 * document, no layer list, no colour config, and no label-visibility switch,
 * so road widths, road hierarchy, building fills, and label density cannot be
 * restyled per feature. This test pins the honest scope of the refinement:
 *
 *  · the tile URL, provider, single-tile-layer model, and attribution are
 *    untouched;
 *  · one MILD tonal adjustment is applied to the tile container only (never
 *    to markers, labels, controls, or React overlays), and it is bounded so a
 *    future tweak cannot wash the map out;
 *  · nothing masks or hides features that the raster actually contains;
 *  · the map surface is brand cream instead of Leaflet's grey;
 *  · Place pins use a deeper shade of the SAME brand brown, with enough
 *    contrast against the map surface to lead it (the reason for the change);
 *  · controls stay one 40px tile with the same geometry and gain one shared
 *    brand focus ring.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// 1. No migration: same source, same provider, same single layer.
// ---------------------------------------------------------------------------

test("1. the tile source, provider, single-layer model, and attribution are unchanged", () => {
  assert.match(
    homeMap,
    /const OSM_TILE_URL = "https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png";/,
  );
  assert.match(homeMap, /attribution: OSM_ATTRIBUTION,/);
  assert.equal((homeMap.match(/L\.tileLayer\(/g) ?? []).length, 1, "still exactly one tile layer");
  // No alternative map library or provider sneaks in with a cosmetic task.
  assert.doesNotMatch(homeMap, /maplibre|openfreemap|mapbox|leaflet\.maplibre/i);
  assert.doesNotMatch(globals, /maplibre|openfreemap|mapbox/i);
  // The styling hook is a class on the tile container, not a second layer.
  assert.match(homeMap, /className: "singgah-basemap",/);
});

// ---------------------------------------------------------------------------
// 2. One mild, tile-only tonal adjustment — bounded and non-destructive.
// ---------------------------------------------------------------------------

test("2. the basemap filter is mild enough to keep baked-in roads and labels readable", () => {
  const filter = /\.singgah-basemap \{\s*filter:([^;]+);/.exec(globals)?.[1];
  assert.ok(filter, "the tile container must carry the calm filter");

  const saturation = Number(/saturate\(([\d.]+)\)/.exec(filter)?.[1]);
  const contrastValue = Number(/contrast\(([\d.]+)\)/.exec(filter)?.[1]);
  const brightness = Number(/brightness\(([\d.]+)\)/.exec(filter)?.[1]);

  assert.ok(saturation >= 0.4 && saturation <= 0.8, `saturation stays moderate (got ${saturation})`);
  // Contrast may only be flattened a little: labels live inside the same PNG,
  // so a heavy reduction would fade street names along with the land use.
  assert.ok(contrastValue >= 0.9 && contrastValue <= 0.98, `contrast stays ≥ 0.9 (got ${contrastValue})`);
  assert.ok(brightness >= 1 && brightness <= 1.06, `brightness stays subtle (got ${brightness})`);
});

test("3. the adjustment is scoped to the tiles, not to markers or overlays", () => {
  // The filter lives on the tile-container class only.
  const tileFilterBlock = /\.singgah-basemap \{[^}]*filter:[^}]*\}/.exec(globals)?.[0];
  assert.ok(tileFilterBlock, "the calm filter must exist");
  assert.match(tileFilterBlock!, /^\.singgah-basemap \{\s*filter:/);
  assert.equal((globals.match(/saturate\(0\.55\)/g) ?? []).length, 1, "exactly one tone adjustment");
  // No filtering of the panes that carry the user disc, markers, or tooltips.
  assert.doesNotMatch(globals, /\.leaflet-(marker|overlay|tooltip|popup)-pane[^}]*filter:/);
  // No opacity veil or pseudo-element mask pretending to remove features.
  assert.doesNotMatch(globals, /\.singgah-basemap[^}]*opacity:/);
  assert.doesNotMatch(globals, /\.singgah-basemap::?(before|after)/);
});

test("4. the map surface is brand cream, so no grey Leaflet background shows", () => {
  assert.match(
    globals,
    /\.singgah-home-map\.leaflet-container \{\s*background-color: var\(--brand-cream\);\s*\}/,
  );
});

// ---------------------------------------------------------------------------
// 3. Place pin prominence — same identity, now legible against the map.
// ---------------------------------------------------------------------------

test("5. Place pins use the deep accent brown and clear 4.5:1 on the map surface", () => {
  const pin = /--brand-pin:\s*(#[0-9a-f]{6})/i.exec(globals)?.[1];
  const cream = /--brand-cream:\s*(#[0-9a-f]{6})/i.exec(globals)?.[1];
  const accent = /--brand-accent:\s*(#[0-9a-f]{6})/i.exec(globals)?.[1];
  assert.ok(pin && cream && accent, "all brand tokens must exist");

  const ratio = contrast(pin!, cream!);
  assert.ok(ratio >= 4.5, `the pin must reach 4.5:1 on the map surface (got ${ratio.toFixed(2)}:1)`);
  // Why it changed: the old accent brown was below the 3:1 non-text minimum.
  const oldRatio = contrast(accent!, cream!);
  assert.ok(oldRatio < 3, `the previous tan was the low-contrast case (got ${oldRatio.toFixed(2)}:1)`);

  // One pin colour source, the same shape/anchor, and the curated green and
  // LIVE red treatments are untouched (2026-10-22: the curated treatment moved
  // from the pale sage to the DARK brand green so the selection reads).
  assert.match(homeMap, /const BRAND_BROWN = "var\(--brand-pin\)";/);
  assert.match(homeMap, /const pinColor = isCurated \? BRAND_CURATED : BRAND_BROWN;/);
  assert.match(homeMap, /BRAND_CURATED = "var\(--brand-primary\)"/);
  const pinCss = /\.singgah-pin \{([\s\S]*?)\}/.exec(globals)?.[1];
  assert.ok(pinCss);
  assert.match(pinCss!, /width: 24px;/);
  assert.match(pinCss!, /height: 31px;/);
  assert.match(globals, /\.singgah-pin--curated \.singgah-pin-head \{[\s\S]*?box-shadow: 0 0 0 1px #cfae58;/);
  assert.match(homeMap, /zIndexOffset: isHighlighted \? 2500 : isCurated \? 900 : live \? 0 : 500/);
});

test("6. the name chip stays a compact chip, not an information card", () => {
  const chip = /\.singgah-pin-label \{([\s\S]*?)\}/.exec(globals)?.[1];
  assert.ok(chip);
  assert.match(chip!, /max-width: 124px;/);
  assert.match(chip!, /font-size: 11\.5px;/);
  assert.match(chip!, /background: #fff;/);
  assert.match(chip!, /box-shadow: 0 1px 2px rgb\(32 35 31 \/ 0\.16\);/);
  assert.match(chip!, /text-overflow: ellipsis;/);
  assert.match(chip!, /pointer-events: none;/);
});

// ---------------------------------------------------------------------------
// 4. Controls — same geometry and function, one brand focus treatment.
// ---------------------------------------------------------------------------

test("7. the two map controls keep one identical 40px tile", () => {
  // 2026-10-21: the compass was removed, so the column is one row of TWO
  // 40px tiles (Lokasi Saya + help "?").
  assert.equal(
    (homeMap.match(/inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-\[14px\]/g) ?? []).length,
    2,
    "Lokasi Saya and the help tile share one tile style",
  );
  assert.equal(homeMap.includes("Arah peta: utara ke atas"), false, "the compass is gone");
  assert.match(homeMap, /absolute right-3 top-\[190px\] z-\[1100\] flex flex-nowrap items-center gap-2/);
  // Focus feedback is unified, but the controls themselves are not rebuilt.
  assert.match(
    globals,
    /button\[aria-label="Lokasi saya — pusatkan peta ke lokasi aktual"\]:focus-visible,/,
  );
  assert.match(globals, /button\[aria-label="Tampilkan petunjuk gestur peta"\]:focus-visible \{/);
  assert.match(globals, /outline: 2px solid var\(--brand-primary\);\s*outline-offset: 2px;/);
});
