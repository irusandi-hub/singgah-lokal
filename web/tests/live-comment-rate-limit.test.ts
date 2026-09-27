import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Regression: comment rate limiting (Handoff §8 item 3, tech §6).
 *
 * Locked contract:
 *   1. Enforcement is server-side only (service layer, "server-only").
 *   2. Scope is per viewer AND per session (composite key) — viewers never
 *      bleed into each other's windows.
 *   3. A second comment inside the TUNABLE ~1/5s window is rejected
 *      (`live_comment_rate_limited`) BEFORE the window is (re)filled —
 *      denied attempts do not extend the window.
 *   4. Denial paths (auth, session, moderation, admission, rate limit) all
 *      return before the Realtime broadcast — every server-delivered
 *      comment has passed the limiter, so client-side bypass is impossible.
 *   5. The limiter's memory is bounded.
 */

const serviceSource = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/live/comments/route.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../lib/live/types.ts", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url), "utf8");

function limiterBody(source: string): string {
  const start = source.indexOf("function enforceCommentRateLimit");
  assert.ok(start > -1, "enforceCommentRateLimit must exist in the service layer");
  const rest = source.slice(start);
  const nextExport = rest.indexOf("\nexport ");
  return nextExport > -1 ? rest.slice(0, nextExport) : rest;
}

test("Rate limit 1: enforcement is server-side only and fail-closed", () => {
  assert.match(serviceSource, /import "server-only";/);
  // The limiter lives in the service, not in the route or any client code.
  assert.match(serviceSource, /function enforceCommentRateLimit/);
  assert.match(serviceSource, /throw new LiveValidationError\("live_comment_rate_limited"\)/);
  // The route maps the rejection to a 400 and never falls through open.
  assert.match(routeSource, /error instanceof LiveValidationError/);
  assert.match(routeSource, /status: 400/);
  // The viewer surfaces the rejection message.
  assert.match(viewerSource, /live_comment_rate_limited/);
});

test("Rate limit 2: scope is per viewer AND per session (composite key)", () => {
  // The post path keys the window by session + user together — a different
  // viewer or a different session never shares a window.
  assert.match(serviceSource, /enforceCommentRateLimit\(`\$\{params\.sessionId\}:\$\{params\.userId\}`\)/);
  const limiter = limiterBody(serviceSource);
  // The window is read and written under the same composite key.
  assert.match(limiter, /commentTimestamps\.get\(viewerKey\)/);
  assert.match(limiter, /commentTimestamps\.set\(viewerKey, timestamps\)/);
});

test("Rate limit 3: a second comment inside the window is rejected before refill", () => {
  const limiter = limiterBody(serviceSource);
  // Rejection check happens BEFORE the new timestamp is pushed: denied
  // attempts never extend their own window.
  const checkOffset = limiter.indexOf("if (timestamps.length >= 1)");
  const pushOffset = limiter.indexOf("timestamps.push(now)");
  assert.ok(checkOffset > -1 && pushOffset > checkOffset);
  assert.match(limiter, /if \(timestamps\.length >= 1\)\s*\{\s*throw new LiveValidationError\("live_comment_rate_limited"\);/);
  // Window filtering uses the TUNABLE constant (Master ~1/5s; 5000 ms today).
  assert.match(limiter, /now - timestamp < LIVE_COMMENT_MIN_INTERVAL_MS/);
  assert.match(typesSource, /LIVE_COMMENT_MIN_INTERVAL_MS = 5000/);
});

test("Rate limit 4: every denial path returns before the broadcast (no bypass)", () => {
  // Order: auth -> session gate -> moderation -> admission -> rate-limited
  // post -> broadcast. Every earlier gate returns early on denial.
  const authOffset = routeSource.indexOf("auth.getUser()");
  const sessionOffset = routeSource.indexOf('session.status !== "live"');
  const moderationOffset = routeSource.indexOf("moderateLiveComment(");
  const admitOffset = routeSource.indexOf("admitLiveViewer(");
  const postOffset = routeSource.indexOf("postLiveComment(");
  const sendOffset = routeSource.indexOf("channel.send(");
  for (const [label, offset] of [
    ["auth", authOffset],
    ["session", sessionOffset],
    ["moderation", moderationOffset],
    ["admission", admitOffset],
    ["post (rate limit)", postOffset],
  ] as Array<[string, number]>) {
    assert.ok(offset > -1, `${label} gate must exist`);
    assert.ok(offset < sendOffset, `${label} gate must precede the broadcast`);
  }
  assert.ok(authOffset < sessionOffset && sessionOffset < moderationOffset);
  assert.ok(moderationOffset < admitOffset && admitOffset < postOffset);
  // Moderation rejection returns before admission/post: rejected comments
  // never reach the limiter or other viewers.
  assert.match(routeSource, /return NextResponse\.json\(\{ error: "live_comment_rejected" \}, \{ status: 400 \}\)/);
  // Unknown errors return a generic 500 without broadcasting.
  assert.match(routeSource, /error: "live_comments_unavailable"/);
});

test("Rate limit 5: limiter memory is bounded", () => {
  const limiter = limiterBody(serviceSource);
  assert.match(limiter, /commentTimestamps\.size > 10_000/);
  assert.match(limiter, /commentTimestamps\.delete\(key\)/);
});
