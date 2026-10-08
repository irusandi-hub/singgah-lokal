import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0047 — Account Center access + delegated Live Operator access.
 *
 * Applied on a real Postgres engine (PGlite) after the object chain it depends
 * on, then the authorization contract is exercised against the actual
 * constraints, grants, and RLS policies:
 *
 * - username: self-only, username-only UPDATE (column-level GRANT + RLS),
 *   bounded + unique, never able to touch platform_role or another account;
 * - live_operators: reads only for the assigned operator and the Place's
 *   owner/manager; no direct client writes; grant/revoke only through the two
 *   audited RPCs, only by the Place's owner/manager;
 * - a Producer owner/manager membership does NOT create an operator row;
 * - a revoked assignment disappears from the operator's active access AND
 *   withdraws the Place read it granted;
 * - the account-enumeration RPC from the first draft is gone.
 *
 * The harness mirrors Supabase: `authenticated`/`anon` have the default
 * schema-wide privileges, and auth.uid() returns a fixed uuid so policies
 * behave like a real signed-in session.
 */

const MIGRATION_DIR = "../supabase/migrations/";

const readMigration = (name: string) => readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");

// PGlite does not bundle pgcrypto (Supabase's 0001 creates it); the only symbol
// taken from pgcrypto is gen_random_uuid(), core PostgreSQL since 13.
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const DEPENDENCY_MIGRATIONS = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create publication supabase_realtime;
  `);
  for (const name of DEPENDENCY_MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  // Supabase's default privileges: anon/authenticated can reach public tables,
  // RLS is what actually decides. Emulated here so the policies are the thing
  // under test (and so a missing grant is visible as permission denied).
  await db.exec(`grant usage on schema public to anon, authenticated; grant all on all tables in schema public to anon, authenticated;`);
  await db.exec(stripPgcrypto(readMigration("0047_account_center_live_operator.sql")));
  return db;
}

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

async function setAuthUid(db: PGlite, userId: string | null): Promise<void> {
  // Function redefinition must run as the superuser — after `set role` the
  // authenticated role cannot create functions in the auth schema.
  await db.exec("reset role;");
  if (userId) {
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select $$${userId}$$::uuid';`);
  } else {
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';`);
  }
  await db.exec("set role authenticated;");
}

async function seedUser(db: PGlite, userId: string): Promise<void> {
  await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing;`);
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing;`);
}

const OWNER = "11111111-1111-1111-1111-111111111111";
const OPERATOR = "22222222-2222-2222-2222-222222222222";
const OUTSIDER = "33333333-3333-3333-3333-333333333333";
const PLACE_ID = "kopi-dari-kebun"; // seeded, published, by 0001
const PLACE_NAME = "Kopi dari Kebun";

/** OWNER is an owner of PLACE_ID; OPERATOR/OUTSIDER hold no membership. */
async function seedOwnership(db: PGlite): Promise<void> {
  await db.exec(`insert into public.producers (id, display_name) values ('p-owner', 'Pengelola Kopi') on conflict do nothing;`);
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${OWNER}', 'p-owner', '${PLACE_ID}', 'owner') on conflict do nothing;`,
  );
}

// ---------------------------------------------------------------------------
// A. Shape
// ---------------------------------------------------------------------------

test("0047 applies cleanly and creates the locked username shape", async () => {
  const db = await createDb();

  const column = await rows(
    db,
    `select column_name from information_schema.columns where table_schema='public' and table_name='users' and column_name='username'`,
  );
  assert.equal(column.length, 1, "public.users.username must exist");

  const constraints = await rows(
    db,
    `select conname from pg_constraint where conrelid = 'public.users'::regclass and conname in ('username_format','username_length') order by 1`,
  );
  assert.deepEqual(
    constraints.map((row) => row.conname),
    ["username_format", "username_length"],
    "both username CHECK constraints must exist",
  );

  const index = await rows(
    db,
    `select indexdef from pg_indexes where schemaname='public' and tablename='users' and indexname='users_username_unique_idx'`,
  );
  assert.equal(index.length, 1, "the partial unique index must exist");
  assert.match(String(index[0]?.indexdef), /unique/i);
  assert.match(String(index[0]?.indexdef), /username is not null/i, "uniqueness must be partial (legacy NULLs stay allowed)");

  // The account-enumeration helper from the earlier draft must NOT exist.
  const lookup = await rows(
    db,
    `select proname from pg_proc where proname = 'lookup_rakyat_account_by_email'`,
  );
  assert.equal(lookup.length, 0, "no email→account enumeration RPC may be shipped");

  const table = await rows(
    db,
    `select tablename from pg_tables where schemaname='public' and tablename='live_operators'`,
  );
  assert.equal(table.length, 1, "public.live_operators must exist");

  const rls = await rows(db, `select rowsecurity from pg_tables where schemaname='public' and tablename='live_operators'`);
  assert.equal(rls[0]?.rowsecurity, true, "RLS must be enabled on live_operators");

  const policies = await rows(
    db,
    `select policyname, cmd from pg_policies where schemaname='public' and tablename='live_operators' order by policyname`,
  );
  assert.deepEqual(
    policies.map((row) => `${row.policyname}:${row.cmd}`),
    ["live_operators_producer_read:SELECT", "live_operators_self_read:SELECT"],
    "exactly the two read policies (no direct INSERT/UPDATE/DELETE policy)",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// B. Username: self-only, username-only, bounded, unique
// ---------------------------------------------------------------------------

test("an account can set ONLY its own username", async () => {
  const db = await createDb();
  await seedUser(db, OWNER);
  await seedUser(db, OPERATOR);

  await setAuthUid(db, OWNER);

  const own = await rows(db, `update public.users set username = 'pengelola-kopi' where id = '${OWNER}' returning username`);
  assert.equal(own.length, 1, "the account can set its own username");
  assert.equal(own[0]?.username, "pengelola-kopi");

  // RLS: another account's row is invisible to the UPDATE, so 0 rows change.
  const foreign = await rows(db, `update public.users set username = 'dicuri' where id = '${OPERATOR}' returning username`);
  assert.equal(foreign.length, 0, "another account's row must be untouchable");

  // Column-level GRANT: no other column on the own row may be written.
  await assert.rejects(
    () => db.query(`update public.users set platform_role = 'platform_moderator' where id = '${OWNER}'`),
    /permission denied|must be owner/i,
    "an account must not be able to escalate its own platform_role",
  );

  // Bounds are enforced by the database too.
  await assert.rejects(
    () => db.query(`update public.users set username = 'ab' where id = '${OWNER}'`),
    /username_length|violates check constraint/i,
    "usernames shorter than 3 characters are rejected",
  );
  await assert.rejects(
    () => db.query(`update public.users set username = 'bad name' where id = '${OWNER}'`),
    /username_format|violates check constraint/i,
    "usernames with invalid characters are rejected",
  );

  await db.close();
});

test("usernames are unique across accounts", async () => {
  const db = await createDb();
  await seedUser(db, OWNER);
  await seedUser(db, OPERATOR);

  await setAuthUid(db, OWNER);
  await db.query(`update public.users set username = 'sama' where id = '${OWNER}'`);

  await setAuthUid(db, OPERATOR);
  await assert.rejects(
    () => db.query(`update public.users set username = 'sama' where id = '${OPERATOR}'`),
    /duplicate key|unique/i,
    "a second account cannot take an existing username",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// C. Delegated Live Operator access
// ---------------------------------------------------------------------------

test("a Producer owner/manager membership does NOT create an operator assignment", async () => {
  const db = await createDb();
  await seedUser(db, OWNER);
  await seedOwnership(db);
  await setAuthUid(db, OWNER);

  const operatorRows = await rows(db, `select user_id from public.live_operators`);
  assert.equal(operatorRows.length, 0, "being an owner/manager must never imply Operator Live access");
  await db.close();
});

test("only the Place owner/manager can grant or revoke operator access, and granted_by is derived", async () => {
  const db = await createDb();
  await seedUser(db, OWNER);
  await seedUser(db, OPERATOR);
  await seedUser(db, OUTSIDER);
  await seedOwnership(db);

  // Outsider (no membership at all) cannot grant.
  await setAuthUid(db, OUTSIDER);
  await assert.rejects(
    () => db.query(`select public.grant_live_operator_access('${OPERATOR}', '${PLACE_ID}')`),
    /live_operator_grant_not_allowed/,
    "a user with no authority must not grant operator access",
  );

  // The operator themself cannot self-grant.
  await setAuthUid(db, OPERATOR);
  await assert.rejects(
    () => db.query(`select public.grant_live_operator_access('${OPERATOR}', '${PLACE_ID}')`),
    /live_operator_grant_not_allowed/,
    "an assigned operator must not be able to widen its own access",
  );

  // The owner can.
  await setAuthUid(db, OWNER);
  const granted = await rows(db, `select public.grant_live_operator_access('${OPERATOR}', '${PLACE_ID}') as ok`);
  assert.equal(granted[0]?.ok, true, "the Place owner may grant");

  await db.exec("reset role;");
  const stored = await rows(db, `select granted_by, revoked_at from public.live_operators where user_id = '${OPERATOR}'`);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.granted_by, "p-owner", "granted_by must come from the granting membership, not the caller");
  assert.equal(stored[0]?.revoked_at, null);

  // Re-granting an active assignment is a no-op, not a duplicate error.
  await db.exec("reset role;");
  await setAuthUid(db, OWNER);
  const regrant = await rows(db, `select public.grant_live_operator_access('${OPERATOR}', '${PLACE_ID}') as ok`);
  assert.equal(regrant[0]?.ok, true, "granting again must stay idempotent");
  await db.exec("reset role;");
  const afterRegrant = await rows(db, `select count(*)::int as n from public.live_operators`);
  assert.equal(afterRegrant[0]?.n, 1, "no duplicate row is created");

  // Only the owner/manager can revoke.
  await setAuthUid(db, OUTSIDER);
  await assert.rejects(
    () => db.query(`select public.revoke_live_operator_access('${OPERATOR}', '${PLACE_ID}')`),
    /live_operator_revoke_not_allowed/,
    "a user with no authority must not revoke operator access",
  );

  await db.close();
});

test("an operator reads its own active access and the exact Place name; revocation removes both", async () => {
  const db = await createDb();
  await seedUser(db, OWNER);
  await seedUser(db, OPERATOR);
  await seedOwnership(db);

  await setAuthUid(db, OWNER);
  await db.query(`select public.grant_live_operator_access('${OPERATOR}', '${PLACE_ID}')`);

  // The operator sees its own active assignment.
  await setAuthUid(db, OPERATOR);
  const active = await rows(
    db,
    `select place_id from public.live_operators where user_id = '${OPERATOR}' and revoked_at is null`,
  );
  assert.deepEqual(active.map((row) => row.place_id), [PLACE_ID], "the assigned operator reads its own active assignment");

  // ...and the canonical Place name for it (the exact label the card shows).
  const place = await rows(db, `select name from public.places where id = '${PLACE_ID}'`);
  assert.equal(place[0]?.name, PLACE_NAME, "the operator can resolve the exact canonical Place name");

  // Take the Place out of public view so only the operator-read policy can
  // still resolve the name — proving the delegated read is what grants it.
  await db.exec("reset role;");
  await db.exec(`update public.places set publication_status = 'draft' where id = '${PLACE_ID}';`);

  await setAuthUid(db, OPERATOR);
  const privatePlace = await rows(db, `select name from public.places where id = '${PLACE_ID}'`);
  assert.equal(privatePlace[0]?.name, PLACE_NAME, "an active assignment grants the Place read even when unpublished");

  // A different authenticated user gets nothing.
  await setAuthUid(db, OUTSIDER);
  const hidden = await rows(db, `select name from public.places where id = '${PLACE_ID}'`);
  assert.equal(hidden.length, 0, "an unrelated account must not read the unpublished Place");
  const hiddenAssignments = await rows(db, `select place_id from public.live_operators`);
  assert.equal(hiddenAssignments.length, 0, "an unrelated account must not read another account's assignments");

  // Revoke (owner), then the operator's active access and Place read are gone.
  await setAuthUid(db, OWNER);
  const revoked = await rows(db, `select public.revoke_live_operator_access('${OPERATOR}', '${PLACE_ID}') as ok`);
  assert.equal(revoked[0]?.ok, true, "the owner can revoke");

  await setAuthUid(db, OPERATOR);
  const afterRevoke = await rows(
    db,
    `select place_id from public.live_operators where user_id = '${OPERATOR}' and revoked_at is null`,
  );
  assert.equal(afterRevoke.length, 0, "a revoked assignment disappears from active operator access");
  const placeAfterRevoke = await rows(db, `select name from public.places where id = '${PLACE_ID}'`);
  assert.equal(placeAfterRevoke.length, 0, "revocation withdraws the Place read it granted");

  await db.close();
});

test("authenticated sessions cannot write live_operators directly", async () => {
  const db = await createDb();
  await seedUser(db, OWNER);
  await seedUser(db, OPERATOR);
  await seedOwnership(db);
  await setAuthUid(db, OWNER);

  await assert.rejects(
    () => db.query(`insert into public.live_operators (user_id, place_id, granted_by) values ('${OPERATOR}', '${PLACE_ID}', 'p-owner')`),
    /permission denied|row-level security/i,
    "the only write path must be the audited RPC",
  );

  await db.close();
});
