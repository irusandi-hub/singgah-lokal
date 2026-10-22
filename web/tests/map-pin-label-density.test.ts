import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PIN_LABEL_ALWAYS_ON_LIMIT,
  PIN_LABEL_COLLISION_GAP_PX,
  PIN_LABEL_HEIGHT_PX,
  pinLabelBudgetForZoom,
  selectVisiblePinLabelIds,
  type PinLabelBox,
} from "../lib/live/ui";

/**
 * PLACE PIN LABEL READABILITY — ZOOM-AWARE DECLUTTER (2026-10-21).
 *
 * HISTORY. The 2026-10-05 rule was a fixed priority budget of 12 labels. It
 * stopped the worst piles in a dense city cluster, but it was blind to the
 * camera: at a far-out zoom every pin sits within a few pixels of its
 * neighbours, so 12 chips still overlapped and none was readable; at a close
 * zoom it could hide names that had plenty of room.
 *
 * THE RULE NOW has two deterministic gates, both computed from PROJECTED
 * geometry (`map.project(latlng, zoom)`) — never from layout:
 *  1. COLLISION — a chip whose box would overlap an already-kept chip is held
 *     back;
 *  2. DENSITY — the zoom decides how many chips may stay painted
 *     (`pinLabelBudgetForZoom`, 3 → 12 as the camera gets closer).
 *
 * The SELECTED Place is always labelled, whatever the density, and its pin is
 * always visible. Pins, coordinates, z-order, accessible names, tooltips, click
 * targets, and the full label text in the DOM are untouched: hiding is a paint
 * state only, revealed again by hover / keyboard focus.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}
const mapCode = stripComments(homeMap);

function box(id: string, overrides: Partial<PinLabelBox> = {}): PinLabelBox {
  return { id, x: 0, y: 0, width: 120, height: PIN_LABEL_HEIGHT_PX, tier: 3, ...overrides };
}

/** Boxes far enough apart that no pair collides. */
function spaced(count: number, gap = 200): PinLabelBox[] {
  return Array.from({ length: count }, (_, index) => box(`place-${index}`, { x: index * gap }));
}

// ---------------------------------------------------------------------------
// 1. A single Place pin
// ---------------------------------------------------------------------------

test("1.1 a single Place keeps its label at every zoom", () => {
  for (const zoom of [2, 8, 12, 16, 19]) {
    const chosen = selectVisiblePinLabelIds({ boxes: [box("only")], zoom });
    assert.deepEqual([...chosen], ["only"]);
  }
});

test("1.2 labels are never ALL hidden, even in an extreme cluster", () => {
  for (const count of [2, 13, 40, 400, 5_000]) {
    const chosen = selectVisiblePinLabelIds({
      boxes: Array.from({ length: count }, (_, index) => box(`p-${index}`)),
      zoom: 2,
    });
    assert.ok(chosen.size >= 1, "at least one label must stay painted");
  }
});

// ---------------------------------------------------------------------------
// 2. Collision
// ---------------------------------------------------------------------------

test("2.1 two far-apart pins both keep their labels", () => {
  const chosen = selectVisiblePinLabelIds({ boxes: spaced(2), zoom: 8 });
  assert.deepEqual([...chosen].sort(), ["place-0", "place-1"]);
});

test("2.2 overlapping chips are held back, their pins are not", () => {
  // 20 chips occupying exactly the same box: one survives.
  const chosen = selectVisiblePinLabelIds({
    boxes: Array.from({ length: 20 }, (_, index) => box(`p-${index}`)),
    zoom: 16,
  });
  assert.equal(chosen.size, 1);
  // A one-pixel nudge is still a collision with the required gap.
  const nudged = selectVisiblePinLabelIds({
    boxes: [
      box("a", { x: 0 }),
      box("b", { x: PIN_LABEL_COLLISION_GAP_PX }),
      box("c", { x: 400 }),
    ],
    zoom: 16,
  });
  assert.deepEqual([...nudged].sort(), ["a", "c"]);
});

test("2.3 results are deterministic — the same input never flickers", () => {
  const boxes = [...spaced(14), ...spaced(14).map((item) => ({ ...item, id: `${item.id}-b`, x: item.x + 10 }))];
  const first = [...selectVisiblePinLabelIds({ boxes, zoom: 9 })];
  const second = [...selectVisiblePinLabelIds({ boxes, zoom: 9 })];
  assert.deepEqual(second, first);
});

// ---------------------------------------------------------------------------
// 3. Density by zoom
// ---------------------------------------------------------------------------

test("3.1 the density budget widens with the zoom and is capped", () => {
  const budgets = [2, 5, 8, 9, 10, 11, 12, 13, 15, 16, 19].map(pinLabelBudgetForZoom);
  for (let index = 1; index < budgets.length; index += 1) {
    assert.ok(budgets[index] >= budgets[index - 1], "the budget never shrinks as the camera gets closer");
  }
  assert.equal(pinLabelBudgetForZoom(2), 3);
  assert.equal(pinLabelBudgetForZoom(9), 3);
  assert.equal(pinLabelBudgetForZoom(10), 5);
  assert.equal(pinLabelBudgetForZoom(12), 8);
  assert.equal(pinLabelBudgetForZoom(14), 10);
  assert.equal(pinLabelBudgetForZoom(16), PIN_LABEL_ALWAYS_ON_LIMIT);
  assert.equal(pinLabelBudgetForZoom(Number.NaN), 3);
});

test("3.2 the same spread carries fewer labels at a far zoom", () => {
  const boxes = spaced(30);
  const far = selectVisiblePinLabelIds({ boxes, zoom: 8 });
  const mid = selectVisiblePinLabelIds({ boxes, zoom: 12 });
  const close = selectVisiblePinLabelIds({ boxes, zoom: 16 });
  assert.equal(far.size, pinLabelBudgetForZoom(8));
  assert.equal(mid.size, pinLabelBudgetForZoom(12));
  assert.equal(close.size, PIN_LABEL_ALWAYS_ON_LIMIT);
  assert.ok(far.size < mid.size && mid.size < close.size);
});

// ---------------------------------------------------------------------------
// 4. Priority and the selected Place
// ---------------------------------------------------------------------------

test("4.1 priority follows the marker ladder: curated, then Live, then order", () => {
  const mixed: PinLabelBox[] = [
    box("ordinary-1", { x: 0, tier: 3 }),
    box("live-1", { x: 300, tier: 2 }),
    box("ordinary-2", { x: 600, tier: 3 }),
    box("curated-1", { x: 900, tier: 1 }),
    box("curated-2", { x: 1200, tier: 1 }),
  ];
  assert.deepEqual([...selectVisiblePinLabelIds({ boxes: mixed, zoom: 2 })], [
    "curated-1",
    "curated-2",
    "live-1",
  ]);
});

test("4.2 the selected Place is labelled even inside a crowd", () => {
  const crowd = Array.from({ length: 30 }, (_, index) => box(`p-${index}`));
  const chosen = selectVisiblePinLabelIds({ boxes: crowd, zoom: 2, pinnedId: "p-17" });
  assert.equal(chosen.has("p-17"), true);
  // …and it is the FIRST label kept, so it can never be crowded out.
  assert.equal([...chosen][0], "p-17");
});

test("4.3 the selected label is guaranteed visible in CSS too", () => {
  // The selected marker may paint its chip even if the data attribute still
  // names it on-demand (e.g. a stale attribute during a rebuild).
  assert.match(
    globals,
    /\.singgah-map-marker\.is-highlighted \.singgah-pin-label \{\s*visibility: visible;\s*\}/,
  );
});

// ---------------------------------------------------------------------------
// 5. Paint state only — text, targets, and identity survive
// ---------------------------------------------------------------------------

test("5.1 a decluttered label is held back by CSS, never removed", () => {
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?max-width: 124px;/);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?font-size: 11\.5px;/);
  // The projected box must describe the chip it measures: 19px tall, and the
  // width estimate follows the 11.5px/600 advance + the 7px side padding.
  assert.equal(PIN_LABEL_HEIGHT_PX, 19);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?padding: 2px 7px;/);
  assert.match(mapCode, /PIN_LABEL_CHAR_WIDTH_PX = 6\.7/);
  assert.match(mapCode, /Math\.round\(place\.name\.length \* PIN_LABEL_CHAR_WIDTH_PX\) \+ 16/);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?text-overflow: ellipsis;/);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?pointer-events: none;/);
  assert.match(
    globals,
    /\.singgah-pin-label\[data-label-state="on-demand"\] \{\s*visibility: hidden;\s*\}/,
  );
  assert.match(
    globals,
    /\.singgah-map-marker:hover \.singgah-pin-label\[data-label-state="on-demand"\][\s\S]*?visibility: visible;/,
  );
  assert.match(
    globals,
    /\.singgah-map-marker:focus-within \.singgah-pin-label\[data-label-state="on-demand"\][\s\S]*?visibility: visible;/,
  );
  const declutterBlock = globals.slice(
    globals.indexOf('[data-label-state="on-demand"]'),
    globals.indexOf(".singgah-map-marker.is-highlighted .singgah-pin-label"),
  );
  assert.doesNotMatch(declutterBlock, /transition:|animation:|@keyframes/);
});

test("5.2 every pin keeps its full text, accessible name, tooltip, and target", () => {
  assert.match(
    mapCode,
    /<span class="singgah-pin-label" \$\{PIN_LABEL_ON_DEMAND_ATTRIBUTE\}="\$\{labelState\}"[^>]*>\$\{escapeHtml\(place\.name\)\}<\/span>/,
  );
  // Chips start held back and are painted by the projected pass; the DOM node
  // is never re-created or removed by a label decision.
  assert.match(mapCode, /const labelState = "on-demand";/);
  assert.match(mapCode, /label\.setAttribute\(PIN_LABEL_ON_DEMAND_ATTRIBUTE, visible\.has\(id\) \? "always" : "on-demand"\);/);
  assert.match(mapCode, /role="img" aria-label="Lihat \$\{escapeHtml\(place\.name\)\}"/);
  assert.match(mapCode, /marker\.bindTooltip\(escapeHtml\(place\.name\), \{/);
  assert.match(
    mapCode,
    /onSelectPlace\s*\?\s*onSelectPlace\(place\.id\)\s*:\s*router\.push\(`\/places\/\$\{place\.id\}`\)/,
  );
  assert.match(mapCode, /keyboard: true,/);
  // The only label span in the icon markup — no second, hidden duplicate.
  assert.equal((mapCode.match(/class="singgah-pin-label"/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// 6. Stability and scope
// ---------------------------------------------------------------------------

test("6.1 the pass runs on marker rebuild and on zoomend — never in render", () => {
  assert.match(mapCode, /applyPinLabelStates\(map, currentPlaces, liveByPlaceId, highlightedPlaceId\);/);
  assert.match(mapCode, /map\.on\("zoomend", refreshPinLabelsAtCurrentZoom\);/);
  assert.match(mapCode, /const refreshPinLabelsAtCurrentZoom = useCallback\(\(\) => \{/);
  assert.match(mapCode, /selectVisiblePinLabelIds\(\{ boxes, zoom, pinnedId: selectedId \}\)/);
  assert.match(mapCode, /\}, \[ready, markerKey, highlightedPlaceId, onSelectPlace\]\);/);
  // The projection is pure geometry, not a DOM layout read.
  assert.match(mapCode, /map\.project\(\[place\.latitude, place\.longitude\], zoom\)/);
});

test("6.2 no layout measurement is introduced anywhere in the map", () => {
  assert.equal((mapCode.match(/getBoundingClientRect\(\)/g) ?? []).length, 1);
  assert.match(homeMap, /\/\/ Force a reflow so a pulse restarted mid-cycle runs completely\.\s*\n\s*void element\.getBoundingClientRect\(\);/);
  assert.doesNotMatch(mapCode, /offsetWidth|offsetHeight|clientWidth|clientHeight/);
  const markerEffect = mapCode.slice(
    mapCode.indexOf("markerPositionsRef.current = markerPositions;"),
    mapCode.indexOf("}, [ready, markerKey, highlightedPlaceId, onSelectPlace]);"),
  );
  assert.doesNotMatch(markerEffect, /getBoundingClientRect|offsetWidth|clientWidth|requestAnimationFrame/);
});

test("6.3 the marker ladder, artwork, coordinates, and LIVE chip are untouched", () => {
  assert.match(mapCode, /zIndexOffset: isHighlighted \? 2500 : isCurated \? 900 : live \? 0 : 500,/);
  assert.match(mapCode, /const pinColor = isCurated \? BRAND_CURATED : BRAND_BROWN;/);
  assert.match(mapCode, /zIndexOffset: isHighlighted \? 2600 : 1000,\s*\n\s*keyboard: true,/);
  assert.doesNotMatch(mapCode, /markerCluster|removeLayer\(marker\)|L\.circleMarker\(position, \{ radius/);
  // Same coordinates → same projected geometry: the declutter reads canonical
  // lat/lng and never writes them.
  assert.match(mapCode, /for \(const place of currentPlaces\) \{\s*\n\s*if \(!Number\.isFinite\(place\.latitude\) \|\| !Number\.isFinite\(place\.longitude\)\) continue;/);
});
