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
const realtimeSource = readFileSync(new URL("../lib/live/realtime.ts", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url), "utf8");

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

test("I4: comment sequencing is server-issued, monotonic; Date.now() payload is gone", () => {
  assert.doesNotMatch(commentsRouteSource, /sequence: Date\.now\(\)/);
  assert.match(commentsRouteSource, /nextLiveCommentSequence\(sessionId\)/);
  assert.match(sequenceSource, /import "server-only";/);
  // Rate limit remains in the service layer (TUNABLE ~1/5s).
  assert.match(sessionServiceSource, /enforceCommentRateLimit/);
});

test("I5: end paths broadcast a Realtime status event and viewers subscribe to it", () => {
  assert.match(sessionServiceSource, /broadcastLiveStatus/);
  assert.match(capSource, /broadcastLiveStatus/);
  assert.match(capSource, /endedReason: "duration_cap"/);
  assert.match(realtimeSource, /event: "status"/);
  assert.match(realtimeSource, /live_session:\$\{params\.sessionId\}/);
  assert.match(viewerSource, /event: "status"/);
  // Display-signal safety: broadcast failure never breaks the end flow.
  assert.match(realtimeSource, /catch \{/);
});

test("I6: discovery route and Place strip self-heal the 60-minute cap", () => {
  assert.match(discoverySource, /applyLiveDurationCap/);
  assert.match(placeStripSource, /applyLiveDurationCap/);
  // Cap math lives in the shared helper (locked 60-minute constant).
  const capHelperSource = readFileSync(new URL("../lib/live/session-service-cap.ts", import.meta.url), "utf8");
  assert.match(capHelperSource, /LIVE_DURATION_CAP_MINUTES \* 60 \* 1000/);
  assert.match(placeStripSource, /isPastLiveDurationCap/);
  assert.match(discoverySource, /isPastLiveDurationCap/);
});
