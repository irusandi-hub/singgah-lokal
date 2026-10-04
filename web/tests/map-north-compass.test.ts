import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * APPROVED HOME/MAP MOCKUP — the map's north compass (2026-10-04).
 *
 * The approved mockup replaces the right-hand map navigation arrow with a
 * compass. Two things are locked here, and they are different in kind:
 *
 *  1. GEOMETRY AND HONESTY. The compass occupies the SAME box as the arrow it
 *     replaces — same offset, same 44px size, same white surface, radius, ring
 *     and shadow — so the right-hand control column keeps its exact shape. It
 *     shows an accurate north indicator: this Leaflet build (1.9.x core, no
 *     rotation plugin) has no bearing state and cannot rotate the map, so the
 *     map is always north-up and the needle always points north.
 *
 *  2. NO INVENTED BEHAVIOUR. Because there is no rotation to undo, the compass
 *     is deliberately NOT a button: a click handler that "restores north-up"
 *     would advertise a capability this map does not have. Re-centering is
 *     still one press away on the labeled "Lokasi Saya" control below it, whose
 *     geolocation behaviour is untouched.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const mapCode = stripComments(homeMap);

// ---------------------------------------------------------------------------
// 1. The compass replaces the arrow, in the same box.
// ---------------------------------------------------------------------------

test("the compass keeps the retired arrow's exact box", () => {
  assert.match(
    mapCode,
    /role="img"\s*\n\s*aria-label="Arah peta: utara ke atas"\s*\n\s*className="absolute right-3 top-\[190px\] z-\[1100\] inline-flex h-11 w-11 items-center justify-center rounded-xl bg-white text-brand-ink shadow-md ring-1 ring-black\/10"/,
  );
});

test("the navigation arrow and its locate handler entry point are gone", () => {
  assert.doesNotMatch(mapCode, /➤/);
  assert.doesNotMatch(mapCode, /Pusatkan peta ke lokasi saya/);
  assert.doesNotMatch(mapCode, /-rotate-45/);
  // No other glyph is dressed up as the retired arrow.
  assert.doesNotMatch(mapCode, /recenter|re-center/i);
});

// ---------------------------------------------------------------------------
// 2. It is a compass, and it points at real north.
// ---------------------------------------------------------------------------

test("the compass draws a needle whose north half points up", () => {
  // The two halves form one needle: the NORTH half is the top triangle and is
  // painted in the one accent colour, the south half is the muted one.
  const north = /<path d="M12 4\.2 15\.1 13\.2H8\.9L12 4\.2Z" fill="#dc2626" \/>/.exec(mapCode);
  const south = /<path d="M12 19\.8 8\.9 10\.8h6\.2L12 19\.8Z" fill="currentColor" opacity="0\.35" \/>/.exec(mapCode);
  assert.ok(north, "a north needle half must be drawn");
  assert.ok(south, "a south needle half must be drawn");
  // The north triangle's apex is at the TOP of the dial (smallest y) and its
  // base is below it — the geometry itself says "north is up".
  const northY = Number(/M12 ([\d.]+) 15\.1/.exec(north[0])![1]);
  const southY = Number(/M12 ([\d.]+) 8\.9/.exec(south[0])![1]);
  assert.ok(northY < southY, "the north apex sits above the south apex");
  // And it is drawn inside a dial, not as a bare arrow.
  assert.match(mapCode, /<circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1\.6" \/>/);
});

test("the compass is an image with an accessible name, never a control", () => {
  // No button, no handler, no hover affordance: this map cannot rotate, so a
  // click could not honestly do anything.
  const compass = mapCode.slice(mapCode.indexOf('role="img"'), mapCode.indexOf("</svg>") + "</svg>".length);
  assert.doesNotMatch(compass, /<button|onClick|tabIndex|cursor-pointer|hover:/);
  assert.match(compass, /<svg aria-hidden/);
  // The accessible name states the same fact the needle draws.
  assert.match(compass, /aria-label="Arah peta: utara ke atas"/);
});

// ---------------------------------------------------------------------------
// 3. Rotation is genuinely unsupported — the reason the compass is passive.
// ---------------------------------------------------------------------------

test("the map has no rotation capability for a compass to reflect or restore", () => {
  // Leaflet 1.9 core: no bearing state, no rotation plugin, no setBearing. A
  // compass that claimed to track or restore an orientation would be inventing
  // behaviour, so it does not.
  assert.doesNotMatch(mapCode, /setBearing|getBearing|rotateControl|map\.rotate|L\.RotatingMap/);
  // Nor is any rotation plugin available to the app.
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
  assert.equal(
    Object.keys(deps).some((name) => /rotat|compass/i.test(name)),
    false,
    "no rotation plugin may be added to justify an interactive compass",
  );
  // The basemap stays the single north-up OSM layer.
  assert.match(mapCode, /const OSM_TILE_URL = "https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png";/);
});

// ---------------------------------------------------------------------------
// 4. "Lokasi Saya" keeps working, independently of the compass.
// ---------------------------------------------------------------------------

test("'Lokasi Saya' is still the one working locate control, on the SAME handler", () => {
  assert.equal((mapCode.match(/onClick=\{onRequestLocate\}/g) ?? []).length, 1);
  assert.match(
    mapCode,
    /onClick=\{onRequestLocate\}\s*\n\s*className="absolute right-3 top-\[240px\] z-\[1100\] inline-flex w-11 flex-col items-center gap-1 rounded-xl bg-white px-1 py-2 text-\[9px\] font-bold leading-tight text-brand-ink shadow-md ring-1 ring-black\/10 transition hover:bg-brand-cream"/,
    "the labeled locate control keeps its position, size, and surface",
  );
  assert.match(mapCode, /aria-label="Lokasi saya — pusatkan peta ke lokasi aktual"/);
  assert.match(mapCode, /Lokasi Saya\n/);
  // Its geolocation path is untouched: the REAL browser fix and the explicit
  // locate nonce still drive the camera, and nothing about the compass is
  // allowed to feed them.
  assert.match(mapCode, /locateNonce: number;/);
  assert.match(mapCode, /onRequestLocate: \(\) => void;/);
  assert.match(mapCode, /if \(!locateNonce \|\| lastLocateNonceRef\.current === locateNonce\) return;/);
});

// ---------------------------------------------------------------------------
// 5. The control ladder the compass sits in is unchanged.
// ---------------------------------------------------------------------------

test("the right-hand ladder is compass 190 → Lokasi Saya 240 → zoom 290", () => {
  const compassTop = Number(/absolute right-3 top-\[(\d+)px\] z-\[1100\] inline-flex h-11 w-11/.exec(mapCode)?.[1] ?? "0");
  const locateTop = Number(/absolute right-3 top-\[(\d+)px\] z-\[1100\] inline-flex w-11 flex-col/.exec(mapCode)?.[1] ?? "0");
  const zoomTop = Number(/\.singgah-home-map \.leaflet-top\.leaflet-right \{\s*top: (\d+)px;/.exec(globalsCss)?.[1] ?? "0");
  assert.equal(compassTop, 190, "the compass keeps the retired arrow's offset");
  assert.equal(locateTop, 240);
  assert.equal(zoomTop, 290);
  assert.ok(locateTop > compassTop, "'Lokasi Saya' still sits below the compass");
  assert.ok(zoomTop > locateTop, "the +/- stack is still last");
  // Both overlays stay above Leaflet's documented control ceiling.
  assert.match(mapCode, /role="img"[\s\S]{0,200}?z-\[1100\]/);
  // The zoom control itself is Leaflet's own, untouched.
  assert.match(mapCode, /L\.control\.zoom\(\{ position: "topright", zoomInTitle: "Perbesar peta", zoomOutTitle: "Perkecil peta" \}\)/);
});