import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0023 — place_follows schema + RLS regression.
 *
 * The migration chain (0001→0007 for the objects 0023 depends on) is applied
 * on a real Postgres engine (PGlite), then the authorization contract is
 * exercised against the actual policies/grants:
 * - authenticated user follows a Place;
 * - authenticated user reads only their own follows;
 * - authenticated user unfollows (their own row);
 * - a user can neither read nor delete another user's follow;
 * - signed-out (anon) can never read or create a follow;
 * - one follow state per (user, Place) — duplicate insert is impossible.
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
];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  // Supabase environment shims (harness-only, same pattern as
  // live-migration-validity.test.ts). auth.uid() returns a FIXED uuid so
  // RLS policies using auth.uid() behave like a real signed-in session.
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
  await db.exec(stripPgcrypto(readMigration("0023_place_follows.sql")));
  return db;
}

async function seedUser(db: PGlite, userId: string): Promise<void> {
  // public.users references auth.users (Supabase shape) — seed both.
  await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing;`);
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing;`);
}

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const PLACE_ID = "kopi-dari-kebun"; // seeded by 0001

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

async function setRole(db: PGlite, role: "anon" | "authenticated" | "service_role"): Promise<void> {
  await db.exec(`set role ${role};`);
}

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

test("0023 applies cleanly on the real migration chain and creates the locked shape", async () => {
  const db = await createDb();
  const tables = await rows(db, "select tablename from pg_tables where schemaname='public' and tablename='place_follows'");
  assert.equal(tables.length, 1, "place_follows must exist");

  // RLS enabled, three self-scoped policies, no UPDATE policy.
  const policies = await rows(
    db,
    `select policyname, cmd from pg_policies where schemaname='public' and tablename='place_follows' order by policyname`,
  );
  assert.deepEqual(
    policies.map((row) => `${row.policyname}:${row.cmd}`),
    [
      "place_follows_self_delete:DELETE",
      "place_follows_self_insert:INSERT",
      "place_follows_self_read:SELECT",
    ],
    "exactly the three self-scoped policies must exist (no UPDATE policy)",
  );

  const rls = await rows(db, "select rowsecurity from pg_tables where schemaname='public' and tablename='place_follows'");
  assert.equal(rls[0]?.rowsecurity, true, "RLS must be enabled");

  // anon holds NO grants; authenticated holds SELECT/DELETE at table level
  // and INSERT restricted to the follow identity columns (0002 pattern).
  const grants = await rows(
    db,
    `select grantee, privilege_type from information_schema.role_table_grants
     where table_schema='public' and table_name='place_follows' and grantee in ('anon','authenticated') order by 1,2`,
  );
  assert.deepEqual(
    grants.map((row) => `${row.grantee}:${row.privilege_type}`),
    ["authenticated:DELETE", "authenticated:SELECT"],
    "anon must hold NO table grants; authenticated holds exactly select/delete",
  );
  const columnGrants = await rows(
    db,
    `select column_name from information_schema.column_privileges
     where table_schema='public' and table_name='place_follows' and grantee='authenticated' and privilege_type='INSERT' order by 1`,
  );
  assert.deepEqual(
    columnGrants.map((row) => row.column_name),
    ["place_id", "user_id"],
    "INSERT must be restricted to the follow identity columns",
  );
  await db.close();
});

test("authenticated user can follow, read own follows, and unfollow", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");

  // Follow
  const inserted = await rows(
    db,
    `insert into public.place_follows (user_id, place_id) values ('${USER_A}', '${PLACE_ID}') returning user_id, place_id`,
  );
  assert.equal(inserted.length, 1, "authenticated user can create their own follow");

  // Read own follow back
  const own = await rows(db, `select place_id from public.place_follows where user_id = '${USER_A}'`);
  assert.deepEqual(own.map((row) => row.place_id), [PLACE_ID], "user reads their own follow");

  // One follow state per (user, Place): duplicate insert is impossible.
  await assert.rejects(
    () => db.query(`insert into public.place_follows (user_id, place_id) values ('${USER_A}', '${PLACE_ID}')`),
    /duplicate key|unique/i,
    "composite PK must prevent a second follow state for the same Place",
  );

  // Unfollow (delete own row)
  const deleted = await rows(
    db,
    `delete from public.place_follows where user_id = '${USER_A}' and place_id = '${PLACE_ID}' returning place_id`,
  );
  assert.equal(deleted.length, 1, "user can unfollow their own follow");
  const after = await rows(db, `select place_id from public.place_follows where user_id = '${USER_A}'`);
  assert.equal(after.length, 0, "follow row is gone after unfollow");
  await db.close();
});

test("a user can neither read nor delete another user's follow", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");
  await db.query(`insert into public.place_follows (user_id, place_id) values ('${USER_A}', '${PLACE_ID}')`);

  // Switch to USER B.
  await setAuthUid(db, USER_B);

  const visible = await rows(db, `select place_id from public.place_follows`);
  assert.equal(visible.length, 0, "RLS must hide another user's follow from SELECT");

  const deleted = await rows(
    db,
    `delete from public.place_follows where place_id = '${PLACE_ID}' returning place_id`,
  );
  assert.equal(deleted.length, 0, "RLS must make another user's follow un-deletable");

  // Cross-user INSERT is rejected as well (user_id = auth.uid() check) —
  // RLS is evaluated before the FK, so the identity mismatch is what
  // surfaces first (both layers reject it; RLS is the contract here).
  await assert.rejects(
    () => db.query(`insert into public.place_follows (user_id, place_id) values ('${USER_A}', '${PLACE_ID}')`),
    /row-level security|violates/i,
    "inserting on behalf of another user must be rejected",
  );

  // The original follow survives untouched (verified as the table owner —
  // service_role deliberately holds no grants on place_follows).
  await db.exec("reset role;");
  const remaining = await rows(db, `select user_id from public.place_follows`);
  assert.deepEqual(
    remaining.map((row) => row.user_id),
    [USER_A],
    "the followed row must remain intact",
  );
  await db.close();
});

test("signed-out (anon) can never read or create a follow", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");
  await db.query(`insert into public.place_follows (user_id, place_id) values ('${USER_A}', '${PLACE_ID}')`);

  // Signed-out: anon role, no auth.uid(). anon holds NO grants on the table,
  // so both read and write are rejected outright (fail-closed).
  await setAuthUid(db, null);
  await setRole(db, "anon");

  await assert.rejects(
    () => db.query(`select place_id from public.place_follows`),
    /permission denied|row-level security/i,
    "anon must not read follows",
  );

  await assert.rejects(
    () => db.query(`insert into public.place_follows (user_id, place_id) values ('${USER_A}', '${PLACE_ID}')`),
    /permission denied|row-level security|violates/i,
    "anon must not create follows (no grant, no policy)",
  );
  await db.close();
});

test("follow references real rows: unknown Place violates the FK", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");

  await assert.rejects(
    () => db.query(`insert into public.place_follows (user_id, place_id) values ('${USER_A}', 'no-such-place')`),
    /violates foreign key/i,
  );
  await db.close();
});
