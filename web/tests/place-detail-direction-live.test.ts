import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDirectionsUrl } from "../lib/live/ui";

const placePage = readFileSync(new URL("../app/places/[id]/page.tsx", import.meta.url), "utf8");
const liveStatus = readFileSync(new URL("../app/places/[id]/PlaceLiveStatus.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    // Multi-line block comments first (JSDoc/docstrings), then line comments.
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const pageCode = stripComments(placePage);
const liveCode = stripComments(liveStatus);

// --- Direction on Place detail ----------------------------------------------

test("Place detail always renders the Direction attribute (both states)", () => {
  // With coordinates: a real anchor into the maps directions flow...
  assert.match(pageCode, /buildDirectionsUrl\(place\) \? \(/);
  assert.match(pageCode, /href=\{buildDirectionsUrl\(place\) as string\}/);
  // ...and without coordinates: the attribute stays visible but disabled.
  assert.match(pageCode, /aria-disabled="true"/);
  assert.match(pageCode, /Koordinat Place belum tersedia/);
});

test("Direction uses ONLY canonical Place coordinates through the shared helper", () => {
  // The helper is the single builder (no parallel coordinate parsing)...
  assert.equal(pageCode.match(/buildDirectionsUrl\(/g)?.length, 2, "helper guards both render branches");
  // ...no fallback coordinates and no invented destination anywhere (only
  // coordinate-like literals are banned — "export default" is unrelated).
  assert.doesNotMatch(pageCode, /-\d+\.\d+\s*,\s*\d+\.\d+|lat:\s*-|lng:\s*-|destination=/);
  // The shared helper stays fail-closed on missing/non-finite coordinates.
  assert.equal(buildDirectionsUrl({ latitude: null, longitude: null }), null);
  assert.equal(buildDirectionsUrl({ latitude: Number.NaN, longitude: 0 }), null);
  const url = buildDirectionsUrl({ latitude: -6.9, longitude: 107.6 });
  assert.match(url ?? "", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=-6\.9,107\.6$/);
});

test("Direction opens the maps navigation target without touching the Place flow", () => {
  // External navigation, hardened; the existing Place flow is not reordered.
  assert.match(pageCode, /target="_blank"/);
  assert.match(pageCode, /rel="noopener noreferrer"/);
  assert.match(pageCode, /aria-labelledby="experiences-heading"/);
  assert.match(pageCode, /aria-labelledby="story-heading"/);
});

// --- Permanent LIVE on Place detail ------------------------------------------

test("Place detail always has a LIVE indicator — never returns null", () => {
  // The permanent indicator renders in BOTH states; the old `return null`
  // gap is locked out forever.
  assert.equal(liveCode.includes("return null"), false, "PlaceLiveStatus must never render nothing");
  // LIVE state...
  assert.match(liveCode, /LIVE SEKARANG/);
  // ...and not-live state: indicator stays visible and expandable.
  assert.match(liveCode, /LIVE — Tidak sedang berlangsung/);
  assert.match(liveCode, /<details/);
  assert.match(liveCode, /<summary/);
});

test("LIVE active → the action opens the real /live/[sessionId] flow", () => {
  assert.match(liveCode, /href=\{`\/live\/\$\{session\.id\}`\}/);
  // The active process title renders when the stage is available.
  assert.match(liveCode, /stage\?\.title \?\? "Proses produksi"/);
});

test("LIVE inactive → honest unavailable status, no fabricated session", () => {
  assert.match(liveCode, /Place ini sedang tidak Live\./);
  // No fake session id anywhere — the not-live branch renders no link.
  const notLiveBranch = liveCode.slice(liveCode.indexOf("// Not live"));
  assert.equal(/\/live\//.test(notLiveBranch), false, "not-live branch must not link to a session");
  // "Has history" never means "is live": only status='live' rows count.
  assert.match(liveCode, /\.eq\("status", "live"\)/);
  assert.equal(liveCode.includes("ended"), false, "ended/history sessions must not render the live state");
});

test("No fake operating hours and no fake distance are invented on Place detail", () => {
  // The canonical Place model has no operating-hours field (DATA GAP) —
  // nothing may render a "Buka/Tutup" status.
  assert.equal(/Buka|Tutup|buka\s*[-–]\s*\d|operating/i.test(pageCode), false);
  assert.equal(/Buka|Tutup/i.test(liveCode), false);
  // No viewer distance is fabricated on the Place detail page either: no
  // geolocation, no hardcoded coordinates, no fallback position.
  assert.equal(pageCode.includes("geolocation"), false);
  assert.equal(/distanceMeters|formatDistance/.test(pageCode), false);
});

test("LIVE session logic stays canonical (no policy change)", () => {
  // Same canonical query as before (place_id + status='live' + maybeSingle).
  assert.match(liveCode, /\.from\("live_sessions"\)/);
  assert.match(liveCode, /\.eq\("place_id", placeId\)/);
  assert.match(liveCode, /\.maybeSingle\(\)/);
  // Duration-cap healing is unchanged.
  assert.match(liveCode, /isPastLiveDurationCap/);
  assert.match(liveCode, /applyLiveDurationCap/);
});
