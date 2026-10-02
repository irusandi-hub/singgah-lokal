import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Regression: Home map gesture lock (PO task 2026-09-27).
 *
 * Locked contract on the EXISTING HomeMap Leaflet instance:
 *   - ONE finger on the map must never pan, drag, or zoom it (single-finger
 *     input stays free for page/UI interaction outside the map).
 *   - TWO fingers keep working: Leaflet's TouchZoom performs BOTH pinch zoom
 *     AND two-finger pan (map._move from the pinch midpoint) independent of
 *     the Draggable handler, so disabling dragging never removes 2-finger
 *     pan/pinch.
 *   - Desktop (pointer fine) keeps every existing behavior untouched.
 *
 * Verification is code-level: the suite cannot drive real multi-touch
 * hardware, so the Leaflet-internal facts (Draggable = the only one-finger
 * camera control, TouchZoom owns two-finger pan+zoom) are locked against the
 * installed leaflet source alongside the component wiring.
 */

const homeMapSource = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const leafletSource = readFileSync(
  new URL("../node_modules/leaflet/dist/leaflet-src.js", import.meta.url),
  "utf8",
);

test("Gesture 1-2: one finger can no longer pan/drag or zoom the map (touch-primary)", () => {
  // The decision is made once per device class from the primary pointer.
  assert.match(homeMapSource, /matchMedia\?\.\("\(pointer: coarse\)"\)/);
  // Dragging (the ONLY one-finger pan) and double-tap zoom (the only
  // one-finger zoom) are disabled exactly for touch-primary devices.
  assert.match(homeMapSource, /dragging: !touchPrimary/);
  assert.match(homeMapSource, /doubleClickZoom: !touchPrimary/);
  // The lock lives on the existing L.map options of the existing instance —
  // no second map component and no global workaround.
  assert.doesNotMatch(homeMapSource, /touch-action|touchAction/);
  assert.equal((homeMapSource.match(/L\.map\(container/g) ?? []).length, 1);
});

test("Gesture 3-4: two-finger pan + pinch zoom stay functional (Leaflet internals)", () => {
  // Leaflet 1.9.4 facts (installed source): TouchZoom._onTouchMove drives
  // BOTH zoom AND pan for exactly two touches, regardless of dragging, and
  // Draggable bails on any non-1-touch count.
  const touchMove = leafletSource.slice(
    leafletSource.indexOf("_onTouchMove: function"),
    leafletSource.indexOf("_onTouchEnd: function"),
  );
  assert.match(touchMove, /touches\.length !== 2/);
  assert.match(touchMove, /map\._move\b/);
  assert.match(touchMove, /this\._zoom = map\.getScaleZoom\(scale/);
  // Draggable only ever drags with exactly one touch — disabling it cannot
  // affect the two-finger path.
  const onDown = leafletSource.slice(
    leafletSource.indexOf("onDown: function (e)"),
    leafletSource.indexOf("onDown: function (e)") + 2000,
  );
  assert.match(onDown, /e\.touches && e\.touches\.length !== 1/);
  assert.match(onDown, /Finish dragging to avoid conflict with touchZoom/);
});

test("Gesture 5: marker/Place interaction is untouched (click handlers intact)", () => {
  // Marker clicks still navigate — the gesture lock touches camera controls
  // only, never layer/marker handling.
  assert.match(homeMapSource, /router\.push\(`\/places\/\$\{place\.id\}`\)/);
  assert.match(homeMapSource, /router\.push\(`\/live\/\$\{live\.sessionId\}`\)/);
  // touch-none container class (pre-existing) stays — it is what keeps the
  // page from scrolling under the map, not a gesture enabler.
  assert.match(homeMapSource, /touch-none/);
});

test("Gesture 6: desktop behavior unchanged (no pointer-fine branch)", () => {
  // The only conditional is !touchPrimary; fine-pointer devices get the same
  // dragging/doubleClickZoom they always had. No desktop-specific override
  // was added.
  assert.equal((homeMapSource.match(/touchPrimary/g) ?? []).length >= 3, true);
  assert.doesNotMatch(homeMapSource, /pointer: fine/);
  assert.match(homeMapSource, /scrollWheelZoom: true/);
});

test("Gesture 7-8: scope discipline — layout, overlays, and cleanup untouched", () => {
  // No layout/size/overlay changes: the container keeps its classes, the two
  // locate controls keep their handlers, and no new UI element appeared.
  // MOCKUP §9 (2026-10-01): because the map is now the full-bleed Home
  // background, the right-hand control stack was moved DOWN to clear the
  // floating header/search/filter chrome — the offset only; size, shape,
  // handlers, and the Leaflet control position are untouched.
  // RE-ORDERED (product decision, 2026-10-03): Leaflet's own +/- stack is now
  // the LAST control, BELOW both locate buttons, so the three offsets form one
  // ladder (190 → 240 → the 290px CSS offset) with no overlap. Sizes, shapes,
  // handlers, and the control position are still untouched.
  assert.match(homeMapSource, /className="relative z-0 h-full w-full touch-none singgah-home-map"/);
  assert.match(homeMapSource, /absolute right-3 top-\[190px\] z-\[1100\]/);
  assert.match(homeMapSource, /absolute right-3 top-\[240px\] z-\[1100\]/);
  // The two-finger observer is passive (never blocks/prevents anything) and
  // is detached in teardown — no listener leak.
  assert.match(homeMapSource, /passive: true/);
  assert.match(homeMapSource, /removeEventListener\("touchmove", observer\)/);
});
