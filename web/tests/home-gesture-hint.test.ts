import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * GESTURE HELP PANEL (2026-10-21).
 *
 * The automatic pill, its ~3 s timer, and the "already seen" localStorage flag
 * are GONE. Help is now a PANEL that appears only when the "?" control in the
 * map's two-tile column is tapped, and it stays until the visitor closes it.
 *
 * What is locked here:
 *  · there is no automatic appearance, no timer, and no persisted seen flag;
 *  · the panel lists five verified behaviours at ≥13px on an OPAQUE surface
 *    whose text contrast is ≥4.5:1 (measured from the real CSS tokens);
 *  · it closes with a 44×44 button, an outside tap, and Esc;
 *  · it never covers the OSM attribution (its bottom edge sits above the
 *    credit's band, not over it);
 *  · it is INFORMATION ONLY (2026-10-22): no reset button — resetting the
 *    floating tab is the grip double tap, and nothing else;
 *  · its height is capped at 60% of the stage and it keeps a 96px top
 *    clearance, so it cannot grow over the floating logo/menu or search;
 *  · the "?" tile keeps its 44px touch target and is the ONLY trigger.
 */

const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const nav = readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

const panelStart = home.indexOf("data-gesture-help");
const panel = home.slice(panelStart - 700, panelStart + 4600);
const lifecycle = home.slice(
  home.indexOf("const closeGestureHelp = useCallback"),
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
// 1. On demand only — the old automatic hint is gone.
// ---------------------------------------------------------------------------

test("nothing shows the help automatically, and no timer or seen flag survives", () => {
  assert.match(home, /const \[gestureHelpOpen, setGestureHelpOpen\] = useState\(false\);/);
  assert.match(home, /\{gestureHelpOpen && \(/);
  // The retired mechanism: pill state, visible window, timeout ref, storage key.
  for (const removed of [
    "gestureHintVisible",
    "GESTURE_HINT_VISIBLE_MS",
    "GESTURE_HINT_SEEN_KEY",
    "gestureHintSeenRef",
    "gestureHintTimerRef",
    "setGestureHintVisible",
    "data-gesture-hint=",
  ]) {
    assert.equal(home.includes(removed), false, `${removed} must be removed from Home`);
  }
  assert.equal(home.includes("singgah.gestureHintSeen"), false, "the seen flag is not used any more");
  // No mount-time timer may show OR hide the panel.
  assert.equal(/useEffect\(\(\) => \{\s*(?:const|window\.setTimeout)[\s\S]{0,80}gestureHelpOpen/.test(home), false);
});

test("the panel opens from the header \"?\" control and toggles nothing else", () => {
  assert.match(home, /const handleShowGestureHint = useCallback\(\(\) => \{\s*setGestureHelpOpen\(true\);\s*\}, \[\]\);/);
  assert.match(home, /<SiteNav floating onShowGestureHint=\{handleShowGestureHint\} \/>/);
  // 2026-10-23: the trigger moved from the map column into the header row,
  // immediately left of the bell / signed-out auth buttons.
  assert.match(nav, /data-gesture-hint-recall/);
  assert.match(nav, /onClick=\{onShowGestureHint\}/);
  assert.match(nav, /aria-label="Tampilkan petunjuk gestur peta"/);
  assert.match(nav, /title="Petunjuk gestur peta"/);
  assert.doesNotMatch(map, /data-gesture-hint-recall|onShowGestureHint/);
});

// ---------------------------------------------------------------------------
// 2. Complete, verified copy.
// ---------------------------------------------------------------------------

test("the five real gestures plus the grip reset are documented, in tightened copy", () => {
  for (const copy of [
    "Dua jari geser",
    "menggeser peta.",
    "Cubit",
    "memperbesar atau memperkecil peta.",
    "Satu jari",
    "menggulir daftar saat panel penuh",
    "Ketuk pin",
    "membuka kartu Tempat di daftar",
    "Geser tab “Tempat Pilihan”",
    "memindahkannya di atas peta",
    "Ketuk dua kali grip tab",
    "kembali ke posisi awal",
  ]) {
    assert.ok(panel.includes(copy), `the panel must document: ${copy}`);
  }
  // Six rows: the five gestures plus the reset hint that replaced the button.
  assert.equal((panel.match(/<li className="flex items-start gap-2 py-1\.5">/g) ?? []).length, 6);
  // The old inaccurate claim ("one finger scrolls the page") is not reintroduced.
  assert.equal(home.includes("Satu jari: menggulir halaman"), false);
  // The two-finger map gestures are exactly what Leaflet TouchZoom performs
  // (pinch midpoint = pan, distance = zoom).
  assert.match(map, /two-finger|Two-finger|TouchZoom/);
});

test("13px minimum body text on a SOLID surface at ≥4.5:1 contrast", () => {
  const rows = panel.match(/text-\[13px\]/g) ?? [];
  assert.ok(rows.length >= 5, `five rows must be at least 13px (found ${rows.length})`);
  assert.equal(/text-\[(?:10|11|12)px\][^"]*leading-snug/.test(panel), false);
  // Opaque, not translucent: no alpha suffix and no backdrop blur.
  assert.match(panel, /bg-white p-3 text-brand-ink/);
  assert.doesNotMatch(panel, /bg-white\/\d|backdrop-blur/);
  const ink = /--brand-ink:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
  assert.ok(ink, "the brand ink token must exist");
  const ratio = contrast(ink!, "#ffffff");
  assert.ok(ratio >= 4.5, `ink on white must reach 4.5:1 (got ${ratio.toFixed(2)}:1)`);
  // Documented measured value: 15.9:1 — AAA by a wide margin.
  assert.ok(ratio > 15, `expected ~15.9:1, got ${ratio.toFixed(2)}:1`);
});

// ---------------------------------------------------------------------------
// 3. Closing: 44px button, outside tap, Esc; focus returns to "?".
// ---------------------------------------------------------------------------

test("the close button is a real 44×44 control", () => {
  const close = panel.slice(panel.indexOf('aria-label="Tutup petunjuk gestur"'), panel.indexOf("</button>", panel.indexOf('aria-label="Tutup petunjuk gestur"')));
  assert.match(close, /h-11 w-11/);
  assert.match(close, /onClick=\{closeGestureHelp\}/);
});

test("an outside tap closes it through the backdrop", () => {
  const backdrop = home.slice(
    home.indexOf('aria-label="Tutup petunjuk gestur"\n              tabIndex={-1}'),
    home.indexOf("data-gesture-help"),
  );
  assert.match(backdrop, /absolute inset-0 z-\[1200\]/);
  assert.match(backdrop, /onClick=\{closeGestureHelp\}/);
});

test("Escape closes it and focus returns to the recall control", () => {
  assert.match(lifecycle, /if \(event\.key === "Escape"\)/);
  assert.match(lifecycle, /setGestureHelpOpen\(false\);/);
  assert.match(lifecycle, /document\.querySelector<HTMLButtonElement>\("\[data-gesture-hint-recall\]"\)\?\.focus\(\);/);
  assert.match(home, /const closeGestureHelp = useCallback\(\(\) => \{\s*setGestureHelpOpen\(false\);\s*const recall = document\.querySelector<HTMLButtonElement>\("\[data-gesture-hint-recall\]"\);/);
  // Focus moves INTO the panel on open (the close button).
  assert.match(lifecycle, /gestureHelpCloseRef\.current\?\.focus\(\)/);
  // A dialog, not a live region: opening it is an interaction, not a status.
  assert.match(panel, /role="dialog"/);
  assert.match(panel, /aria-modal="true"/);
  assert.match(panel, /aria-labelledby="gesture-help-title"/);
});

test("the panel never covers the floating chrome and is capped at 60% of the stage", () => {
  const topSafe = /const GESTURE_HELP_TOP_SAFE_PX = (\d+);/.exec(home)?.[1];
  assert.equal(topSafe, "96", "the panel's top edge stays clear of the status bar and the logo/menu");
  assert.match(home, /const GESTURE_HELP_MAX_STAGE_RATIO = 0\.6;/);
  assert.match(home, /maxHeight: Math\.max\([\s\S]{0,120}?GESTURE_HELP_MIN_HEIGHT_PX,/);
  assert.match(home, /stageHeight \* GESTURE_HELP_MAX_STAGE_RATIO,/);
  assert.match(home, /stageHeight -[\s\S]{0,120}?GESTURE_HELP_TOP_SAFE_PX,/);
  // Scrolling stays available inside the cap, so no row is ever clipped away.
  assert.match(panel, /overflow-y-auto/);
});

test("the panel is anchored clear of the OSM attribution", () => {
  // bottom = sheetVisiblePx + 56; the credit's band ends at seam − 22.
  const gap = /const GESTURE_HELP_BOTTOM_GAP_PX = (\d+);/.exec(home)?.[1];
  assert.ok(gap, "the bottom gap constant must exist");
  assert.ok(Number(gap) > 22 + 14, "the panel's bottom edge must clear the 22px credit margin and its text");
  assert.match(panel, /style=\{\{\s*bottom: sheetVisiblePx \+ GESTURE_HELP_BOTTOM_GAP_PX,/);
  // …and the credit keeps its own 22px margin above the visible seam.
  assert.match(css, /\.singgah-home-map \.leaflet-bottom \.leaflet-control-attribution \{\s*margin-bottom: 22px;/);
});

// ---------------------------------------------------------------------------
// 4. The recall tile keeps its 44px target in the two-control column.
// ---------------------------------------------------------------------------

test("the header \"?\" keeps a 44px target and the old map column is gone", () => {
  // The control is optional on the reusable header, but Home always provides
  // it. It renders before the bell (and before signed-out auth), at bell size.
  assert.match(nav, /onShowGestureHint\?: \(\) => void;/);
  assert.match(nav, /onShowGestureHint,\n\}: SiteNavProps\)/);
  assert.match(nav, /className="relative inline-flex h-10 w-10 shrink-0 touch-manipulation/);
  // 40px visual tile + a 4px out-of-flow ring on each side = the required
  // 48px hit area (measured at 360 and 390).
  assert.match(nav, /<span aria-hidden className="pointer-events-auto absolute -inset-1" \/>/);
  assert.match(nav, /<span aria-hidden className="text-\[15px\] font-bold leading-none">\?<\/span>/);
  // Exactly one "?" control and no resurrected map column.
  assert.equal((nav.match(/data-gesture-hint-recall/g) ?? []).length, 1);
  assert.doesNotMatch(map, /top-\[190px\]|absolute right-3/);
  // "Lokasi Saya" is the last cell of the one filter row, 44×44.
  assert.match(home, /data-home-locate/);
  assert.match(home, /className="relative inline-flex h-11 w-11 touch-manipulation/);
  assert.match(home, /aria-label="Lokasi saya — pusatkan peta ke lokasi aktual"/);
  assert.match(home, /grid-cols-\[auto_repeat\(3,minmax\(0,1fr\)\)_44px\]/);
});

test("the panel is information only: the close button is its ONLY control", () => {
  // 2026-10-22: the reset button was removed. The grip double tap is the one
  // reset, and no other reset UI may exist in Home.
  assert.equal(panel.includes("Kembalikan tab ke posisi awal"), false);
  assert.equal(panel.includes("resetCuratedTabPlacement"), false);
  // The slice starts at the backdrop, so exactly TWO buttons remain: the
  // invisible backdrop (an outside tap surface) and the 44px close button.
  assert.equal((panel.match(/<button/g) ?? []).length, 2, "no action button remains");
  assert.equal((panel.match(/onClick=\{closeGestureHelp\}/g) ?? []).length, 2);
  assert.match(panel, /Ketuk dua kali grip tab/);
  assert.match(home, /import CuratedMapTab from "@\/components\/curated-map-tab";/);
  assert.equal(home.includes("resetNonce"), false, "the reset is imperative, not a nonce the tab watches");
});
