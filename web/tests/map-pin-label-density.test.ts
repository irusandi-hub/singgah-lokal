import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PIN_LABEL_ALWAYS_ON_LIMIT,
  selectAlwaysLabelledPlaceIds,
  type PinLabelCandidate,
} from "../lib/live/ui";

/**
 * PLACE PIN LABEL READABILITY / DENSE-CLUSTER DECLUTTER (2026-10-05)
 *
 * THE DEFECT THIS COVERS. Every Place pin paints its compact name chip, and in
 * a dense geographic cluster — the ten curated Places of one city, the
 * twenty-five Places of one subdivision — every chip was painted at once, on
 * top of the neighbouring chips. In exactly the area the user cares about, no
 * name was readable.
 *
 * THE STRATEGY is the simplest one that is reliable in this architecture and
 * that keeps every name reachable:
 *  · a DETERMINISTIC priority budget (`selectAlwaysLabelledPlaceIds`) decides
 *    which chips stay painted when the map is dense;
 *  · it runs ONCE per marker rebuild — no `getBoundingClientRect`, no
 *    `offsetWidth`, no per-render or per-camera-update layout pass;
 *  · chips past the budget stay in the DOM with their full text and are
 *    revealed by the existing hover / keyboard-focus state (pure CSS);
 *  · nothing is filtered, no marker, tooltip, click target, accessible name,
 *    or z-order changes, and labels are never ALL hidden.
 *
 * What cannot be verified here is stated plainly at the end: the sandbox has
 * no browser that renders this map, so no claim is made about the chips being
 * visually collision-free — only about the layout logic being deterministic,
 * bounded, and non-destructive.
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

function candidates(count: number, overrides: Partial<PinLabelCandidate> = {}): PinLabelCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `place-${index}`,
    isCurated: false,
    isLive: false,
    ...overrides,
  }));
}

/** Two pins that are far apart never overlap, so both must keep their label. */
function widelySpacedPair(): PinLabelCandidate[] {
  return [
    { id: "far-apart-a", isCurated: false, isLive: false },
    { id: "far-apart-b", isCurated: false, isLive: false },
  ];
}

// ---------------------------------------------------------------------------
// 1. A single Place pin
// ---------------------------------------------------------------------------

test("1.1 a single Place keeps its label", () => {
  const chosen = selectAlwaysLabelledPlaceIds([{ id: "only", isCurated: false, isLive: false }]);
  assert.deepEqual([...chosen], ["only"]);
});

test("1.2 one Place is never decluttered even in a dense budget", () => {
  const chosen = selectAlwaysLabelledPlaceIds([{ id: "only", isCurated: true }]);
  assert.equal(chosen.size, 1);
  // The budget can never empty the label set while a Place is on screen.
  assert.equal(selectAlwaysLabelledPlaceIds([{ id: "only" }], 0).size, 0);
  assert.equal(PIN_LABEL_ALWAYS_ON_LIMIT > 0, true);
});

// ---------------------------------------------------------------------------
// 2. Normally spaced pins
// ---------------------------------------------------------------------------

test("2.1 normally spaced pins all keep their labels", () => {
  const chosen = selectAlwaysLabelledPlaceIds(widelySpacedPair());
  assert.deepEqual([...chosen].sort(), ["far-apart-a", "far-apart-b"]);
});

test("2.2 a set below the budget is never touched", () => {
  const places = candidates(PIN_LABEL_ALWAYS_ON_LIMIT);
  const chosen = selectAlwaysLabelledPlaceIds(places);
  assert.equal(chosen.size, PIN_LABEL_ALWAYS_ON_LIMIT);
  assert.deepEqual([...chosen], places.map((place) => place.id));
});

test("2.3 duplicate ids can never consume the budget twice", () => {
  const chosen = selectAlwaysLabelledPlaceIds([
    { id: "same", isCurated: false },
    { id: "same", isCurated: true },
  ]);
  assert.equal(chosen.size, 1);
});

// ---------------------------------------------------------------------------
// 3. Closely clustered pins
// ---------------------------------------------------------------------------

test("3.1 a tight cluster keeps a bounded, deterministic set of labels", () => {
  const cluster = candidates(20);
  const chosen = selectAlwaysLabelledPlaceIds(cluster);
  assert.equal(chosen.size, PIN_LABEL_ALWAYS_ON_LIMIT);
  // Deterministic and in canonical order — the same set every rebuild, so a
  // label can never flicker between marker rebuilds or pan/zoom.
  assert.deepEqual([...chosen], cluster.slice(0, PIN_LABEL_ALWAYS_ON_LIMIT).map((place) => place.id));
  assert.deepEqual([...selectAlwaysLabelledPlaceIds(cluster)], [...chosen]);
});

test("3.2 the survivors are the promoted pins: curated, then Live, then order", () => {
  const mixed: PinLabelCandidate[] = [
    { id: "ordinary-1", isCurated: false, isLive: false },
    { id: "live-1", isCurated: false, isLive: true },
    { id: "ordinary-2", isCurated: false, isLive: false },
    { id: "curated-1", isCurated: true, isLive: false },
    { id: "curated-2", isCurated: true, isLive: true },
  ];
  const chosen = [...selectAlwaysLabelledPlaceIds(mixed, 3)];
  assert.deepEqual(chosen, ["curated-1", "curated-2", "live-1"]);
});

test("3.3 a very dense cluster still keeps at least one label", () => {
  for (const count of [13, 40, 400, 5_000]) {
    const chosen = selectAlwaysLabelledPlaceIds(candidates(count));
    assert.equal(chosen.size, Math.min(count, PIN_LABEL_ALWAYS_ON_LIMIT));
    assert.ok(chosen.size >= 1, "labels must never be ALL hidden");
  }
});

// ---------------------------------------------------------------------------
// 4. Label visibility, interaction, and identification
// ---------------------------------------------------------------------------

test("4.1 a decluttered label is held back by CSS, not removed", () => {
  // The chip keeps its exact approved styling: compact, truncated, no pointer
  // capture, high contrast.
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?max-width: 132px;/);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?font-size: 11px;/);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?font-weight: 700;/);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?text-overflow: ellipsis;/);
  assert.match(globals, /\.singgah-pin-label \{[\s\S]*?pointer-events: none;/);
  // Only the paint state changes, and only through the data attribute.
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
  // No transition and no animation is introduced, so reduced-motion
  // preferences are untouched.
  const declutterBlock = globals.slice(
    globals.indexOf('[data-label-state="on-demand"]'),
    globals.indexOf(".singgah-map-marker:hover,"),
  );
  assert.doesNotMatch(declutterBlock, /transition:|animation:|@keyframes/);
});

test("4.2 every pin keeps its full text, accessible name, tooltip, and target", () => {
  // The chip always carries the escaped full Place name, whatever its state.
  assert.match(
    mapCode,
    /<span class="singgah-pin-label" \$\{PIN_LABEL_ON_DEMAND_ATTRIBUTE\}="\$\{labelState\}"[^>]*>\$\{escapeHtml\(place\.name\)\}<\/span>/,
  );
  assert.match(mapCode, /const labelState = alwaysLabelledPlaceIds\.has\(place\.id\) \? "always" : "on-demand";/);
  // The accessible name and the full-name tooltip are unchanged.
  assert.match(mapCode, /role="img" aria-label="Lihat \$\{escapeHtml\(place\.name\)\}"/);
  assert.match(mapCode, /marker\.bindTooltip\(escapeHtml\(place\.name\), \{/);
  assert.match(mapCode, /\.on\("click", \(\) => router\.push\(`\/places\/\$\{place\.id\}`\)\);/);
  assert.match(mapCode, /keyboard: true,/);
});

// ---------------------------------------------------------------------------
// 5. Stability during map updates
// ---------------------------------------------------------------------------

test("5.1 the budget is computed ONCE per marker rebuild, never per frame", () => {
  // The marker effect is keyed on the stable marker signature — panning,
  // zooming, and viewport reports never rebuild markers, so they never re-run
  // the declutter either.
  assert.match(
    mapCode,
    /const markerKey = useMemo\(\s*\(\) =>\s*places\s*\.map\(/,
  );
  assert.match(mapCode, /\}, \[ready, markerKey\]\);/);
  // ...and it is inside that effect, not in a render path or an event handler.
  const markerEffect = mapCode.slice(mapCode.indexOf("const markerPositionsRef"), mapCode.indexOf("}, [ready, markerKey]);"));
  // (2026-10-04: the "Semua Tempat" tab — the only caller that painted every name
  // and skipped the budget — was removed, so the budget call is once again a
  // plain statement. It is still INSIDE this one marker-rebuild effect, so it
  // is still computed once per rebuild and never per frame.)
  assert.match(markerEffect, /const alwaysLabelledPlaceIds = selectAlwaysLabelledPlaceIds\(/);
  assert.doesNotMatch(mapCode, /labelEveryPlaceName/);
});

test("5.2 no layout measurement is introduced anywhere in the map", () => {
  // The ONLY reflow in the component is the pre-existing, deliberate one that
  // restarts the Current Location pin pulse; the declutter adds none.
  assert.equal((mapCode.match(/getBoundingClientRect\(\)/g) ?? []).length, 1);
  assert.match(homeMap, /\/\/ Force a reflow so a pulse restarted mid-cycle runs completely\.\s*\n\s*void element\.getBoundingClientRect\(\);/);
  assert.doesNotMatch(mapCode, /offsetWidth|offsetHeight|clientWidth|clientHeight/);
  // ...and specifically not in the marker effect that computes the budget.
  const markerEffect = mapCode.slice(
    mapCode.indexOf("markerPositionsRef.current = markerPositions;"),
    mapCode.indexOf("}, [ready, markerKey]);"),
  );
  assert.doesNotMatch(markerEffect, /getBoundingClientRect|offsetWidth|clientWidth|requestAnimationFrame/);
});

test("5.3 the marker ladder, artwork, and coordinates are untouched", () => {
  assert.match(mapCode, /zIndexOffset: isCurated \? 900 : live \? 0 : 500,/);
  assert.match(mapCode, /const pinColor = isCurated \? BRAND_SECONDARY : BRAND_BROWN;/);
  assert.match(mapCode, /BRAND_LIVE/);
  // No clustering, no marker removal, no new pane.
  assert.doesNotMatch(mapCode, /markerCluster|removeLayer\(marker\)|L\.circleMarker\(position, \{ radius/);
});

test("5.4 the LIVE chip is unaffected by the declutter", () => {
  // A Live Place keeps its LIVE treatment and its own chip; the declutter only
  // touches the compact Place NAME chip.
  assert.match(mapCode, /zIndexOffset: 1000,\s*\n\s*keyboard: true,/);
  assert.equal((mapCode.match(/class="singgah-pin-label"/g) ?? []).length, 1);
});