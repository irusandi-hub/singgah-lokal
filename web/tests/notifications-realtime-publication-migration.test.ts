import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0030 — `public.notifications` joins the `supabase_realtime`
 * publication.
 *
 * 0029 delivered the Master 10 fan-out and the private unread broadcast but
 * never registered the source table with the publication, the one step 0008
 * already performs for `live_sessions` / `live_reports`. Without it the header
 * bell can subscribe to its own private topic and still never be told that the
 * unread count moved, which MASTER 10 §9 forbids.
 *
 * These tests apply the real migration chain on Postgres (PGlite) and assert:
 * - `public.notifications` is a member of `supabase_realtime` after 0030;
 * - the 0029 fan-out and the private unread signal still behave identically
 *   with the table in the publication (no grant, policy, or row changed);
 * - re-applying 0030 is safe (alter publication raises duplicate_object);
 * - 0029 itself is untouched by this migration.
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
  "0016_producer_applications.sql",
  "0017_producer_application_refile.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
  "0023_place_follows.sql",
  "0024_notification_preferences.sql",
  "0025_notifications.sql",
  "0026_live_followed_notifications.sql",
  "0028_place_claims.sql",
  "0029_notification_fanout.sql",
  "0030_notifications_realtime_publication.sql",
];

const ADMIN = "11111111-1111-1111-1111-111111111111";
const APPLICANT = "22222222-2222-2222-2222-222222222222";

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
    create schema if not exists realtime;
    create table realtime.messages (id bigserial primary key, topic text, extension text, event text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated;
    grant select on realtime.messages to authenticated;
    create function realtime.topic() returns text language sql stable as 'select current_setting(''realtime.topic'', true)';
    create function realtime.send(p_payload jsonb, p_event text, p_topic text, p_private boolean default true)
      returns void language plpgsql as $$
      begin
        insert into realtime.messages (topic, extension, event, payload)
        values (p_topic, 'broadcast', p_event, p_payload);
      end;
      $$;
    create schema if not exists storage;
    create table if not exists storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  await db.exec("create publication supabase_realtime;");
  return db;
}

async function applyAll(db: PGlite) {
  for (const name of MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
}

const scalar = async (db: PGlite, query: string): Promise<number> => {
  const rows = ((await db.query(query)).rows ?? []) as { c?: number }[];
  return rows[0]?.c ?? 0;
};

test("0030 registers public.notifications in the supabase_realtime publication", async () => {
  const db = await freshDb();
  await applyAll(db);

  const pubCount = await scalar(
    db,
    "select count(*)::int as c from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications'",
  );
  assert.equal(pubCount, 1, "public.notifications must be a member of the supabase_realtime publication");

  // The registration must not disturb the tables 0008 already registered.
  const liveCount = await scalar(
    db,
    "select count(*)::int as c from pg_publication_tables where pubname='supabase_realtime' and tablename in ('live_sessions','live_reports')",
  );
  assert.equal(liveCount, 2, "0008's publication members must be untouched");

  await db.close();
});

test("0030 is guarded and safe to re-apply", async () => {
  const sql = readMigration("0030_notifications_realtime_publication.sql");
  assert.match(
    sql,
    /alter publication supabase_realtime add table public\.notifications;\s*exception\s+when duplicate_object then null;/,
    "the registration must be exception-guarded so a re-apply cannot fail",
  );

  const db = await freshDb();
  await applyAll(db);
  // Re-apply the file exactly as a second paste into the SQL Editor would.
  await db.exec(stripPgcrypto(readMigration("0030_notifications_realtime_publication.sql")));
  await db.exec(stripPgcrypto(readMigration("0030_notifications_realtime_publication.sql")));

  const pubCount = await scalar(
    db,
    "select count(*)::int as c from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications'",
  );
  assert.equal(pubCount, 1, "re-applying 0030 must be a no-op, never a duplicate registration");
  await db.close();
});

test("0030 adds only the publication registration; it does not re-apply 0029", async () => {
  const sql = readMigration("0030_notifications_realtime_publication.sql");
  for (const forbidden of [
    /create\s+or\s+replace\s+function/i,
    /create\s+trigger/i,
    /create\s+policy/i,
    /alter\s+table/i,
    /grant\s/i,
    /revoke\s/i,
  ]) {
    assert.doesNotMatch(sql, forbidden, "0030 must stay a single guarded publication statement");
  }
});

test("the 0029 private unread signal still fires with the table in the publication", async () => {
  const db = await freshDb();
  await applyAll(db);

  await db.exec(`
    insert into auth.users (id, email_confirmed_at) values ('${ADMIN}', now()), ('${APPLICANT}', now());
    update public.users set platform_role = 'platform_moderator' where id = '${ADMIN}';
  `);

  // Fan out an application submission; the 0029 trigger writes the row and the
  // 0029 broadcast trigger fires on the recipient's own topic.
  await db.query(
    `select public.submit_producer_application('${APPLICANT}'::uuid, 'producer@example.test', 'e2e')`,
  );

  const rows = await scalar(
    db,
    "select count(*)::int as c from public.notifications where user_id = '" + ADMIN + "'",
  );
  assert.equal(rows, 1, "the 0029 fan-out must still write exactly one notification row");

  // The database broadcast must still be emitted, and addressed to the
  // recipient's own private topic.
  const broadcast = ((await db.query(
    "select topic, event, payload from realtime.messages where extension = 'broadcast' order by id",
  )).rows ?? []) as { topic?: string; event?: string; payload?: { event?: string; unreadCount?: number } }[];
  assert.ok(broadcast.length >= 1, "the unread signal must still be broadcast");
  assert.equal(broadcast[0].topic, `notifications:${ADMIN}`, "the signal must address the recipient's own topic");
  assert.equal(broadcast[0].event, "unread", "the signal must be the 'unread' event the bell listens for");
  assert.equal(broadcast[0].payload?.unreadCount, 1, "the broadcast must carry the canonical unread count");

  // The broadcast trigger must still be installed and point at the recipient topic.
  const triggerCount = await scalar(
    db,
    "select count(*)::int as c from pg_trigger where tgname='notifications_broadcast_unread' and not tgisinternal",
  );
  assert.equal(triggerCount, 1, "notifications_broadcast_unread must still be installed");

  // The private-channel gate from 0029 must still be the only thing that opens
  // a topic: the policy is unchanged by 0030.
  const policyCount = await scalar(
    db,
    "select count(*)::int as c from pg_policies where schemaname='realtime' and tablename='messages' and policyname='notifications_realtime_receive'",
  );
  assert.equal(policyCount, 1, "the recipient-scoped realtime.messages policy from 0029 must be unchanged");

  await db.close();
});
