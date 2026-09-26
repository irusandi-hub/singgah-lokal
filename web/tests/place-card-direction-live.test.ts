import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDirectionsUrl, stopNestedCardAction } from "../lib/live/ui";

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    // Multi-line block comments first (JSDoc/docstrings), then line comments.
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const code = stripComments(homeDiscovery);
const mapCode = stripComments(homeMap);

// --- Direction ------------------------------------------------------------

test("Place with canonical coordinates → Direction builds a real maps directions URL", () => {
  // The pure helper is the single source of the directions target.
  const url = buildDirectionsUrl({ latitude: -6.9, longitude: 107.6 });
  assert.ok(url);
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=-6\.9,107\.6$/);
  // Universal URL (api=1): no fallback coordinate, no invented destination.
  assert.match(homeDiscovery, /buildDirectionsUrl\(place\)/);
  assert.match(code, /window\.open\(directionsUrl, "_blank", "noopener,noreferrer"\)/);
});

test("Nested-action guard stops the synthetic event completely", () => {
  // Unit contract: BOTH suppression mechanisms are engaged — Next Link on
  // the card navigates through the synthetic default; bubbling would fire
  // the anchor's click handler.
  let prevented = false;
  let stopped = false;
  stopNestedCardAction({
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test("Place without coordinates → Direction is safely disabled (no invented target)", () => {
  // Fail-closed contract of the pure helper...
  assert.equal(buildDirectionsUrl({ latitude: null, longitude: null }), null);
  assert.equal(buildDirectionsUrl({ latitude: Number.NaN, longitude: 107.6 }), null);
  assert.equal(buildDirectionsUrl({ latitude: -6.9, longitude: Number.NaN }), null);
  // ...rendered as a safe disabled affordance, not a broken link.
  assert.match(code, /aria-disabled="true"/);
  assert.match(code, /Koordinat Place belum tersedia/);
  // The disabled affordance must be a <span> — an <a> without href would be
  // invalid HTML inside the card anchor.
  assert.equal(/<a[^>]*aria-disabled/.test(code), false, "disabled Direction must not be an anchor");
});

test("Clicking Direction never opens the parent Place card", () => {
  // The guard stops BOTH the synthetic navigation of the wrapping anchor and
  // event bubbling — otherwise Next Link on the card would fire.
  assert.match(code, /stopNestedCardAction/);
  // Both nested controls (Direction + LIVE) go through the guard.
  const guardCalls = code.match(/stopNestedCardAction\(event\);/g) ?? [];
  assert.ok(guardCalls.length >= 2, "Direction and LIVE controls must stop the parent card action");
  // Direction opens in a new tab and never navigates the card itself.
  assert.match(code, /window\.open\(directionsUrl/);
  assert.equal(/<a[^>]*aria-label="Petunjuk arah/.test(code), false, "Direction must not be an anchor inside the card anchor");
});

// --- Permanent LIVE identity ----------------------------------------------

test("Every Place card carries a LIVE affordance in BOTH states", () => {
  // LIVE branch (active session)...
  assert.match(code, /live \? \(/);
  assert.match(code, /LIVE — Lihat proses sekarang/);
  // ...and NOT LIVE branch (no session) — the indicator never disappears.
  assert.match(code, /LIVE — Belum berlangsung/);
  // The old card hid the LIVE affordance for non-live Places (chevron only);
  // the permanent identity renders it unconditionally per card.
  assert.match(code, /nonLiveNoticePlaceId/);
});

test("Place LIVE → the indicator opens the existing /live/[sessionId] flow", () => {
  assert.match(code, /router\.push\(`\/live\/\$\{live\.sessionId\}`\)/);
  // The card link and the LIVE button use the same canonical session.
  assert.match(code, /href=\{live \? `\/live\/\$\{live\.sessionId\}` : `\/places\/\$\{place\.id\}`\}/);
});

test("Place NOT LIVE → pressing the indicator shows the honest non-live status", () => {
  // Pressing toggles a per-Place notice; live state itself is never invented.
  assert.match(code, /setNonLiveNoticePlaceId\(\(current\) => \(current === place\.id \? null : place\.id\)\)/);
  assert.match(code, /aria-pressed=\{nonLiveNoticePlaceId === place\.id\}/);
  assert.match(code, /role="status"/);
  assert.match(code, /sedang tidak Live\. Place ini dapat memulai Live kapan saja\./);
});

// --- Distance --------------------------------------------------------------

test("Card distance uses the real viewer fix and canonical Place coordinates", () => {
  // The existing shared haversine implementation is reused (no duplicate).
  assert.match(code, /formatDistance\(\s*distanceMeters\(viewerPosition/);
  // Never a hardcoded/fabricated distance: the row only renders with a real
  // viewerPosition and real Place lat/lng.
  assert.match(code, /viewerPosition && place\.latitude != null && place\.longitude != null/);
  assert.doesNotMatch(code, /distance\s*=\s*\d/);
});

// --- Existing navigation preserved -----------------------------------------

test("Existing Place navigation and map behavior stay untouched", () => {
  // Card link still routes to /places/[id] for non-live Places.
  assert.match(code, /href=\{live \? `\/live\/\$\{live\.sessionId\}` : `\/places\/\$\{place\.id\}`\}/);
  // Map markers keep their canonical click flows and the Leaflet config is
  // untouched by this task (scope lock).
  assert.match(mapCode, /router\.push\(`\/places\/\$\{place\.id\}`\)/);
  assert.match(mapCode, /router\.push\(`\/live\/\$\{live\.sessionId\}`\)/);
  assert.match(mapCode, /maxBoundsViscosity: 1\.0/);
  assert.match(mapCode, /worldCopyJump: false/);
  // Marker stacking order unchanged (scope lock: no interaction changes).
  assert.match(mapCode, /zIndexOffset: live \? 0 : 500/);
  // Color treatment (PO 2026-09-26, colors only): Place pins/labels use the
  // deep brand green for tile contrast; the accent stays on the viewer's
  // own location marker; LIVE keeps its red priority.
  assert.match(mapCode, /BRAND_PIN = "var\(--brand-primary-deep\)"/);
  assert.match(mapCode, /BRAND_BROWN = "var\(--brand-accent\)"/);
  assert.match(mapCode, /BRAND_LIVE = "var\(--live\)"/);
});
