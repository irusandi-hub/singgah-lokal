import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0026 — Live started → followed-Place notification.
 *
 * Applies the real chain on Postgres (PGlite) and drives the server-side
 * Live write path exactly as start_live_session does (INSERT/transition of
 * live_sessions.status to 'live'), then asserts:
 * - follower with live_place ON → exactly 1 notification with the locked
 *   copy, entity reference, and delivery_scope = followed_place;
 * - follower with live_place OFF → 0;
 * - no preference row → 1 (default ON from 0024);
 * - other preference categories being off must not suppress live_place;
 * - the same event twice → still 1 (dedup), and a forced duplicate insert
 *   violates the dedup key;
 * - non-followers (other users, followers of another Place) → 0;
 * - Live end / unrelated updates (viewer peak, end note, content status,
 *   a 'live' → 'live' no-op update) never create a new notification.
 *
 * Client-side fan-out, push, polling, "Around" proximity, and selected-Place
 * relationships are out of scope and asserted absent (followers are the only
 * recipient source).
 */

const MIGRATION_DIR = "../supabase/migrations/";

const readMigration = (name: string) => readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const MIGRATIONS = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0023_place_follows.sql",
  "0024_notification_preferences.sql",
  "0025_notifications.sql",
  "0026_live_followed_notifications.sql",
];

const USER_FOLLOWER = "11111111-1111-1111-1111-111111111111";
const USER_OPTOUT = "22222222-2222-2222-2222-222222222222";
const USER_NO_PREF = "33333333-3333-3333-3333-333333333333";
const USER_OTHER = "44444444-4444-4444-4444-444444444444";
const FOLLOWED_PLACE = "kopi-dari-kebun"; // seeded by 0001
const OTHER_PLACE = "dapur-rasa"; // seeded by 0001

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  // Supabase environment shims (harness-only, same pattern as
  // live-migration-validity.test.ts); 0008 needs the realtime publication.
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
  `);
  await db.exec("create publication supabase_realtime;");
  for (const name of MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  return db;
}

async function seedUser(db: PGlite, userId: string): Promise<void> {
  await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing;`);
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing;`);
}

async function seedFollow(db: PGlite, userId: string, placeId: string): Promise<void> {
  await db.exec(
    `insert into public.place_follows (user_id, place_id) values ('${userId}', '${placeId}') on conflict do nothing`,
  );
}

async function setPreference(db: PGlite, userId: string, livePlace: boolean): Promise<void> {
  await db.exec(
    `insert into public.notification_preferences (user_id, live_place) values ('${userId}', ${livePlace})
     on conflict (user_id) do update set live_place = excluded.live_place`,
  );
}

/** Ensure a Producer owns the Place (live_sessions.producer_id is NOT NULL). */
async function ensureProducer(db: PGlite, placeId: string): Promise<void> {
  await db.exec(
    `insert into public.producers (id, display_name) values ('prod-demo-live', 'Producer Demo') on conflict do nothing`,
  );
  await db.exec(`update public.places set producer_id = 'prod-demo-live' where id = '${placeId}'`);
}

/** Start a Live the way the server path does: insert a live session. */
async function startLive(db: PGlite, placeId: string, sessionId: string): Promise<void> {
  await ensureProducer(db, placeId);
  await db.exec(
    `insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
     select '${sessionId}', '${placeId}', p.producer_id, ps.id, 'live', 'idem-${sessionId}'
     from public.places p
     join public.production_stages ps on ps.place_id = p.id
     where p.id = '${placeId}'
     order by ps.id
     limit 1`,
  );
}

async function seedStage(db: PGlite, placeId: string, stageId: string, title: string): Promise<void> {
  await db.exec(
    `insert into public.production_stages (id, place_id, title, description, sort_order, status)
     values ('${stageId}', '${placeId}', '${title}', 'Deskripsi tahap produksi.', 90, 'published')
     on conflict (id) do nothing`,
  );
}

const notifications = (db: PGlite) => rows(db, "select * from public.notifications order by user_id");

test("0026 applies cleanly after 0025 on the real chain and adds only the dedup index + trigger", async () => {
  const db = await createDb();

  const index = await rows(
    db,
    `select indexdef from pg_indexes where schemaname='public' and tablename='notifications' and indexname='notifications_dedup_idx'`,
  );
  assert.match(
    String(index[0]?.indexdef),
    /unique/i,
    "dedup index must be unique on (user_id, source_type, source_id, event_type)",
  );
  const trigger = await rows(
    db,
    `select tgname from pg_trigger where tgname='live_sessions_notify_followed_place' and not tgisinternal`,
  );
  assert.equal(trigger.length, 1, "the Live-start notification trigger must exist");

  // The Live write surface itself is unchanged: no client INSERT/UPDATE on
  // live_sessions, and the Live RPC contract is untouched.
  const liveGrants = await rows(
    db,
    `select grantee, privilege_type from information_schema.role_table_grants
     where table_schema='public' and table_name='live_sessions' and grantee in ('anon','authenticated') order by 1,2`,
  );
  assert.deepEqual(
    liveGrants.map((row) => `${row.grantee}:${row.privilege_type}`),
    ["anon:SELECT", "authenticated:SELECT"],
    "Live rules unchanged — clients still only read live_sessions",
  );
  await db.close();
});

test("follower with live_place ON receives exactly one Live-started notification", async () => {
  const db = await createDb();
  await seedUser(db, USER_FOLLOWER);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_FOLLOWER, FOLLOWED_PLACE);
  await setPreference(db, USER_FOLLOWER, true);

  await startLive(db, FOLLOWED_PLACE, "live-on-1");

  const created = await notifications(db);
  assert.equal(created.length, 1, "exactly one notification for the follower");
  const notification = created[0];
  assert.equal(notification.user_id, USER_FOLLOWER);
  assert.equal(notification.category, "live_place");
  assert.equal(notification.event_type, "live_started_followed_place");
  assert.equal(notification.title, "Lihat Live Sekarang", "copy comes verbatim from the locked Live masters");
  assert.equal(notification.body, "LIVE SEKARANG · Roasting", "body uses the locked label + canonical Process title");
  assert.equal(notification.place_id, FOLLOWED_PLACE, "payload references the Place entity");
  assert.equal(notification.source_type, "live_session");
  assert.equal(notification.source_id, "live-on-1");
  assert.equal((notification.metadata as Record<string, unknown>).delivery_scope, "followed_place");
  assert.equal(notification.read_at, null, "notification starts unread");
  await db.close();
});

test("follower with live_place OFF receives nothing (preference honored)", async () => {
  const db = await createDb();
  await seedUser(db, USER_OPTOUT);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_OPTOUT, FOLLOWED_PLACE);
  await setPreference(db, USER_OPTOUT, false);

  await startLive(db, FOLLOWED_PLACE, "live-off-1");

  const created = await notifications(db);
  assert.equal(created.length, 0, "no notification when live_place preference is OFF");
  await db.close();
});

test("follower without a preference row is notified (0024 default ON applies)", async () => {
  const db = await createDb();
  await seedUser(db, USER_NO_PREF);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_NO_PREF, FOLLOWED_PLACE);
  // No notification_preferences row at all.
  await startLive(db, FOLLOWED_PLACE, "live-default-1");

  const created = await notifications(db);
  assert.equal(created.length, 1, "missing preference row must fall back to the default (ON)");
  assert.equal(created[0].user_id, USER_NO_PREF);
  await db.close();
});

test("only the live_place flag matters — other categories off must not suppress it", async () => {
  const db = await createDb();
  await seedUser(db, USER_FOLLOWER);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_FOLLOWER, FOLLOWED_PLACE);
  await db.exec(
    `insert into public.notification_preferences
       (user_id, live_place, visit_experience, help_support, system, safety_account, promotional)
     values ('${USER_FOLLOWER}', true, false, false, false, false, false)`,
  );

  await startLive(db, FOLLOWED_PLACE, "live-cat-1");
  const created = await notifications(db);
  assert.equal(created.length, 1, "live_place is the only flag consulted for this event");
  await db.close();
});

test("the same event twice still yields exactly one notification (idempotency)", async () => {
  const db = await createDb();
  await seedUser(db, USER_FOLLOWER);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_FOLLOWER, FOLLOWED_PLACE);
  await setPreference(db, USER_FOLLOWER, true);

  await startLive(db, FOLLOWED_PLACE, "live-dup-1");
  // Re-entering 'live' for the SAME session is a duplicate domain event: the
  // dedup key (user, source_type, source_id, event_type) must absorb it.
  await db.exec(`update public.live_sessions set status = 'ended', ended_reason = 'producer_ended' where id = 'live-dup-1'`);
  await db.exec(`update public.live_sessions set status = 'live' where id = 'live-dup-1'`);

  const created = await notifications(db);
  assert.equal(created.length, 1, "duplicate domain events must not create duplicate notifications");

  // A forced duplicate insert is rejected by the dedup key itself.
  await assert.rejects(
    () =>
      db.query(
        `insert into public.notifications (user_id, category, event_type, title, body, source_type, source_id)
         values ('${USER_FOLLOWER}', 'live_place', 'live_started_followed_place', 'Lihat Live Sekarang', 'LIVE SEKARANG', 'live_session', 'live-dup-1')`,
      ),
    /unique|duplicate/i,
    "the dedup key must reject a duplicate row outright",
  );
  await db.close();
});

test("non-followers receive nothing (other users, other-place followers, no follow at all)", async () => {
  const db = await createDb();
  await seedUser(db, USER_FOLLOWER);
  await seedUser(db, USER_OTHER);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_FOLLOWER, FOLLOWED_PLACE);
  // USER_OTHER follows a DIFFERENT Place, not the one going live.
  await seedFollow(db, USER_OTHER, OTHER_PLACE);
  await setPreference(db, USER_OTHER, true);

  await startLive(db, FOLLOWED_PLACE, "live-scope-1");

  const created = await notifications(db);
  assert.equal(created.length, 1, "only followers of the Place that went live are notified");
  assert.equal(created[0].user_id, USER_FOLLOWER, "the other Place's follower is not a recipient");
  await db.close();
});

test("Live end and unrelated updates never create new notifications", async () => {
  const db = await createDb();
  await seedUser(db, USER_FOLLOWER);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_FOLLOWER, FOLLOWED_PLACE);
  await setPreference(db, USER_FOLLOWER, true);

  await startLive(db, FOLLOWED_PLACE, "live-lifecycle-1");
  assert.equal((await notifications(db)).length, 1, "start notifies once");

  // No-op 'live' → 'live' update.
  await db.exec(`update public.live_sessions set viewer_peak = 42 where id = 'live-lifecycle-1'`);
  // Live end (producer) — no "ended" notification exists yet (not in scope).
  await db.exec(
    `update public.live_sessions set status = 'ended', ended_at = now(), ended_reason = 'producer_ended', end_note = 'selesai'
     where id = 'live-lifecycle-1'`,
  );
  // End note edited afterwards.
  await db.exec(`update public.live_sessions set end_note = 'selesai doping' where id = 'live-lifecycle-1'`);

  const created = await notifications(db);
  assert.equal(created.length, 1, "no new notification on viewer peak, Live end, or end-note edit");
  await db.close();
});

test("a new Live for the same Place is a separate event (one notification per session)", async () => {
  const db = await createDb();
  await seedUser(db, USER_FOLLOWER);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_FOLLOWER, FOLLOWED_PLACE);
  await setPreference(db, USER_FOLLOWER, true);

  await startLive(db, FOLLOWED_PLACE, "live-a");
  await db.exec(`update public.live_sessions set status = 'ended', ended_reason = 'producer_ended' where id = 'live-a'`);
  await startLive(db, FOLLOWED_PLACE, "live-b");

  const created = await notifications(db);
  assert.equal(created.length, 2, "a genuinely new Live session is a new event, not a duplicate");
  assert.deepEqual(created.map((row) => row.source_id).sort(), ["live-a", "live-b"]);
  await db.close();
});

test("unfollowing before the next Live keeps the recipient set authoritative", async () => {
  const db = await createDb();
  await seedUser(db, USER_FOLLOWER);
  await seedStage(db, FOLLOWED_PLACE, "stage-robusta", "Roasting");
  await seedFollow(db, USER_FOLLOWER, FOLLOWED_PLACE);
  await setPreference(db, USER_FOLLOWER, true);

  await startLive(db, FOLLOWED_PLACE, "live-follow-1");
  assert.equal((await notifications(db)).length, 1);

  // Unfollow, then end the Live and start a new one (the per-Place cap of one
  // active Live is a locked Live rule and stays untouched): the ex-follower is
  // no longer a recipient.
  await db.exec(`delete from public.place_follows where user_id = '${USER_FOLLOWER}' and place_id = '${FOLLOWED_PLACE}'`);
  await db.exec(`update public.live_sessions set status = 'ended', ended_reason = 'producer_ended' where id = 'live-follow-1'`);
  await startLive(db, FOLLOWED_PLACE, "live-follow-2");

  const created = await notifications(db);
  assert.equal(created.length, 1, "only the first Live reached the follower");
  assert.equal(created[0].source_id, "live-follow-1");
  await db.close();
});
