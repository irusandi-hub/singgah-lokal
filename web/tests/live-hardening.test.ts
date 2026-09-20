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
const homeSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
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
  assert.match(homeSource, /<HomeMap places=\{mapPlaces\} liveByPlaceId=\{liveByPlaceId\} \/>/);
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
