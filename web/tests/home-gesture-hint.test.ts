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
 *  · the "?" tile keeps its 44px touch target and is the ONLY trigger.
 */

const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const map = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
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

test("the panel opens from the \"?\" tile and toggles nothing else", () => {
  assert.match(home, /const handleShowGestureHint = useCallback\(\(\) => \{\s*setGestureHelpOpen\(true\);\s*\}, \[\]\);/);
  assert.match(home, /onShowGestureHint=\{handleShowGestureHint\}/);
  assert.match(map, /data-gesture-hint-recall/);
  assert.match(map, /onClick=\{onShowGestureHint\}/);
  assert.match(map, /aria-label="Tampilkan petunjuk gestur peta"/);
  assert.match(map, /title="Petunjuk gestur peta"/);
});

// ---------------------------------------------------------------------------
// 2. Complete, verified copy.
// ---------------------------------------------------------------------------

test("all five real gestures are documented, including one-finger scroll", () => {
  for (const copy of [
    "Dua jari geser",
    "menggeser peta.",
    "Cubit",
    "memperbesar atau memperkecil peta.",
    "Satu jari",
    "menggulir daftar Tempat saat panel penuh",
    "tidak menggeser peta.",
    "Ketuk pin",
    "memilih Tempat dan membuka kartunya",
    "Geser tab “Tempat Pilihan”",
    "memindahkannya di atas",
  ]) {
    assert.ok(panel.includes(copy), `the panel must document: ${copy}`);
  }
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

test("the \"?\" tile is 44px and sits beside \"Lokasi Saya\" in one row", () => {
  assert.match(map, /onShowGestureHint\?: \(\) => void;/);
  assert.match(map, /onShowGestureHint,\n\}: HomeMapProps\)/);
  assert.match(map, /<div className="absolute right-3 top-\[190px\] z-\[1100\] flex flex-nowrap items-center gap-2">/);
  assert.match(map, /<span aria-hidden className="pointer-events-auto absolute -inset-0\.5" \/>/);
  assert.match(map, /<span aria-hidden className="text-\[15px\] font-bold leading-none">\?<\/span>/);
  // Two tiles, no third, no wrap.
  assert.equal((map.match(/h-10 w-10/g) ?? []).length, 2);
  assert.equal((map.match(/flex-nowrap/g) ?? []).length, 1);
});

test("the reset the panel offers is wired to the floating tab, not the camera", () => {
  assert.match(panel, /Kembalikan tab ke posisi awal/);
  assert.match(panel, /onClick=\{resetCuratedTabPlacement\}/);
  assert.match(home, /import CuratedMapTab, \{ resetCuratedTabPlacement \} from "@\/components\/curated-map-tab";/);
  assert.equal((panel.match(/setCameraRequestNonce/g) ?? []).length, 0);
  assert.equal(home.includes("resetNonce"), false, "the reset is imperative, not a nonce the tab watches");
});
