import assert from "node:assert/strict";
import test from "node:test";
import {
  MAP_CONTROL_COLUMN_BOTTOM_PX,
  SHEET_FLICK_VELOCITY,
  SHEET_HEADER_PX,
  SHEET_MID_VISIBLE_RATIO,
  resolveSheetDrop,
  resolveSheetOffsets,
} from "@/lib/live/ui";

/**
 * RESULTS SHEET SNAP GEOMETRY (2026-10-19).
 *
 * ROOT CAUSE: the stage used `h-[100svh] min-h-[560px]`, so on a landscape
 * phone with less than 560px of visible height the stage grew past the screen
 * and the sheet (anchored to the stage bottom) sat below the visible edge. The
 * stage now uses the visible `100dvh` height and the snap offsets are derived
 * from that measured height. These tests pin the resulting geometry — they run
 * the SAME function the component uses, not a copy of the formula.
 *
 * Supported phone geometry: 360×640 and 390×844 portrait, 360×360/390×390
 * landscape. `small` keeps the 48px header, `mid` keeps the map dominant while
 * staying below the floating map controls, and `full` is always 0.
 */

const VIEWPORTS = [
  { label: "360×640", width: 360, height: 640 },
  { label: "390×844", width: 390, height: 844 },
  { label: "360×360 landscape", width: 360, height: 360 },
  { label: "390×390 landscape", width: 390, height: 390 },
] as const;

test("every requested viewport keeps a valid, ordered three-position snap", () => {
  for (const { label, height } of VIEWPORTS) {
    const offsets = resolveSheetOffsets(height);
    assert.equal(offsets.full, 0, `${label}: full must fill the stage`);
    assert.equal(offsets.small, Math.max(0, height - SHEET_HEADER_PX), `${label}: small shows exactly the header`);
    assert.ok(offsets.mid >= offsets.full, `${label}: mid cannot be above full`);
    assert.ok(offsets.mid <= offsets.small, `${label}: mid cannot be below small`);
    assert.ok(height - offsets.small === SHEET_HEADER_PX, `${label}: the handle header is always visible at small`);
  }
});

test("mid is the dominant-map default at 360 and 390 portrait widths", () => {
  for (const { label, height } of VIEWPORTS.filter((viewport) => viewport.height > 500)) {
    const offsets = resolveSheetOffsets(height);
    const visible = height - offsets.mid;
    const ratio = visible / height;
    assert.ok(
      Math.abs(ratio - SHEET_MID_VISIBLE_RATIO) < 0.01,
      `${label}: mid keeps the documented ${SHEET_MID_VISIBLE_RATIO * 100}% sheet (got ${ratio.toFixed(3)})`,
    );
    // `offset` is the sheet's top edge from the stage top, i.e. the map area
    // left above it; mid must leave the map more than half the stage.
    assert.ok(offsets.mid > height * 0.5, `${label}: the map is dominant at mid`);
  }
});

test("mid never covers the floating map control column on supported short stages", () => {
  // The column ends at 278px; the sheet's top edge at mid is `offset`.
  for (const { label, height } of VIEWPORTS) {
    const offsets = resolveSheetOffsets(height);
    assert.ok(
      offsets.mid >= MAP_CONTROL_COLUMN_BOTTOM_PX,
      `${label}: mid top ${offsets.mid} must stay below the controls (${MAP_CONTROL_COLUMN_BOTTOM_PX})`,
    );
    assert.ok(offsets.small >= MAP_CONTROL_COLUMN_BOTTOM_PX, `${label}: small stays below the controls too`);
  }
});

test("a 360px landscape stage still shows the handle and the panel tab", () => {
  const offsets = resolveSheetOffsets(360);
  // Header-only fallback: 70px visible, enough for the 48px header.
  assert.equal(360 - offsets.mid, 70);
  assert.ok(360 - offsets.mid >= SHEET_HEADER_PX);
  // The tab lives INSIDE that header now (2026-10-20), so the 44px tap target
  // only has to fit the 48px band; nothing hangs over the map or the credit.
  assert.ok(SHEET_HEADER_PX - 44 >= 0, "the 44px tab fits the 48px header band");
});

test("absurdly short stages degrade safely instead of producing negative offsets", () => {
  for (const height of [100, 64, 32, 0, -10]) {
    const offsets = resolveSheetOffsets(height);
    assert.ok(offsets.full === 0 && offsets.mid >= 0 && offsets.small >= 0);
    assert.ok(offsets.mid <= offsets.small, `${height}: mid cannot invert`);
  }
  // Below the physical minimum the mid position collapses onto small (the
  // header), which is the only honest way to keep the handle reachable.
  assert.equal(resolveSheetOffsets(320).mid, resolveSheetOffsets(320).small);
});

// ---------------------------------------------------------------------------
// Release behaviour: slow drag settles nearest, a flick advances one snap.
// ---------------------------------------------------------------------------

const OFFSETS_640 = resolveSheetOffsets(640); // full 0 · mid 371 · small 592

function drop(position: "small" | "mid" | "full", offsetPx: number, velocity: number) {
  return resolveSheetDrop({ position, offsets: OFFSETS_640, offsetPx, velocity });
}

test("a slow drag settles on the nearest snap in both directions", () => {
  // From mid: +100px is still nearest to mid (100 vs 121 to small).
  assert.equal(drop("mid", OFFSETS_640.mid + 100, 0.05), "mid");
  // +150px is nearer to small (71 vs 150).
  assert.equal(drop("mid", OFFSETS_640.mid + 150, 0.05), "small");
  // -200px is nearer to full (171 vs 200).
  assert.equal(drop("mid", OFFSETS_640.mid - 200, 0.05), "full");
  // A release exactly on a snap stays there.
  assert.equal(drop("mid", OFFSETS_640.mid, 0), "mid");
});

test("a fast flick advances exactly one snap, up or down", () => {
  assert.equal(drop("mid", OFFSETS_640.mid, 0.5), "small");
  assert.equal(drop("mid", OFFSETS_640.mid, -0.5), "full");
  // A short but fast gesture still advances one snap instead of snapping back.
  assert.equal(drop("mid", OFFSETS_640.mid + 20, 0.8), "small");
  // End clamps: no wrap-around and no invalid position.
  assert.equal(drop("full", 0, -0.8), "full");
  assert.equal(drop("small", OFFSETS_640.small, 0.8), "small");
  assert.equal(drop("small", OFFSETS_640.small, -0.8), "mid");
});

test("the flick threshold is the documented velocity, not an accident", () => {
  assert.equal(SHEET_FLICK_VELOCITY, 0.45);
  assert.equal(drop("mid", OFFSETS_640.mid + 10, SHEET_FLICK_VELOCITY), "small");
  assert.equal(drop("mid", OFFSETS_640.mid, SHEET_FLICK_VELOCITY - 0.01), "mid");
  // A non-finite sample can never be mistaken for a flick.
  assert.equal(drop("mid", OFFSETS_640.mid, Number.NaN), "mid");
});

test("the measured stage height is used directly, without a hidden floor", () => {
  // A 400px stage must yield a 400px geometry; an extra 320px clamp or 560px
  // minimum would make these differ.
  const offsets = resolveSheetOffsets(400);
  assert.equal(offsets.small, 352);
  assert.equal(400 - offsets.mid, Math.min(Math.round(400 * SHEET_MID_VISIBLE_RATIO), 400 - 290));
  assert.equal(400 - offsets.mid, 110);
});
