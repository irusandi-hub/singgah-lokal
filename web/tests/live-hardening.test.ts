import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const consoleSource = readFileSync(new URL("../app/producer/live/LiveConsole.tsx", import.meta.url), "utf8");
const sessionServiceSource = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");
const capSource = readFileSync(new URL("../lib/live/session-service-cap.ts", import.meta.url), "utf8");
const commentsRouteSource = readFileSync(new URL("../app/api/live/comments/route.ts", import.meta.url), "utf8");
const discoverySource = readFileSync(new URL("../app/api/live/discovery/route.ts", import.meta.url), "utf8");
const placeStripSource = readFileSync(new URL("../app/places/[id]/PlaceLiveStatus.tsx", import.meta.url), "utf8");
const sequenceSource = readFileSync(new URL("../lib/live/sequence.ts", import.meta.url), "utf8");
const realtimeMigrationSource = readFileSync(
  new URL("../supabase/migrations/0012_live_end_idempotency.sql", import.meta.url),
  "utf8",
);
const viewerSource = readFileSync(new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url), "utf8");
const homeSource = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const homeMapSource = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");

test("I1: producer start uses a fresh per-attempt idempotency key, never a constant", () => {
  assert.doesNotMatch(consoleSource, /const START_IDEMPOTENCY_KEY = "/);
  assert.match(consoleSource, /START_IDEMPOTENCY_KEY_PREFIX = "producer-live-start"/);
  assert.match(consoleSource, /randomUUID/);
  // The key is generated inside startLive, not module-level.
  assert.match(consoleSource, /const idempotencyKey = nextIdempotencyKey\(\);/);
});

test("I3: camera check enforces the locked 720p/30fps criteria", () => {
  assert.match(consoleSource, /height >= 720/);
  assert.match(consoleSource, /frameRate >= 30/);
  // The old 24fps pass criterion is gone.
  assert.doesNotMatch(consoleSource, /frameRate >= 24/);
});

test("E2E: LIVE cards compute distance only from real viewer position + canonical Place coordinates", () => {
  // The invented reference point is gone — a hardcoded viewer location would
  // fabricate distance labels once Places gain real coordinates (PO item 7:
  // distance "bila tersedia", never a fake position).
  assert.doesNotMatch(homeSource, /lat: -6\.2/);
  assert.doesNotMatch(homeSource, /106\.816/);
  // Distance renders only when geolocation resolved AND Place coords exist.
  assert.match(homeSource, /viewerPosition && place\?\.latitude != null && place\?\.longitude != null/);
  // Geolocation is optional: denial/absence must never surface as an error.
  assert.match(homeSource, /\(\) => undefined,/);
});

test("E2E: bounded distance radii use matchesDistance and LIVE/markers follow the same filter", () => {
  // Bounded radius filtering goes through the shared matchesDistance gate
  // (haversine over viewerPosition + canonical Place lat/lng) — never a
  // coordinate-presence-only check.
  assert.match(homeSource, /matchesDistance\(/);
  assert.match(homeSource, /matchesDistance\(\s*distanceFilter,\s*viewerPosition,/);
  // LIVE is a process/status filter applied on top of the same distance gate.
  assert.match(homeSource, /liveByPlaceId\.has\(place\.id\)/);
  // Map markers derive from the filtered visiblePlaces (canonical coords
  // only) through the real Leaflet map component — not raw liveItems, and
  // the old demo layout positions are gone.
  assert.match(homeSource, /visiblePlaces\.flatMap\(\(place\) =>/);
  assert.match(homeSource, /<HomeMap\n\s+places=\{mapPlaces\}\n\s+liveByPlaceId=\{liveByPlaceId\}/);
  // Current Location is passed into the map: real geolocation only.
  assert.match(homeSource, /viewerPosition=\{viewerPosition\}/);
  assert.match(homeSource, /locateNonce=\{locateNonce\}/);
  assert.match(homeSource, /onRequestLocate=\{\(\) => setLocateNonce\(\(nonce\) => nonce \+ 1\)\}/);
  assert.doesNotMatch(homeSource, /mapPositionByPlaceId/);
  // LIVE cards also follow the filtered set.
  assert.match(homeSource, /visiblePlaces\.some\(\(place\) => place\.id === item\.placeId\)/);
});

test("E2E: Leaflet map renders only canonical Place coordinates and keeps the Place/Live links", () => {
  // Real interactive map: OpenStreetMap tiles with required attribution.
  assert.match(homeMapSource, /openstreetmap\.org/);
  // Fail-closed markers: Places without finite canonical coordinates get no
  // marker — no position is ever invented.
  assert.match(homeMapSource, /Number\.isFinite\(place\.latitude\)/);
  assert.match(homeMapSource, /Number\.isFinite\(place\.longitude\)/);
  // Marker click keeps the /places/[id] flow; LIVE pins keep /live/[sessionId].
  assert.match(homeMapSource, /router\.push\(`\/places\/\$\{place\.id\}`\)/);
  assert.match(homeMapSource, /router\.push\(`\/live\/\$\{live\.sessionId\}`\)/);
});

test("E2E: Home Leaflet marker content is HTML-escaped", () => {
  // Leaflet marker HTML is assembled manually, so canonical Place/process
  // text must be escaped before interpolation.
  assert.match(homeMapSource, /function escapeHtml\(value: string\)/);
  assert.match(homeMapSource, /escapeHtml\(live\.processTitle \?\? place\.name\)/);
  assert.match(homeMapSource, /escapeHtml\(place\.name\)/);
  assert.equal(homeMapSource.includes("${place.name}"), false);
});

test("I4: comment sequencing is server-issued, monotonic; Date.now() payload is gone", () => {
  assert.doesNotMatch(commentsRouteSource, /sequence: Date\.now\(\)/);
  assert.match(commentsRouteSource, /nextLiveCommentSequence\(sessionId\)/);
  assert.match(sequenceSource, /import "server-only";/);
  // Rate limit remains in the service layer (TUNABLE ~1/5s).
  assert.match(sessionServiceSource, /enforceCommentRateLimit/);
});

test("I2: Live end requires and forwards an explicit idempotency key", () => {
  assert.match(sessionServiceSource, /p_idempotency_key: params\.idempotencyKey/);
  assert.match(sessionServiceSource, /live_end_idempotency_key_required/);
  assert.match(consoleSource, /END_IDEMPOTENCY_KEY_PREFIX/);
  assert.match(consoleSource, /endIdempotencyKeyRef/);
});

test("I5: every DB end path emits the private Realtime status signal", () => {
  assert.doesNotMatch(sessionServiceSource, /broadcastLiveStatus/);
  assert.doesNotMatch(capSource, /broadcastLiveStatus/);
  assert.match(realtimeMigrationSource, /p_idempotency_key/);
  assert.match(realtimeMigrationSource, /end_idempotency_key/);
  assert.match(realtimeMigrationSource, /realtime\.send\(/);
  assert.match(realtimeMigrationSource, /'status'/);
  assert.match(realtimeMigrationSource, /'live_session:' \|\| p_session_id/);
  assert.match(realtimeMigrationSource, /true\s*\n\s*\);/);
  assert.match(realtimeMigrationSource, /endedReason/);
  assert.match(viewerSource, /event: "status"/);
});

/**
 * Cleanup order contract (hardening 2026-09-21):
 *
 *   1. Provider delete happens BEFORE release_live_input — the pointer is the
 *      only retry handle for a failed delete, so it must stay set until the
 *      provider confirms the input is gone.
 *   2. HTTP 404 from the provider = already-cleaned: the pointer is released.
 *   3. Any other provider failure keeps the pointer for the sweep to retry.
 */
test("Cleanup order: provider delete strictly precedes release_live_input on the end path", () => {
  // Scope to endLiveSession: startLiveSession's orphan handling also deletes
  // inputs (with its own, already-tested contract).
  const endSource = sessionServiceSource.slice(
    sessionServiceSource.indexOf("export async function endLiveSession"),
  );
  // Compare actual call sites — the prose comment also names release_live_input.
  const releaseCall = endSource.indexOf('rpc("release_live_input"');
  const deleteCall = endSource.indexOf("await deleteLiveInput(");

  assert.ok(releaseCall > -1, "endLiveSession must call release_live_input");
  assert.ok(deleteCall > -1, "endLiveSession must call deleteLiveInput");
  assert.ok(
    deleteCall < releaseCall,
    `provider delete (offset ${deleteCall}) must come before release_live_input (offset ${releaseCall})`,
  );
  // 404 = already-cleaned releases the pointer; the pointer is released via
  // the fail-closed RPC exactly once (only on confirmed cleanup).
  assert.match(endSource, /isLiveInputDeleteNotFound\(outcome\)/);
  assert.equal(
    [...endSource.matchAll(/rpc\("release_live_input"/g)].length,
    1,
    "endLiveSession must contain exactly one release_live_input call",
  );
  // A failed delete keeps the pointer for the sweep to retry.
  assert.match(endSource, /pointer stays; the ended-input sweep retries later/);
});

test("Cleanup order: ended-input sweep deletes first and releases only on confirmed cleanup", () => {
  // Scope to sweepEndedLiveInputs: the orphan sweep also deletes inputs.
  const sweepSource = capSource.slice(
    capSource.indexOf("export async function sweepEndedLiveInputs"),
  );
  const releaseCall = sweepSource.indexOf('rpc("release_live_input"');
  const deleteCall = sweepSource.indexOf("await deleteLiveInput(");

  assert.ok(releaseCall > -1, "sweepEndedLiveInputs must call release_live_input");
  assert.ok(deleteCall > -1, "sweepEndedLiveInputs must call deleteLiveInput");
  assert.ok(
    deleteCall < releaseCall,
    `sweep delete (offset ${deleteCall}) must come before release_live_input (offset ${releaseCall})`,
  );
  // Failed deletes keep the pointer in the backlog (retryable).
  assert.match(sweepSource, /outcome !== "deleted" && !isLiveInputDeleteNotFound\(outcome\)/);
  assert.match(sweepSource, /keep the pointer for retry on the next sweep/);
  // 404 = already-cleaned releases the pointer.
  assert.match(sweepSource, /isLiveInputDeleteNotFound\(outcome\)/);
});

test("I6: discovery route and Place strip self-heal the 60-minute cap", () => {
  // The discovery route became a sessionless cached public route (PO,
  // 2026-09-25): it can no longer run the privileged heal RPC — instead it
  // enforces the cap by filtering past-cap sessions out of the response via
  // the shared helper. Canonical healing still runs on the authenticated
  // Place strip path.
  assert.equal(discoverySource.includes("applyLiveDurationCap"), false, "cached public discovery must not perform privileged DB writes");
  assert.match(discoverySource, /isPastLiveDurationCap/);
  assert.match(placeStripSource, /applyLiveDurationCap/);
  // Cap math lives in the shared helper (locked 60-minute constant).
  const capHelperSource = readFileSync(new URL("../lib/live/session-service-cap.ts", import.meta.url), "utf8");
  assert.match(capHelperSource, /LIVE_DURATION_CAP_MINUTES \* 60 \* 1000/);
  assert.match(placeStripSource, /isPastLiveDurationCap/);
});
