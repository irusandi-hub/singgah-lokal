import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0024 — notification_preferences schema + RLS regression.
 *
 * The migration chain (0001→0007 for the objects 0024 depends on, plus 0023
 * to prove the chain continues cleanly after it) is applied on a real
 * Postgres engine (PGlite), then the contract is exercised against the
 * actual policies/grants:
 * - migration applies (0023 → 0024) on the real chain;
 * - defaults are exactly the task-specified values (mandatory ON, promo OFF);
 * - one row per user (user_id PK);
 * - authenticated user reads/creates/updates only their own row;
 * - a user can neither read nor change another user's preferences;
 * - anon can neither read nor write anything;
 * - no DELETE path exists for the client (no policy, no grant);
 * - updated_at is maintained server-side by the trigger.
 */

const MIGRATION_DIR = "../supabase/migrations/";

const readMigration = (name: string) => readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");

// PGlite does not bundle pgcrypto (on Supabase, 0001 creates it); the only
// symbol taken from pgcrypto is gen_random_uuid(), core PostgreSQL since 13.
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const DEPENDENCY_MIGRATIONS = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0023_place_follows.sql",
];

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  // Supabase environment shims (harness-only, same pattern as
  // live-migration-validity.test.ts).
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
  for (const name of DEPENDENCY_MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  await db.exec(stripPgcrypto(readMigration("0024_notification_preferences.sql")));
  return db;
}

async function seedUser(db: PGlite, userId: string): Promise<void> {
  // public.users references auth.users (Supabase shape) — seed both.
  await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing;`);
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing;`);
}

/** Act as a signed-in Supabase user for the RLS policies. */
async function setAuthUid(db: PGlite, userId: string | null): Promise<void> {
  // Function redefinition must run as the superuser — after `set role`
  // the authenticated role cannot create functions in the auth schema.
  await db.exec("reset role;");
  if (userId) {
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select $$${userId}$$::uuid';`);
  } else {
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';`);
  }
  await db.exec("set role authenticated;");
}

async function setRole(db: PGlite, role: "anon" | "authenticated"): Promise<void> {
  await db.exec(`set role ${role};`);
}

test("0024 applies cleanly after 0023 on the real migration chain and creates the locked shape", async () => {
  const db = await createDb();

  const tables = await rows(db, "select tablename from pg_tables where schemaname='public' and tablename='notification_preferences'");
  assert.equal(tables.length, 1, "notification_preferences must exist");

  // Exactly the task-specified columns.
  const columns = await rows(
    db,
    `select column_name, data_type, is_nullable, column_default
     from information_schema.columns
     where table_schema='public' and table_name='notification_preferences' order by ordinal_position`,
  );
  assert.deepEqual(
    columns.map((row) => row.column_name),
    [
      "user_id", "live_place", "visit_experience", "help_support",
      "system", "safety_account", "promotional", "created_at", "updated_at",
    ],
    "column set is locked by the task spec",
  );
  const userIdColumn = columns[0];
  assert.equal(userIdColumn.is_nullable, "NO", "user_id is the primary key");

  // One row per user: user_id is the PK.
  const pk = await rows(
    db,
    `select a.attname from pg_index i
     join pg_class c on c.oid = i.indrelid
     join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relname='notification_preferences' and i.indisprimary`,
  );
  assert.deepEqual(pk.map((row) => row.attname), ["user_id"], "one row per user (user_id PK)");

  // RLS enabled with exactly the three self-scoped policies (no DELETE).
  const policies = await rows(
    db,
    `select policyname, cmd from pg_policies where schemaname='public' and tablename='notification_preferences' order by policyname`,
  );
  assert.deepEqual(
    policies.map((row) => `${row.policyname}:${row.cmd}`),
    [
      "notification_preferences_self_insert:INSERT",
      "notification_preferences_self_read:SELECT",
      "notification_preferences_self_update:UPDATE",
    ],
    "exactly the self read/insert/update policies must exist (no DELETE policy)",
  );

  const rls = await rows(db, "select rowsecurity from pg_tables where schemaname='public' and tablename='notification_preferences'");
  assert.equal(rls[0]?.rowsecurity, true, "RLS must be enabled");

  // anon holds NO grants; authenticated holds only SELECT + column-scoped
  // INSERT/UPDATE (0002/0023 pattern). No DELETE grant anywhere.
  const grants = await rows(
    db,
    `select grantee, privilege_type from information_schema.role_table_grants
     where table_schema='public' and table_name='notification_preferences' and grantee in ('anon','authenticated') order by 1,2`,
  );
  assert.deepEqual(
    grants.map((row) => `${row.grantee}:${row.privilege_type}`),
    ["authenticated:SELECT"],
    "anon must hold NO grants; authenticated holds table-level SELECT only",
  );
  const insertColumns = await rows(
    db,
    `select column_name from information_schema.column_privileges
     where table_schema='public' and table_name='notification_preferences' and grantee='authenticated' and privilege_type='INSERT' order by 1`,
  );
  assert.deepEqual(insertColumns.map((row) => row.column_name), ["user_id"], "INSERT is restricted to the identity column");
  const updateColumns = await rows(
    db,
    `select column_name from information_schema.column_privileges
     where table_schema='public' and table_name='notification_preferences' and grantee='authenticated' and privilege_type='UPDATE' order by 1`,
  );
  assert.deepEqual(
    updateColumns.map((row) => row.column_name),
    ["help_support", "live_place", "promotional", "safety_account", "system", "visit_experience"],
    "UPDATE is restricted to the category flags only",
  );

  // Server-side updated_at trigger exists.
  const trigger = await rows(
    db,
    `select tgname from pg_trigger where tgname='notification_preferences_touch_updated_at' and not tgisinternal`,
  );
  assert.equal(trigger.length, 1, "updated_at must be maintained by a trigger");

  await db.close();
});

test("defaults are exactly the locked category values (mandatory ON, promotional OFF)", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");

  // Insert only the identity column: every default must materialize.
  const inserted = await rows(
    db,
    `insert into public.notification_preferences (user_id) values ('${USER_A}') returning *`,
  );
  assert.equal(inserted.length, 1);
  const row = inserted[0];
  assert.deepEqual(
    {
      live_place: row.live_place,
      visit_experience: row.visit_experience,
      help_support: row.help_support,
      system: row.system,
      safety_account: row.safety_account,
      promotional: row.promotional,
    },
    {
      live_place: true,
      visit_experience: true,
      help_support: true,
      system: true,
      safety_account: true,
      promotional: false,
    },
    "mandatory categories default ON; promotional defaults OFF",
  );
  assert.ok(row.created_at, "created_at defaults to now()");
  assert.ok(row.updated_at, "updated_at defaults to now()");
  await db.close();
});

test("authenticated user can read and update only their own preferences", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");

  await db.exec(`insert into public.notification_preferences (user_id) values ('${USER_A}')`);

  const own = await rows(db, "select user_id, promotional from public.notification_preferences");
  assert.equal(own.length, 1, "user reads their own preference row");
  assert.equal(String(own[0].user_id), USER_A);

  // Update own row: category flags are writable; updated_at is trigger-set.
  // (Timestamp ordering is flaky at clock granularity, so equality with
  // clock_timestamp() is asserted instead of a strict advance.)
  const before = await rows(db, "select updated_at from public.notification_preferences");
  const updated = await rows(
    db,
    `update public.notification_preferences set promotional = true, live_place = false
     returning promotional, live_place, updated_at, (select clock_timestamp() as now) , created_at`,
  );
  assert.equal(updated.length, 1);
  assert.equal(updated[0].promotional, true);
  assert.equal(updated[0].live_place, false);
  assert.ok(
    new Date(String(updated[0].updated_at)).getTime() <= new Date(String((updated[0] as Row).now)).getTime(),
    "updated_at is trigger-set to the update time (not frozen at insert time)",
  );
  assert.ok(
    new Date(String(updated[0].updated_at)).getTime() >= new Date(String(before[0].updated_at)).getTime(),
    "updated_at must not go backwards",
  );

  // The identity column is not updatable by the client (no UPDATE grant on user_id).
  await assert.rejects(
    () => db.query("update public.notification_preferences set user_id = '99999999-9999-9999-9999-999999999999'"),
    /permission denied/i,
    "identity column must not be client-updatable",
  );
  await db.close();
});

test("a user can neither read nor change another user's preferences", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");
  await db.exec(`insert into public.notification_preferences (user_id) values ('${USER_A}')`);

  // Switch to USER B.
  await setAuthUid(db, USER_B);

  const visible = await rows(db, "select user_id from public.notification_preferences");
  assert.equal(visible.length, 0, "RLS must hide another user's preference row from SELECT");

  const changed = await rows(
    db,
    "update public.notification_preferences set promotional = true returning user_id",
  );
  assert.equal(changed.length, 0, "RLS must make another user's preferences un-updatable");

  // INSERT on behalf of another user is rejected (user_id = auth.uid() check).
  await assert.rejects(
    () => db.query(`insert into public.notification_preferences (user_id) values ('${USER_A}')`),
    /row-level security|violates/i,
    "inserting a preference row for another user must be rejected",
  );

  // The original row survives untouched (verified as the table owner).
  await db.exec("reset role;");
  const remaining = await rows(db, "select user_id, promotional from public.notification_preferences");
  assert.deepEqual(remaining.map((row) => String(row.user_id)), [USER_A]);
  assert.equal(remaining[0].promotional, false, "the other user's flags must be unchanged");
  await db.close();
});

test("anon can neither read nor write any preference", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");
  await db.exec(`insert into public.notification_preferences (user_id) values ('${USER_A}')`);

  // Signed-out: anon role, no auth.uid(). anon holds NO grants.
  await db.exec("reset role;");
  await db.exec("set role anon;");

  await assert.rejects(
    () => db.query("select user_id from public.notification_preferences"),
    /permission denied|row-level security/i,
    "anon must not read preferences",
  );
  await assert.rejects(
    () => db.query(`insert into public.notification_preferences (user_id) values ('${USER_A}')`),
    /permission denied|row-level security/i,
    "anon must not create preferences",
  );
  await db.close();
});

test("no DELETE path exists for any client role (preference rows are owner-state, not deletable)", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");
  await db.exec(`insert into public.notification_preferences (user_id) values ('${USER_A}')`);

  await assert.rejects(
    () => db.query("delete from public.notification_preferences"),
    /permission denied/i,
    "authenticated must hold no DELETE grant",
  );
  await db.close();
});
