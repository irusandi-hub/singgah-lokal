import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Realtime unread for the header bell (MASTER 10 §9 unread count/badge, §21
 * in-app center, §14 recipient authorization).
 *
 * Locked contract:
 *   1. the badge still reads the canonical, RLS-scoped count from
 *      /api/notifications — Realtime is a display signal only, never the
 *      source of truth;
 *   2. the bell joins exactly ONE private channel, its own
 *      `notifications:{userId}` topic, authenticated with the caller's own
 *      token from the caller-owned token endpoint;
 *   3. it listens only to the allow-listed 'unread' broadcast event and
 *      validates the payload before it touches state — no database
 *      subscription, no presence, and no polling as a fallback;
 *   4. subscription lifecycle is clean: a denied join and an unmount both
 *      tear the dynamic client down completely, so a stale listener can never
 *      survive a sign-out or a session change;
 *   5. the database is the sender: the broadcast comes from a trigger on the
 *      notifications table (0029), not from the client.
 */

const bellSource = readFileSync(new URL("../components/notification-bell.tsx", import.meta.url), "utf8");
const tokenRouteSource = readFileSync(new URL("../app/api/auth/realtime-token/route.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../supabase/migrations/0029_notification_fanout.sql", import.meta.url), "utf8");
const inboxSource = readFileSync(new URL("../app/notifications/page.tsx", import.meta.url), "utf8");

test("Unread 1: the count stays canonical — fetched from the owner-scoped API", () => {
  assert.match(bellSource, /fetch\("\/api\/notifications", \{ cache: "no-store" \}\)/);
  assert.match(bellSource, /response\.status === 401/);
  // The signal never becomes the source of truth: no unread count is persisted
  // in the browser and nothing is cached across a reload.
  assert.doesNotMatch(bellSource, /localStorage|sessionStorage|indexedDB/);
});

test("Unread 2: exactly one private channel on the recipient's own topic", () => {
  assert.match(bellSource, /function unreadTopic\(userId: string\): string \{\s*return `notifications:\$\{userId\}`;/);
  assert.match(bellSource, /client\.channel\(unreadTopic\(userId\)/);
  assert.match(bellSource, /private: true, broadcast: \{ self: false \}/);
  // One channel only — no wildcard or shared topic.
  const channels = [...bellSource.matchAll(/client\.channel\(/g)].length;
  assert.equal(channels, 1, "the bell must open exactly one channel");
});

test("Unread 3: the channel is authenticated with the caller's own token", () => {
  assert.match(bellSource, /fetch\("\/api\/auth\/realtime-token", \{ cache: "no-store" \}\)/);
  assert.match(bellSource, /accessToken: async \(\) => accessToken/);
  // The endpoint hands back only the caller's own session data.
  assert.match(tokenRouteSource, /accessToken, userId/);
  assert.match(tokenRouteSource, /status: 401/);
  assert.doesNotMatch(tokenRouteSource, /SUPABASE_SERVICE_ROLE|service_role/);
});

test("Unread 4: only the allow-listed event, with a validated payload", () => {
  const events = [...bellSource.matchAll(/channel\.on\("broadcast", \{ event: "([a-z_]+)" \}/g)].map((m) => m[1]);
  assert.deepEqual(events, ["unread"], "no wildcard listener, no database subscription");
  assert.doesNotMatch(bellSource, /postgres_changes/);
  assert.doesNotMatch(bellSource, /presence/);
  // The broadcast count is validated before it reaches the badge.
  assert.match(bellSource, /Number\.isFinite\(next\) && next >= 0/);
});

test("Unread 5: no polling replaces Realtime", () => {
  assert.doesNotMatch(bellSource, /setInterval/);
  // The fetch is still event-driven: mount, route change, session change.
  assert.match(bellSource, /useEffect\(\(\) => load\(\), \[load, pathname\]\)/);
  assert.match(bellSource, /SESSION_CHANGED_EVENT/);
});

test("Unread 6: lifecycle — a denied join and an unmount both tear the client down", () => {
  // A channel error is fail-closed: no lingering listener.
  assert.match(bellSource, /if \(status === "CHANNEL_ERROR"\) \{/);
  assert.match(bellSource, /void client\?\.removeAllChannels\(\);/);
  // Unmount/session change removes ALL channels and drops the client reference.
  const cleanupOffset = bellSource.indexOf("return () => {", bellSource.indexOf("unreadTopic(userId)"));
  const teardown = bellSource.slice(cleanupOffset, cleanupOffset + 400);
  assert.match(teardown, /cancelled = true/);
  assert.match(teardown, /removeAllChannels\(\)/);
  assert.match(teardown, /client = null/);
  // The client reference is retained so cleanup can always tear it down.
  assert.match(bellSource, /let client: [^=]+\| null = null/);
  // A sign-in/sign-out re-opens the topic for the new session.
  assert.match(bellSource, /setSessionVersion\(\(version\) => version \+ 1\)/);
  assert.match(bellSource, /\[sessionVersion\]/);
});

test("Unread 7: the sender is the database, addressed to the row's recipient", () => {
  assert.match(migrationSource, /create or replace function public\.broadcast_notification_unread\(\)/);
  assert.match(migrationSource, /security definer/);
  assert.match(
    migrationSource,
    /after insert or update of read_at on public\.notifications/,
    "the signal fires on creation AND when the recipient marks one read",
  );
  assert.match(migrationSource, /'notifications:' \|\| new\.user_id::text/);
  // The topic is derived from the row, never from client input.
  assert.doesNotMatch(migrationSource, /p_topic\s*text,\s*p_user/);
});

test("Unread 8: the recipient gate and the existing inbox UX are untouched", () => {
  assert.match(migrationSource, /create policy notifications_realtime_receive/);
  assert.match(migrationSource, /realtime\.topic\(\) = 'notifications:' \|\| auth\.uid\(\)::text/);
  // The inbox, the badge rule, and the settings surface are not redesigned.
  assert.match(inboxSource, /listUserNotifications/);
  assert.match(bellSource, /formatUnreadBadge\(unreadCount\)/);
  assert.match(bellSource, /href="\/notifications"/);
});
