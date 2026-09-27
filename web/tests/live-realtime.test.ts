import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Regression: Live Realtime flow (Handoff §7, tech §6).
 *
 * Locked contract:
 *   1. Server comment publish checks the delivery outcome — a failed
 *      broadcast is never reported as `delivered: true` (Handoff §8 item 4).
 *      Supabase state stays canonical; Realtime is display transport only.
 *   2. Channels are private, server-side authorization (RLS/Realtime auth)
 *      stays the gate; the client only listens on the session topic.
 *   3. The viewer subscribes only to allow-listed events (comment, status),
 *      validates every payload, and never falls back to polling.
 *   4. Subscription lifecycle is clean: unmount tears down the dynamic
 *      client's channels AND socket — no stale listeners.
 */

const commentsRouteSource = readFileSync(new URL("../app/api/live/comments/route.ts", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url), "utf8");
const tokenRouteSource = readFileSync(new URL("../app/api/auth/realtime-token/route.ts", import.meta.url), "utf8");
const rlsSource = readFileSync(new URL("../supabase/migrations/0009_live_realtime_private_channels.sql", import.meta.url), "utf8");

test("Realtime 1: server publish outcome is checked, failures are not delivered", () => {
  // The broadcast result is captured and gated before reporting success.
  assert.match(commentsRouteSource, /const delivery = await channel\.send\(/);
  assert.match(commentsRouteSource, /if \(delivery !== "ok"\)/);
  assert.match(commentsRouteSource, /live_comment_delivery_failed/);
  assert.match(commentsRouteSource, /status: 503/);
  // The channel is still torn down after the attempt (no per-request leak).
  assert.match(commentsRouteSource, /await channel\.unsubscribe\(\)/);
  const sendOffset = commentsRouteSource.indexOf("await channel.send(");
  const unsubscribeOffset = commentsRouteSource.indexOf("await channel.unsubscribe()");
  assert.ok(unsubscribeOffset > sendOffset, "the per-request channel must be unsubscribed");
});

test("Realtime 2: private channels on both server and client; topic is the session", () => {
  assert.match(commentsRouteSource, /private: true/);
  assert.match(viewerSource, /private: true, broadcast: \{ self: false \}/);
  assert.match(commentsRouteSource, /live_session:\$\{sessionId\}/);
  assert.match(viewerSource, /live_session:\$\{sessionId\}/);
});

test("Realtime 3: viewer listens only to allow-listed events with validated payloads", () => {
  // Exactly the two Master §6 display events, no wildcard or DB subscription.
  const events = [...viewerSource.matchAll(/channel\.on\("broadcast", \{ event: "([a-z_]+)" \}/g)].map((m) => m[1]);
  assert.deepEqual(events.sort(), ["comment", "status"]);
  assert.doesNotMatch(viewerSource, /postgres_changes/);
  assert.doesNotMatch(viewerSource, /presence/);
  // Payloads are validated before entering state: comment bodies must be
  // strings, the ended signal must explicitly carry status "ended".
  assert.match(viewerSource, /typeof message\?\.payload\?\.body === "string"/);
  assert.match(viewerSource, /message\?\.payload\?\.status === "ended"/);
  // No polling replaces Realtime (tech §6 display-transport-only).
  assert.doesNotMatch(viewerSource, /setInterval/);
});

test("Realtime 4: unmount tears down the dynamic client fully (no stale listeners)", () => {
  // The cleanup removes ALL channels of the dynamically created client —
  // unsubscribing the channel alone would leave the socket open.
  const cleanupOffset = viewerSource.indexOf("return () => {", viewerSource.indexOf("live_session:"));
  const teardown = viewerSource.slice(cleanupOffset, cleanupOffset + 400);
  assert.match(teardown, /cancelled = true/);
  assert.match(teardown, /removeAllChannels\(\)/);
  assert.match(teardown, /client = null/);
  // The client reference is retained so cleanup can always tear it down.
  assert.match(viewerSource, /let client: [^=]+\| null = null/);
});

test("Realtime 6: server publish presents the authenticated user JWT (RLS 0009)", () => {
  // The private send policy (0009) evaluates auth.uid() from the JWT the
  // request carries — the server must set it on the realtime client before
  // broadcasting, or the send is (correctly) denied.
  const setAuthOffset = commentsRouteSource.indexOf("supabase.realtime.setAuth(");
  const sendOffset = commentsRouteSource.indexOf("await channel.send(");
  assert.ok(setAuthOffset > -1, "the server must attach the user JWT to realtime");
  assert.ok(setAuthOffset < sendOffset, "setAuth must precede the broadcast");
  assert.match(commentsRouteSource, /auth\.getSession\(\)/);
  assert.match(commentsRouteSource, /sessionData\?\.session\?\.access_token/);
});

test("Realtime 7: viewer presents its own JWT via the caller-owned token endpoint", () => {
  // The dynamic client resolves the viewer's own access token so the private
  // join passes RLS — through the ssr browser client (cookie session),
  // never by embedding provider credentials client-side.
  assert.match(viewerSource, /createBrowserClient/);
  assert.match(viewerSource, /accessToken: async \(\) =>/);
  assert.match(viewerSource, /\/api\/auth\/realtime-token/);
  // Token fetch failures resolve to null — no pseudo-public fallback channel.
  assert.match(viewerSource, /return null;/);
  assert.doesNotMatch(viewerSource, /SUPABASE_SERVICE_ROLE|service_role/);
  // The endpoint hands callers only their OWN token: no service key, no
  // cross-user data, unauthenticated callers denied, response uncacheable.
  assert.match(tokenRouteSource, /auth\.getSession\(\)/);
  assert.match(tokenRouteSource, /authentication_required/);
  assert.match(tokenRouteSource, /no-store/);
  assert.doesNotMatch(tokenRouteSource, /service_role|SERVICE_ROLE/);
});

test("Realtime 8: private-channel RLS remains the authority; invalid joins fail closed", () => {
  // Migration 0009: receive is admitted-viewer scoped, send is admitted
  // viewer or owner/manager producer scoped, broadcast extension only.
  assert.match(rlsSource, /create policy live_realtime_receive/);
  assert.match(rlsSource, /create policy live_realtime_send/);
  assert.match(rlsSource, /live_viewers v/);
  assert.match(rlsSource, /admitted_at > now\(\) - interval '5 minutes'/);
  assert.match(rlsSource, /producer_memberships/);
  assert.match(rlsSource, /role in \('owner', 'manager'\)/);
  assert.match(rlsSource, /extension = 'broadcast'/);
  // A rejected join tears the client's channels down (no stale listener).
  assert.match(viewerSource, /status === "CHANNEL_ERROR"/);
  assert.match(viewerSource, /removeAllChannels\(\)/);
});

test("Realtime 5: sequence stays server-issued on the gated send path", () => {
  // The sequence is server-issued inside the broadcast payload (tech §6),
  // never client time.
  assert.match(commentsRouteSource, /nextLiveCommentSequence\(sessionId\)/);
  assert.doesNotMatch(commentsRouteSource, /sequence: Date\.now\(\)/);
  // The broadcast payload carries no client-trusted fields beyond the
  // authenticated author and the moderated comment body.
  assert.match(commentsRouteSource, /authorId: userData\.user\.id/);
});
