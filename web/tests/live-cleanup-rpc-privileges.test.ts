import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * A-03 — provider-cleanup RPCs are SERVICE-ROLE ONLY (migration 0051).
 *
 * The audit found release_live_input / list_ended_live_inputs EXECUTE-granted
 * to every authenticated account while verifying only the SESSION STATE, so
 * any signed-in user could null another tenant's live_input_id and enumerate
 * ended sessions' provider input UIDs across tenants (SECURITY DEFINER bypasses
 * RLS).
 *
 * This suite runs the REAL migration chain on Postgres (PGlite) and proves:
 *  - anon / authenticated hold no EXECUTE (and PUBLIC is not a grantee);
 *  - an authenticated session is refused AT CALL TIME, not only on paper;
 *  - the legitimate server flow still works through the SERVICE ROLE
 *    (backlog list + pointer release, canonical state updated);
 *  - the client-facing start/end RPC posture is untouched;
 *  - 0051 applies cleanly and re-applies as a no-op (SQL-Editor paste path).
 *
 * The same contract, as a runnable DEV script emitting a result set, lives in
 * tests/db-regression/live-cleanup-rpc-access.sql (this test executes it).
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

const CHAIN = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0012_live_end_idempotency.sql",
  "0013_live_rpc_privilege_lockdown.sql",
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
  "0047_account_center_live_operator.sql",
  "0048_live_operator_invitations.sql",
  "0049_live_operator_authority.sql",
  "0051_live_auth_integrity.sql",
];

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, encrypted_password text);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
    grant usage on schema auth to authenticated;

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
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  `);
  await db.exec("create publication supabase_realtime;");
  for (const name of CHAIN) {
    await db.exec(stripPgcrypto(readMigration(name)));
    if (name === "0029_notification_fanout.sql") {
      // Supabase-style default privileges the 004x migrations assume.
      await db.exec(
        `grant usage on schema public to anon, authenticated;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
  return db;
}

// ---------------------------------------------------------------------------
// 1. Migration shape: applies cleanly, re-applies as a no-op
// ---------------------------------------------------------------------------

test("0051 applies cleanly, is idempotent, and locks the cleanup RPCs to service_role", async () => {
  const db = await createDb();
  // Whole-file re-run (SQL-Editor paste) must be a no-op.
  await db.exec(stripPgcrypto(readMigration("0051_live_auth_integrity.sql")));

  for (const fn of ["public.release_live_input(text)", "public.list_ended_live_inputs()"]) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.equal(
        Boolean((await rows(db, `select has_function_privilege('${role}','${fn}','EXECUTE') as ok`))[0].ok),
        false,
        `${role} must not hold EXECUTE on ${fn}`,
      );
    }
    assert.equal(
      Boolean((await rows(db, `select has_function_privilege('service_role','${fn}','EXECUTE') as ok`))[0].ok),
      true,
      `service_role must hold EXECUTE on ${fn}`,
    );
  }

  // The client-facing RPCs keep their authenticated posture.
  for (const fn of [
    "public.start_live_session(text,text,text,text)",
    "public.end_live_session(text,text,text,text)",
  ]) {
    assert.equal(
      Boolean((await rows(db, `select has_function_privilege('authenticated','${fn}','EXECUTE') as ok`))[0].ok),
      true,
      `${fn} must stay authenticated-callable`,
    );
    assert.equal(
      Boolean((await rows(db, `select has_function_privilege('anon','${fn}','EXECUTE') as ok`))[0].ok),
      false,
      `${fn} must stay denied to anon`,
    );
  }

  // The function BODIES are untouched by 0051 (lockdown is by grant only).
  const source = readMigration("0051_live_auth_integrity.sql");
  assert.doesNotMatch(source, /create or replace function public\.(release_live_input|list_ended_live_inputs)/);
  assert.match(source, /revoke execute on function public\.release_live_input\(text\) from public, anon, authenticated;/);
  assert.match(source, /revoke execute on function public\.list_ended_live_inputs\(\) from public, anon, authenticated;/);
  assert.match(source, /grant execute on function public\.release_live_input\(text\) to service_role;/);
  assert.match(source, /grant execute on function public\.list_ended_live_inputs\(\) to service_role;/);
  // No grant ever goes to anon or the broad authenticated surface.
  assert.doesNotMatch(source, /grant execute[^;]* to (anon|authenticated|public)/);

  await db.close();
});

// ---------------------------------------------------------------------------
// 2. Call-time behaviour through the real RPCs
// ---------------------------------------------------------------------------

test("an authenticated session cannot call the cleanup RPCs at call time", async () => {
  const db = await createDb();

  for (const call of [
    "select public.list_ended_live_inputs()",
    "select public.release_live_input('anything')",
  ]) {
    await assert.rejects(
      () => db.exec(`set role authenticated; ${call};`),
      (error: Error) => {
        assert.match(String(error.message), /permission denied/i);
        return true;
      },
      `authenticated must be refused: ${call}`,
    );
  }

  for (const call of [
    "select public.list_ended_live_inputs()",
    "select public.release_live_input('anything')",
  ]) {
    await assert.rejects(
      () => db.exec(`set role anon; ${call};`),
      (error: Error) => {
        assert.match(String(error.message), /permission denied/i);
        return true;
      },
      `anon must be refused: ${call}`,
    );
  }

  await db.exec("reset role;");
  await db.close();
});

test("the legitimate server flow still works through the service role", async () => {
  const db = await createDb();

  // Ended session holding an unreleased pointer (fixture as superuser).
  await db.exec(`
    insert into public.producers (id, display_name)
    values ('prod-cleanup', 'Pengelola Cleanup') on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('stage-cleanup', 'rumah-teh-lokal', 'Tahap Cleanup', 'x', 0, 'published')
    on conflict (id) do nothing;
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, live_input_id, idempotency_key)
    values ('sess-cleanup', 'rumah-teh-lokal', 'prod-cleanup', 'stage-cleanup', 'ended', 'input-abc', 'cleanup-key')
    on conflict (id) do nothing;
  `);

  // list_ended_live_inputs: the backlog comes back through service_role.
  await db.exec("set role service_role;");
  const listed = await rows(db, `select public.list_ended_live_inputs() as backlog`);
  await db.exec("reset role;");
  // PGlite returns jsonb as a parsed object already.
  const backlog = listed[0].backlog as Array<{ sessionId: string; liveInputId: string }>;
  assert.deepEqual(backlog, [{ sessionId: "sess-cleanup", liveInputId: "input-abc" }]);

  // release_live_input: returns the id and nulls the pointer.
  await db.exec("set role service_role;");
  const released = await rows(db, `select public.release_live_input('sess-cleanup') as input_id`);
  await db.exec("reset role;");
  assert.equal(released[0].input_id, "input-abc");

  const stored = await rows(
    db,
    `select live_input_id from public.live_sessions where id = 'sess-cleanup'`,
  );
  assert.equal(stored[0].live_input_id, null, "the pointer is released in canonical state");

  // The backlog is now empty for that session (idempotent re-run).
  await db.exec("set role service_role;");
  const again = await rows(db, `select public.list_ended_live_inputs() as backlog`);
  await db.exec("reset role;");
  assert.deepEqual(again[0].backlog, []);

  await db.close();
});

// ---------------------------------------------------------------------------
// 3. The runnable DEV script (result set of check_name / passed / detail)
// ---------------------------------------------------------------------------

test("db-regression/live-cleanup-rpc-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-cleanup-rpc-access.sql", import.meta.url),
    "utf8",
  );

  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Array<Record<string, unknown>>;
  assert.ok(checkRows.length >= 18, `expected >= 18 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );

  // Rollback contract: no fixture residue.
  const leftover = await rows(db, `select 1 as one from public.live_sessions where id = 'sess-cleanup-1'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});
