import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

/**
 * Migration 0050 — profile foundation + phone OTP verification.
 *
 * Applied on a real Postgres engine (PGlite) after the object chain it depends
 * on (0001→0008, then 0047 for the username column, the self-update RLS policy
 * and the username rules 0050 reuses), then the contract is exercised against
 * the actual constraints, grants, trigger and RPC:
 *
 * - profile columns exist on the EXISTING public.users row (no second table);
 * - an authenticated account writes only its OWN row and only the self-owned
 *   columns; `phone_verified_at` is not client-writable at all;
 * - a direct write to `phone_verified_at` is rejected (column GRANT + trigger);
 * - changing phone_e164 RESETS the verification;
 * - the OTP RPC is the only verification path: unverified → verified, wrong
 *   code, expiry, attempt bound, single use, foreign challenge, and the
 *   "verified on another account" case that must answer like a wrong code;
 * - one VERIFIED number per active account (partial unique index backstop);
 * - the challenge table is unreachable by anon/authenticated;
 * - phone verification never touches producer/Place claim status.
 *
 * The harness mirrors Supabase: `authenticated`/`anon` hold the default
 * schema-wide privileges and RLS is what decides, and `auth.uid()` returns a
 * fixed uuid so the policies behave like a real signed-in session.
 */

const MIGRATION_DIR = "../supabase/migrations/";

const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");

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
  "0047_account_center_live_operator.sql",
];

const NEW_MIGRATION = "0050_profile_phone_verification.sql";

const OTP_SECRET = "test-otp-hash-secret";
const otpHash = (code: string) => createHmac("sha256", OTP_SECRET).update(code).digest("hex");

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create publication supabase_realtime;
    create schema if not exists storage;
    create table storage.buckets (
      id text primary key,
      name text,
      public boolean,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  for (const name of DEPENDENCY_MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  // Supabase's default privileges: anon/authenticated can reach public tables,
  // RLS is what actually decides.
  await db.exec(
    "grant usage on schema public to anon, authenticated; grant all on all tables in schema public to anon, authenticated;",
  );
  await db.exec(stripPgcrypto(readMigration(NEW_MIGRATION)));
  return db;
}

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string): Promise<Row[]> =>
  ((await db.query(query)).rows ?? []) as Row[];

async function setAuthUid(db: PGlite, userId: string | null): Promise<void> {
  // Function redefinition must run as the superuser — after `set role` the
  // authenticated role cannot create functions in the auth schema.
  await db.exec("reset role;");
  // `$$` dollar-quotes the uuid so the outer single-quoted function body stays
  // intact (same harness shape as tests/account-center-migration.test.ts).
  const body = userId ? `select $$${userId}$$::uuid` : "select null::uuid";
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as '${body}';`,
  );
  await db.exec("set role authenticated;");
}

async function seedUser(db: PGlite, userId: string): Promise<void> {
  await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing;`);
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing;`);
}

/**
 * Insert an OTP challenge as the table owner (the server/service-role path).
 * `expiresInMinutes` is relative to now; created_at is pushed back by the same
 * TTL so the `expires_at > created_at` CHECK always holds, which is also how an
 * already-EXPIRED challenge is produced (expiresInMinutes = -1 → created 11
 * minutes ago, expired 1 minute ago).
 */
async function seedChallenge(
  db: PGlite,
  params: { id: string; userId: string; phone: string; code: string; expiresInMinutes?: number },
): Promise<void> {
  const expiresInMinutes = params.expiresInMinutes ?? 10;
  await db.exec("reset role;");
  await db.exec(
    `insert into public.phone_otp_challenges (id, user_id, phone_e164, code_hash, created_at, expires_at)
     values ('${params.id}', '${params.userId}', '${params.phone}', '${otpHash(params.code)}',
             now() + make_interval(mins => ${expiresInMinutes - 10}),
             now() + make_interval(mins => ${expiresInMinutes}))
     on conflict (id) do nothing;`,
  );
}

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PLACE_ID = "kopi-dari-kebun"; // seeded, published, by 0001

// ---------------------------------------------------------------------------
// A. Shape
// ---------------------------------------------------------------------------

test("0050 applies cleanly and adds the profile columns to the EXISTING users row", async () => {
  const db = await createDb();

  const columns = await rows(
    db,
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='users'
        and column_name in ('full_name','date_of_birth','phone_e164','phone_verified_at','avatar_path')
      order by column_name`,
  );
  assert.deepEqual(
    columns.map((row) => row.column_name),
    ["avatar_path", "date_of_birth", "full_name", "phone_e164", "phone_verified_at"],
    "all five profile columns must exist on public.users",
  );

  const profileTables = await rows(
    db,
    `select tablename from pg_tables where schemaname='public' and tablename like '%profile%'`,
  );
  assert.equal(profileTables.length, 0, "no second profile table may be introduced");

  const constraints = await rows(
    db,
    `select conname from pg_constraint
      where conrelid = 'public.users'::regclass
        and conname in ('full_name_length','phone_e164_format','phone_verified_requires_number','avatar_path_format')
      order by 1`,
  );
  assert.deepEqual(
    constraints.map((row) => row.conname),
    ["avatar_path_format", "full_name_length", "phone_e164_format", "phone_verified_requires_number"],
    "every profile CHECK constraint must exist",
  );

  const index = await rows(
    db,
    `select indexdef from pg_indexes
      where schemaname='public' and tablename='users' and indexname='users_phone_verified_unique_idx'`,
  );
  assert.equal(index.length, 1, "the verified-phone partial unique index must exist");
  assert.match(String(index[0]?.indexdef), /unique/i);
  assert.match(
    String(index[0]?.indexdef),
    /phone_verified_at is not null/i,
    "uniqueness must be partial: an UNVERIFIED number is not unique",
  );

  const trigger = await rows(
    db,
    `select tgname from pg_trigger
      where tgrelid='public.users'::regclass and tgname='guard_profile_write_trigger' and not tgisinternal`,
  );
  assert.equal(trigger.length, 1, "the profile write guard trigger must exist");

  // Column-level privileges: the self-owned columns are writable, the
  // verification column is NOT (the runbook's §7.2 checks assert the same).
  const columnPrivileges = await rows(
    db,
    `select
       has_column_privilege('authenticated','public.users','phone_verified_at','UPDATE') as can_verify,
       has_column_privilege('authenticated','public.users','phone_e164','UPDATE') as can_set_phone`,
  );
  assert.equal(columnPrivileges[0]?.can_verify, false, "a client can never write phone_verified_at");
  assert.equal(columnPrivileges[0]?.can_set_phone, true, "the phone number itself is self-owned");

  // The registered email is NOT a profile column at all — there is no writable
  // email field anywhere in the profile schema (it stays in Supabase Auth).
  const emailColumn = await rows(
    db,
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='users' and column_name='email'`,
  );
  assert.equal(emailColumn.length, 0, "public.users must have no email column");

  await db.close();
});

test("the OTP challenge store is reachable by the server only (RLS on, no policy, no grant)", async () => {
  const db = await createDb();

  const table = await rows(
    db,
    `select rowsecurity from pg_tables where schemaname='public' and tablename='phone_otp_challenges'`,
  );
  assert.equal(table.length, 1, "public.phone_otp_challenges must exist");
  assert.equal(table[0]?.rowsecurity, true, "RLS must be enabled on the challenge store");

  const policies = await rows(
    db,
    `select policyname from pg_policies where schemaname='public' and tablename='phone_otp_challenges'`,
  );
  assert.equal(policies.length, 0, "zero policies — fail closed for every client role");

  const privileges = await rows(
    db,
    `select
       has_table_privilege('anon','public.phone_otp_challenges','SELECT') as anon_select,
       has_table_privilege('authenticated','public.phone_otp_challenges','SELECT') as auth_select,
       has_table_privilege('authenticated','public.phone_otp_challenges','INSERT') as auth_insert`,
  );
  assert.equal(privileges[0]?.anon_select, false, "anon must not read challenges");
  assert.equal(privileges[0]?.auth_select, false, "a signed-in account must not read challenges");
  assert.equal(privileges[0]?.auth_insert, false, "a client must not create its own challenge");

  // The plaintext code can never be stored: the hash column is shape-checked.
  await assert.rejects(
    () =>
      db.exec(
        `insert into public.phone_otp_challenges (user_id, phone_e164, code_hash, expires_at)
         values ('${USER_A}', '+6281234567890', '123456', now() + interval '10 minutes')`,
      ),
    /code_hash|violates check constraint/i,
    "a non-digest code_hash must be rejected (no plaintext codes)",
  );

  await db.close();
});

test("one VERIFIED number per active account — partial unique index is the backstop", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);

  // The ONE audited path that may set the verification.
  await db.exec("reset role;");
  await db.exec(
    `begin;
     select set_config('singgah.phone_verification','on',true);
     update public.users set phone_e164='+628111111111', phone_verified_at=now() where id='${USER_A}';
     commit;`,
  );

  await assert.rejects(
    () =>
      db.exec(
        `begin;
         select set_config('singgah.phone_verification','on',true);
         update public.users set phone_e164='+628111111111', phone_verified_at=now() where id='${USER_B}';
         commit;`,
      ),
    /duplicate key|unique/i,
    "a second active account must not hold the same VERIFIED number",
  );

  await db.close();
});

test("the verification RPC is authenticated-only, and the private avatar bucket exists", async () => {
  const db = await createDb();

  const grants = await rows(
    db,
    `select
       has_function_privilege('anon','public.record_phone_otp_verification(uuid,text)','EXECUTE') as anon_exec,
       has_function_privilege('authenticated','public.record_phone_otp_verification(uuid,text)','EXECUTE') as auth_exec`,
  );
  assert.equal(grants[0]?.anon_exec, false, "anon must not execute the verification RPC");
  assert.equal(grants[0]?.auth_exec, true, "authenticated must execute the verification RPC");

  // No PUBLIC (grantee oid 0) EXECUTE on either the RPC or the trigger function.
  const publicGrants = await rows(
    db,
    `select p.proname, count(*)::int as n
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname='public'
        and p.proname in ('record_phone_otp_verification','guard_profile_write')
        and a.grantee = 0
        and a.privilege_type = 'EXECUTE'
      group by p.proname`,
  );
  assert.equal(publicGrants.length, 0, "neither function may keep a PUBLIC EXECUTE grant");

  const bucket = await rows(
    db,
    `select id, public, allowed_mime_types from storage.buckets where id='account-avatars'`,
  );
  assert.equal(bucket.length, 1, "the account-avatars bucket must exist");
  assert.equal(bucket[0]?.public, false, "the avatar bucket must be PRIVATE (no public URL, no listing)");
  assert.deepEqual(
    bucket[0]?.allowed_mime_types,
    ["image/jpeg", "image/png", "image/webp"],
    "only jpeg/png/webp may be stored",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// B. Profile write authorization
// ---------------------------------------------------------------------------

test("an account can write only its own profile columns", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);
  await setAuthUid(db, USER_A);

  const own = await rows(
    db,
    `update public.users
        set full_name = 'Budi Santoso',
            date_of_birth = current_date - interval '30 years',
            phone_e164 = '+6281234567890'
      where id = '${USER_A}'
      returning full_name, phone_e164`,
  );
  assert.equal(own.length, 1, "the account can update its own profile");
  assert.equal(own[0]?.full_name, "Budi Santoso");

  const foreign = await rows(
    db,
    `update public.users set full_name = 'Dicuri' where id = '${USER_B}' returning full_name`,
  );
  assert.equal(foreign.length, 0, "another account's row must be untouchable (RLS)");

  await assert.rejects(
    () => db.query(`update public.users set platform_role = 'platform_moderator' where id = '${USER_A}'`),
    /permission denied|must be owner/i,
    "an account must not escalate its own platform_role",
  );

  await assert.rejects(
    () => db.query(`update public.users set phone_verified_at = now() where id = '${USER_A}'`),
    /permission denied/i,
    "the verification column is not in the client GRANT",
  );

  // No INSERT/DELETE policy exists on public.users, so RLS denies both even
  // though the role holds the schema-wide default privileges.
  await assert.rejects(
    () => db.query(`insert into public.users (id) values ('${USER_C}')`),
    /row-level security|permission denied/i,
    "an account cannot create another account's row",
  );
  const deleted = await rows(db, `delete from public.users where id = '${USER_A}' returning id`);
  assert.equal(deleted.length, 0, "an account cannot delete its own or any other row");

  await db.close();
});

test("changing the phone number resets the verification to unverified", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);

  // Verify the CURRENT number through the real RPC path.
  await seedChallenge(db, {
    id: "11111111-1111-1111-1111-111111111111",
    userId: USER_A,
    phone: "+6281234567890",
    code: "123456",
  });
  await setAuthUid(db, USER_A);
  const verified = await rows(
    db,
    `select public.record_phone_otp_verification('11111111-1111-1111-1111-111111111111', '${otpHash("123456")}') as result`,
  );
  assert.equal(verified[0]?.result, "ok", "a correct code verifies the number");

  // Change the number: the verification must reset.
  const changed = await rows(
    db,
    `update public.users set phone_e164 = '+6289999999999' where id = '${USER_A}'
     returning phone_e164, phone_verified_at`,
  );
  assert.equal(changed[0]?.phone_e164, "+6289999999999");
  assert.equal(changed[0]?.phone_verified_at, null, "a new number starts UNVERIFIED");

  await db.close();
});

test("a direct write to the verification column is rejected even for the service role", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);

  await db.exec("reset role;");
  await assert.rejects(
    () => db.query(`update public.users set phone_verified_at = now() where id = '${USER_A}'`),
    /phone_verification_not_allowed/,
    "only the audited RPC may record a verification",
  );
  await assert.rejects(
    () => db.query(`insert into public.users (id, phone_verified_at) values ('${USER_B}', now())`),
    /phone_verification_not_allowed/,
    "a row is never born verified",
  );

  await db.close();
});

test("date of birth is sanity-bounded in the database", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);

  await assert.rejects(
    () => db.query(`update public.users set date_of_birth = current_date + 1 where id = '${USER_A}'`),
    /date_of_birth_invalid/,
    "a future date of birth is rejected",
  );
  await assert.rejects(
    () =>
      db.query(
        `update public.users set date_of_birth = current_date - interval '121 years' where id = '${USER_A}'`,
      ),
    /date_of_birth_invalid/,
    "an implausibly old date of birth is rejected",
  );

  const ok = await rows(
    db,
    `update public.users set date_of_birth = current_date - interval '120 years' where id = '${USER_A}'
     returning date_of_birth`,
  );
  assert.equal(ok.length, 1, "the sanity bound itself is accepted");

  await db.close();
});

// ---------------------------------------------------------------------------
// C. The OTP verification flow (the RPC is the only path)
// ---------------------------------------------------------------------------

test("a correct code moves the number from unverified to verified, exactly once", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await seedChallenge(db, {
    id: "22222222-2222-2222-2222-222222222222",
    userId: USER_A,
    phone: "+6281234567890",
    code: "654321",
  });

  const result = await rows(
    db,
    `select public.record_phone_otp_verification('22222222-2222-2222-2222-222222222222', '${otpHash("654321")}') as r`,
  );
  assert.equal(result[0]?.r, "ok");

  await db.exec("reset role;");
  const stored = await rows(
    db,
    `select phone_e164, phone_verified_at, (select consumed_at is not null from public.phone_otp_challenges
        where id='22222222-2222-2222-2222-222222222222') as consumed
       from public.users where id='${USER_A}'`,
  );
  assert.equal(stored[0]?.phone_e164, "+6281234567890");
  assert.notEqual(stored[0]?.phone_verified_at, null, "the verification timestamp is recorded");
  assert.equal(stored[0]?.consumed, true, "the challenge is single-use");

  // Replaying the same challenge is refused.
  await setAuthUid(db, USER_A);
  const replay = await rows(
    db,
    `select public.record_phone_otp_verification('22222222-2222-2222-2222-222222222222', '${otpHash("654321")}') as r`,
  );
  assert.equal(replay[0]?.r, "phone_otp_invalid", "a consumed challenge cannot be reused");

  await db.close();
});

test("a wrong code is refused and exhaustion is bounded", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await seedChallenge(db, {
    id: "33333333-3333-3333-3333-333333333333",
    userId: USER_A,
    phone: "+6281234567890",
    code: "111111",
  });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const wrong = await rows(
      db,
      `select public.record_phone_otp_verification('33333333-3333-3333-3333-333333333333', '${otpHash("000000")}') as r`,
    );
    assert.equal(wrong[0]?.r, "phone_otp_invalid", `attempt ${attempt} must be refused`);
  }

  const fifth = await rows(
    db,
    `select public.record_phone_otp_verification('33333333-3333-3333-3333-333333333333', '${otpHash("000000")}') as r`,
  );
  assert.equal(fifth[0]?.r, "phone_otp_too_many_attempts", "the 5th attempt exhausts the challenge");

  // Even the CORRECT code cannot revive an exhausted challenge.
  const correct = await rows(
    db,
    `select public.record_phone_otp_verification('33333333-3333-3333-3333-333333333333', '${otpHash("111111")}') as r`,
  );
  assert.equal(correct[0]?.r, "phone_otp_too_many_attempts");

  await db.exec("reset role;");
  const verified = await rows(
    db,
    `select phone_verified_at from public.users where id='${USER_A}'`,
  );
  assert.equal(verified[0]?.phone_verified_at, null, "an exhausted challenge never verifies");

  await db.close();
});

test("an expired code is refused and the challenge is closed", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await setAuthUid(db, USER_A);
  await seedChallenge(db, {
    id: "44444444-4444-4444-4444-444444444444",
    userId: USER_A,
    phone: "+6281234567890",
    code: "222222",
    expiresInMinutes: -1,
  });

  const result = await rows(
    db,
    `select public.record_phone_otp_verification('44444444-4444-4444-4444-444444444444', '${otpHash("222222")}') as r`,
  );
  assert.equal(result[0]?.r, "phone_otp_expired");

  await db.exec("reset role;");
  const challenge = await rows(
    db,
    `select consumed_at from public.phone_otp_challenges where id='44444444-4444-4444-4444-444444444444'`,
  );
  assert.notEqual(challenge[0]?.consumed_at, null, "an expired challenge is closed, never reused");
  const verified = await rows(db, `select phone_verified_at from public.users where id='${USER_A}'`);
  assert.equal(verified[0]?.phone_verified_at, null);

  await db.close();
});

test("another account's challenge, and an anonymous caller, are refused", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);
  await seedChallenge(db, {
    id: "55555555-5555-5555-5555-555555555555",
    userId: USER_A,
    phone: "+6281234567890",
    code: "333333",
  });

  // Account B cannot complete account A's challenge — the answer is identical
  // to a wrong code, so no existence is leaked.
  await setAuthUid(db, USER_B);
  const foreign = await rows(
    db,
    `select public.record_phone_otp_verification('55555555-5555-5555-5555-555555555555', '${otpHash("333333")}') as r`,
  );
  assert.equal(foreign[0]?.r, "phone_otp_invalid", "a foreign challenge is not verifiable");

  // An anonymous session cannot verify anything.
  await db.exec("reset role;");
  await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';`);
  await db.exec("set role anon;");
  await assert.rejects(
    () =>
      db.query(
        `select public.record_phone_otp_verification('55555555-5555-5555-5555-555555555555', '${otpHash("333333")}')`,
      ),
    /permission denied/i,
    "anon holds no EXECUTE on the verification RPC",
  );

  await db.close();
});

test("a number already verified on another account is never verifiable, and answers like a wrong code", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);

  // A verifies +6281234567890 through the real flow.
  await seedChallenge(db, {
    id: "66666666-6666-6666-6666-666666666666",
    userId: USER_A,
    phone: "+6281234567890",
    code: "444444",
  });
  await setAuthUid(db, USER_A);
  await rows(
    db,
    `select public.record_phone_otp_verification('66666666-6666-6666-6666-666666666666', '${otpHash("444444")}') as r`,
  );

  // B tries to verify the SAME number with a CORRECT code.
  await seedChallenge(db, {
    id: "77777777-7777-7777-7777-777777777777",
    userId: USER_B,
    phone: "+6281234567890",
    code: "555555",
  });
  await setAuthUid(db, USER_B);
  const taken = await rows(
    db,
    `select public.record_phone_otp_verification('77777777-7777-7777-7777-777777777777', '${otpHash("555555")}') as r`,
  );
  assert.equal(taken[0]?.r, "phone_otp_invalid", "the answer is IDENTICAL to a wrong code (no account leak)");

  await db.exec("reset role;");
  const b = await rows(db, `select phone_verified_at from public.users where id='${USER_B}'`);
  assert.equal(b[0]?.phone_verified_at, null, "nothing is recorded for the second account");

  await db.close();
});

// ---------------------------------------------------------------------------
// D. Concept separation — phone verification is NOT manager / Place validation
// ---------------------------------------------------------------------------

test("the manual DEV access-check script executes end-to-end on a real Postgres engine", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/profile-phone-otp-access.sql", import.meta.url),
    "utf8",
  )
    // psql meta-commands are client-side; PGlite parses only SQL.
    .split("\n")
    .filter((line) => !/^\s*\\/.test(line))
    .join("\n");

  // The script raises at its final verdict if ANY check failed, so completing
  // without an exception IS "PROFILE OTP ACCESS: ALL CHECKS PASSED".
  await db.exec(script);
  await db.close();
});

test("verifying a phone never changes producer or Place claim status", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await db.exec("reset role;");
  await db.exec(`insert into public.producers (id, display_name) values ('p-owner', 'Pengelola Kopi') on conflict do nothing;`);
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${USER_A}', 'p-owner', '${PLACE_ID}', 'owner') on conflict do nothing;`,
  );

  const before = await rows(
    db,
    `select (select claim_status from public.producers where id='p-owner') as producer_status,
            (select claim_status from public.places where id='${PLACE_ID}') as place_status`,
  );

  await seedChallenge(db, {
    id: "88888888-8888-8888-8888-888888888888",
    userId: USER_A,
    phone: "+6281234567890",
    code: "666666",
  });
  await setAuthUid(db, USER_A);
  const verified = await rows(
    db,
    `select public.record_phone_otp_verification('88888888-8888-8888-8888-888888888888', '${otpHash("666666")}') as r`,
  );
  assert.equal(verified[0]?.r, "ok");

  await db.exec("reset role;");
  const after = await rows(
    db,
    `select (select claim_status from public.producers where id='p-owner') as producer_status,
            (select claim_status from public.places where id='${PLACE_ID}') as place_status`,
  );
  assert.deepEqual(after, before, "phone verification must not touch manager or Place claim status");

  // Source guard on the EXECUTABLE statements (comments record the boundary and
  // may name the concepts): 0050 must not write to those tables at all.
  const executable = readMigration(NEW_MIGRATION).replace(/--[^\n]*/g, " ");
  assert.doesNotMatch(
    executable,
    /(insert into|update|delete from|alter table)\s+public\.(producers|places|live_operators|live_operator_invitations)/i,
    "0050 must not write to producers, places, or the operator tables",
  );
  assert.doesNotMatch(executable, /claim_status/, "0050 must not reference claim_status at all");

  await db.close();
});
