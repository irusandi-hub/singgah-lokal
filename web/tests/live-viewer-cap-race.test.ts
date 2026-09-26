import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0027 — viewer cap race guard.
 *
 * The locked limit is 100 CONCURRENT viewers (MASTER_LIVE_POLICY §6). The
 * audit finding: `admit_live_viewer` counted and then inserted with nothing
 * serializing the two steps, so concurrent admissions could both pass the
 * gate. This test proves the cap is now serialized per session, and — just as
 * important — that nothing else about admission changed:
 * - same RPC signature (no stale contract for callers/harnesses);
 * - the lock is taken BEFORE the capacity count and is session-scoped;
 * - the cap value, the grace window, the audit row, the idempotent upsert,
 *   and the viewer_peak update are all preserved;
 * - fail-closed gates still run first and still deny (B1 age deny-all).
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) => readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const CHAIN = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0013_live_rpc_privilege_lockdown.sql",
];

const NOTIFICATION_CHAIN = [
  "0023_place_follows.sql",
  "0024_notification_preferences.sql",
  "0025_notifications.sql",
  "0026_live_followed_notifications.sql",
];

const USER_ID = "11111111-1111-1111-1111-111111111111";

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
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
  `);
  await db.exec("create publication supabase_realtime;");
  for (const name of [...CHAIN, ...NOTIFICATION_CHAIN, "0027_live_viewer_cap_race_guard.sql"]) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  return db;
}

async function functionBody(db: PGlite, name: string): Promise<string> {
  const result = await rows(db, `select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='${name}'`);
  return String(result[0]?.prosrc ?? "");
}

test("0027 applies on the full chain and keeps the admit_live_viewer signature", async () => {
  const db = await createDb();

  const signature = await rows(
    db,
    `select p.proname, pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='admit_live_viewer'`,
  );
  assert.equal(signature.length, 1, "admit_live_viewer must exist exactly once");
  assert.equal(signature[0].args, "p_session_id text", "signature is unchanged (no stale contract)");

  // No duplicate overloads were introduced.
  const overloads = await rows(
    db,
    `select count(*)::int as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname='admit_live_viewer'`,
  );
  assert.equal(Number(overloads[0].c), 1, "no extra overload");
  await db.close();
});

test("the capacity check is serialized per session, and the lock precedes the count", async () => {
  const db = await createDb();
  const body = await functionBody(db, "admit_live_viewer");

  const lockIndex = body.indexOf("pg_advisory_xact_lock");
  const countIndex = body.indexOf("select count(*) into v_concurrent");
  const insertIndex = body.indexOf("insert into public.live_viewers");

  assert.ok(lockIndex > 0, "admission must take an advisory lock");
  assert.ok(lockIndex < countIndex, "the lock must be taken BEFORE the capacity count");
  assert.ok(countIndex < insertIndex, "count must still precede the ledger insert");

  // Session-scoped key: different sessions never block each other.
  assert.match(body, /hashtextextended\('live_viewer_admission_lock:' \|\| p_session_id, 0\)/);
  // Transaction-scoped, BLOCKING lock — contention queues, it never denies a
  // legitimate viewer (denial stays reserved for the real cap).
  assert.match(body, /perform pg_advisory_xact_lock\(/);
  assert.doesNotMatch(body, /pg_try_advisory_xact_lock/, "admission must not fail-closed on lock contention");
  await db.close();
});

test("cap semantics are unchanged: 100 concurrent, 5-minute window, audit + upsert + viewer_peak", async () => {
  const db = await createDb();
  const body = await functionBody(db, "admit_live_viewer");

  assert.match(body, /v_concurrent >= 100/, "the locked 100-concurrent cap");
  assert.match(body, /interval '5 minutes'/, "presence grace window preserved");
  assert.match(body, /'admission_denied'/, "capacity denial stays audited");
  assert.match(body, /jsonb_build_object\('reason', 'capacity_full'\)/);
  assert.match(body, /on conflict \(live_session_id, user_id\) do update/, "re-admission stays idempotent");
  assert.match(body, /set viewer_peak = greatest\(viewer_peak, v_concurrent \+ 1\)/, "viewer_peak accounting preserved");
  // Fail-closed eligibility gate still runs FIRST and is untouched.
  const eligibleIndex = body.indexOf("perform public.assert_viewer_eligible(p_session_id)");
  const lockIndex = body.indexOf("pg_advisory_xact_lock");
  assert.ok(eligibleIndex > 0, "assert_viewer_eligible must still be called");
  assert.ok(eligibleIndex < lockIndex, "the fail-closed eligibility gate runs before the lock and the cap");
  await db.close();
});

test("fail-closed gates are not weakened: B1 age deny-all still blocks admission", async () => {
  const db = await createDb();
  await db.exec(`insert into auth.users (id) values ('${USER_ID}') on conflict do nothing`);
  await db.exec(`insert into public.users (id) values ('${USER_ID}') on conflict do nothing`);
  // A live session on a published Place, as the server path creates it.
  await db.exec(`
    insert into public.producers (id, display_name) values ('prod-cap', 'Producer Cap') on conflict do nothing;
    update public.places set producer_id = 'prod-cap' where id = 'kopi-dari-kebun';
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('stage-cap', 'kopi-dari-kebun', 'Tahap', 'Deskripsi.', 95, 'published') on conflict do nothing;
  `);
  await db.exec(`
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
    values ('live-cap-1', 'kopi-dari-kebun', 'prod-cap', 'stage-cap', 'live', 'idem-cap-1');
  `);
  await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select $$${USER_ID}$$::uuid'`);
  await db.exec("set role authenticated;");

  // B1: the verified-age mechanism does not exist yet, so admission must be
  // denied for every viewer — the lock must not become a way through.
  await assert.rejects(
    () => db.query("select public.admit_live_viewer('live-cap-1')"),
    /live_viewer_denied/i,
    "viewer admission stays fail-closed (age gate not weakened)",
  );
  const viewers = await rows(db, "select user_id from public.live_viewers");
  assert.equal(viewers.length, 0, "no ledger row may be written for a denied admission");
  await db.close();
});
