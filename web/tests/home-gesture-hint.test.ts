import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * GESTURE HINT — SHOWN BY THE FIRST TOUCH, NOT BY THE RENDER (2026-10-20).
 *
 * BUG: the hint was rendered visible on load and a 6-second timer was started
 * in a mount effect. Its lifetime was therefore measured from HYDRATION, not
 * from the moment a person looked at or touched the map: on a slow phone the
 * pill was already fading (or gone) by the time the map was usable — the
 * "hilang <1 detik" report. It also permanently covered the map it described
 * for those first seconds, and it came back on every visit.
 *
 * The behaviour pinned here:
 *   · hidden until the FIRST one-finger touch on the map surface;
 *   · ~3 s hold, then fade;
 *   · never while the map is still loading or the sheet is being dragged;
 *   · one "seen" flag in localStorage + a 44px "?" recall tile in the control
 *     column;
 *   · a SOLID dark-green pill with white 12px text (contrast ≥ 4.5:1), a thin
 *     border, a soft shadow and a small two-finger icon;
 *   · one component, click-through, reduced motion respected.
 */

const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

const pillStart = home.indexOf("data-gesture-hint");
const pill = home.slice(pillStart - 400, pillStart + 1600);
const trigger = home.slice(
  home.indexOf("// TRIGGER (2026-10-20)"),
  home.indexOf("const setSheetSnap = useCallback"),
);

/** WCAG relative luminance + contrast ratio, from real CSS token values. */
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
// 1. Lifetime: touch-triggered, ~3 s, remembered.
// ---------------------------------------------------------------------------

test("the hint is hidden until it is shown — no render-time appearance", () => {
  assert.match(home, /const \[gestureHintVisible, setGestureHintVisible\] = useState\(false\);/);
  assert.match(home, /\{gestureHintVisible && \(/);
  // No mount-time timer may show OR hide it again.
  assert.doesNotMatch(home, /useEffect\(\(\) => \{\s*const timer = window\.setTimeout/);
});

test("it holds ~3 s, then fades — one timer, restarted on recall", () => {
  assert.match(home, /const GESTURE_HINT_VISIBLE_MS = 3000;/);
  assert.match(
    home,
    /gestureHintTimerRef\.current = window\.setTimeout\(\(\) => \{\s*gestureHintTimerRef\.current = null;\s*setGestureHintVisible\(false\);\s*\}, GESTURE_HINT_VISIBLE_MS\);/,
  );
  // A recall clears the pending timer first, so two timers can never race.
  assert.match(home, /if \(gestureHintTimerRef\.current !== null\) \{\s*window\.clearTimeout\(gestureHintTimerRef\.current\);/);
});

test("it is triggered by the first one-finger touch on the MAP surface", () => {
  assert.match(home, /const onPointerDown = \(event: PointerEvent\) => \{/);
  assert.match(home, /node\.addEventListener\("pointerdown", onPointerDown\);/);
  // Touch/pen only — a mouse carries no touch gesture to teach.
  assert.match(trigger, /if \(event\.pointerType === "mouse" \|\| !event\.isPrimary\) return;/);
  // …and only when the touch really started on the map, never on the chrome
  // or the sheet.
  assert.match(trigger, /if \(!target\?\.closest\("\.singgah-home-map"\)\) return;/);
});

test("it never appears while the map is loading or while the sheet is dragged", () => {
  assert.match(trigger, /const sheetDragging = dragOffset !== null;/);
  assert.match(trigger, /const mapReady = mapViewport !== null;/);
  assert.match(trigger, /if \(sheetDragging \|\| gestureHintSeenRef\.current\) return;/);
  assert.match(trigger, /if \(!node \|\| !mapReady\) return;/);
  // The listener is re-bound when either gate changes, so it never reads a
  // stale drag/ready value.
  assert.match(trigger, /\}, \[mapReady, sheetDragging, showGestureHint\]\);/);
});

test("\"seen\" is stored once and honoured on the next visit", () => {
  assert.match(home, /const GESTURE_HINT_SEEN_KEY = "singgah\.gestureHintSeen";/);
  assert.match(home, /gestureHintSeenRef\.current = window\.localStorage\.getItem\(GESTURE_HINT_SEEN_KEY\) === "1";/);
  assert.match(home, /window\.localStorage\.setItem\(GESTURE_HINT_SEEN_KEY, "1"\);/);
  // The flag is read in an effect, never during render (no hydration mismatch)
  // and storage failures (private mode) degrade instead of throwing.
  assert.match(home, /useEffect\(\(\) => \{\s*try \{\s*gestureHintSeenRef\.current = window\.localStorage\.getItem/);
  assert.match(home, /catch \{\s*\/\/ Storage unavailable/);
});

// ---------------------------------------------------------------------------
// 2. Look: solid, high-contrast, readable, elegant.
// ---------------------------------------------------------------------------

test("the pill is SOLID dark green with pure white 12px text", () => {
  assert.match(pill, /bg-brand-primary-deep/);
  assert.doesNotMatch(pill, /bg-white\/85|backdrop-blur|text-brand-ink\/55/);
  assert.match(pill, /text-\[12px\] font-semibold leading-none text-white/);
  assert.match(pill, /border border-white\/25/);
  assert.match(pill, /shadow-\[0_6px_18px_rgb\(10_86_64\/0\.35\)\]/);
  // A small two-finger glyph leads the words.
  assert.match(pill, /<svg aria-hidden viewBox="0 0 24 24" width="14" height="14"/);
  assert.match(pill, /2 jari: geser &amp; cubit/);
});

test("the text clears WCAG AA (≥ 4.5:1) against its own background", () => {
  const deep = /--brand-primary-deep:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
  assert.ok(deep, "the brand token must exist");
  const ratio = contrast(deep!, "#ffffff");
  assert.ok(ratio >= 4.5, `white on ${deep} must reach 4.5:1 (got ${ratio.toFixed(2)}:1)`);
  // Documented value: 8.69:1 — comfortably AAA for large text and AA for body.
  assert.ok(ratio > 8, `expected the measured ~8.7:1, got ${ratio.toFixed(2)}:1`);
});

test("reduced motion removes the fade instead of animating through it", () => {
  assert.match(pill, /transition-opacity duration-300 motion-reduce:transition-none/);
});

test("one component, click-through, never a permanent cover", () => {
  assert.equal((home.match(/data-gesture-hint/g) ?? []).length, 1);
  assert.match(pill, /pointer-events-none absolute right-3 z-\[1100\]/);
  // The old permanent 10px/55%-ink card is gone for good.
  assert.equal(home.includes("bg-white/85 px-1.5 py-0.5 text-[10px]"), false);
});

// ---------------------------------------------------------------------------
// 3. The "?" recall control in the map's control column.
// ---------------------------------------------------------------------------

test("the control column carries a 44px \"?\" tile wired to the same hint", () => {
  assert.match(map, /onShowGestureHint\?: \(\) => void;/);
  assert.match(map, /onShowGestureHint,\n\}: HomeMapProps\)/);
  assert.match(map, /onClick=\{onShowGestureHint\}/);
  assert.match(map, /aria-label="Tampilkan petunjuk gestur peta"/);
  // 40px visual tile (the column's rhythm) + a 2px out-of-flow ring on every
  // side = the documented 44px touch target without growing the column.
  assert.match(
    map,
    /className="relative inline-flex h-10 w-10 items-center justify-center rounded-\[14px\] bg-white text-brand-ink\/80 shadow-\[0_4px_14px_rgb\(0_0_0\/0\.10\)\] ring-1 ring-black\/5 transition hover:bg-brand-cream"/,
  );
  assert.match(map, /<span aria-hidden className="pointer-events-auto absolute -inset-0\.5" \/>/);
  assert.match(map, /<span aria-hidden className="text-\[15px\] font-bold leading-none">\?<\/span>/);
  // The tile sits BESIDE "Lokasi Saya" in one 40px row, so the column bottom
  // stays at 278px and the sheet can never cover it on a short stage.
  assert.match(map, /<div className="flex items-center gap-2">/);
  assert.match(home, /onShowGestureHint=\{handleShowGestureHint\}/);
  assert.match(home, /const handleShowGestureHint = useCallback\(\(\) => \{\s*showGestureHint\(false\);\s*\}, \[showGestureHint\]\);/);
});

test("recalling the hint does not rewrite the seen flag", () => {
  // `showGestureHint(false)` shows without remembering; only the touch path
  // passes `true`.
  assert.match(trigger, /showGestureHint\(true\);/);
  assert.match(home, /const showGestureHint = useCallback\(\(remember: boolean\) => \{/);
});

test("the hint is not a live region, so a tap is not announced as status", () => {
  // The empty-state copy still explains the gesture to assistive technology;
  // the pill is a sighted-touch tip and must not hijack role="status".
  assert.doesNotMatch(pill, /role="status"/);
});
