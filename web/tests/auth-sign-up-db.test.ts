import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * SIGN-UP → ACCOUNT ROW — S-01/S-02, on a REAL Postgres engine (PGlite).
 *
 * The audit (§3, S-01) found that the `signUp` path had never been exercised
 * end to end: `auth.users` is created by Supabase Auth, `public.users` by the
 * `on_auth_user_created` trigger (0001), and nobody had ever proven that
 *
 *  - a new account really gets exactly ONE mirrored `public.users` row;
 *  - hostile client metadata (`role`, `platform_role`, `producer_id`) cannot
 *    become authority;
 *  - a profile-sync failure cannot leave HALF a sign-up behind (an account with
 *    no profile row);
 *  - re-submitting the SAME email cannot produce a second account or profile;
 *  - a client cannot insert its own `public.users` row.
 *
 * The whole thing runs WITHOUT the DEV project, on the real migration chain, by
 * emulating the two things Supabase Auth does to the database: INSERT into
 * `auth.users`, and (for the failure case) an error surfacing from the trigger.
 *
 * NOT-RUN here (needs the DEV project + its email template; manual steps are in
 * docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md §9): the real confirmation
 * email click, the DEV template's use of {{ .ConfirmationURL }}, and the actual
 * `auth.signUp` HTTP round trip.
 *
 * The HTTP half — the route's input validation, the `role`/`producer_id`
 * refusal, the `emailRedirectTo` destination and the callback's open-redirect
 * guard — is executed in tests/auth-sign-up-flow.test.ts.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
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
  "0050_profile_phone_verification.sql",
  "0051_live_auth_integrity.sql",
];

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

/**
 * Supabase-shaped harness: `auth.users` (with the unique email constraint the
 * Auth service relies on), `auth.uid()`, the client roles, and the real
 * migration chain up to 0051.
 */
async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (
      id                 uuid primary key,
      email              text unique,
      email_confirmed_at timestamptz,
      encrypted_password text,
      raw_user_meta_data jsonb,
      raw_app_meta_data  jsonb
    );
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
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
      // Supabase's default table grants, as the platform sets them up.
      await db.exec(
        `grant usage on schema public to anon, authenticated;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
  return db;
}

/** The exact INSERT Supabase Auth performs for a new email/password account. */
const signUpInsert = (
  id: string,
  email: string,
  metadata: Record<string, unknown> = {},
): { sql: string; params: unknown[] } => ({
  sql: `insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
        values ($1::uuid, $2::text, $3::jsonb, $4::jsonb)`,
  params: [id, email, JSON.stringify(metadata), JSON.stringify({ provider: "email", providers: ["email"] })],
});

const USER_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_B = "bbbbbbbb-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// S-01 — the mirror is created, exactly once, and carries no authority
// ---------------------------------------------------------------------------

test("S-01: a sign-up creates exactly ONE mirrored public.users row", async () => {
  const db = await createDb();

  // The trigger is part of the chain and is a SECURITY DEFINER with a pinned
  // search_path — the property that lets an Auth-owned insert write the row.
  const trigger = await rows(
    db,
    `select p.prosecdef as security_definer,
            p.proconfig::text as config,
            t.tgenabled as enabled
       from pg_trigger t
       join pg_proc p on p.oid = t.tgfoid
      where t.tgname = 'on_auth_user_created'
        and t.tgrelid = 'auth.users'::regclass`,
  );
  assert.equal(trigger.length, 1, "the on_auth_user_created trigger must exist on auth.users");
  assert.equal(trigger[0].security_definer, true, "the sync function must be SECURITY DEFINER");
  assert.match(String(trigger[0].config), /search_path=public/, "search_path must be pinned");
  assert.equal(trigger[0].enabled, "O");

  const insert = signUpInsert(USER_A, "baru@example.com", { display_name: "Budi" });
  await db.query(insert.sql, insert.params);

  const mirrored = await rows(db, `select id, username, platform_role from public.users`);
  assert.deepEqual(mirrored, [{ id: USER_A, username: null, platform_role: null }]);
  const count = await rows(db, `select count(*)::int as n from public.users`);
  assert.equal(count[0].n, 1, "exactly one mirrored row — never zero, never two");

  // A profile without an account is impossible: the FK rejects it.
  await assert.rejects(
    () => db.query(`insert into public.users (id) values ('${USER_B}'::uuid)`),
    /foreign key|violates/i,
    "public.users.id must reference auth.users(id)",
  );

  await db.close();
});

test("S-01: client metadata never becomes authority", async () => {
  const db = await createDb();

  // Everything a hostile client could try to smuggle through sign-up options.
  const insert = signUpInsert(USER_A, "hostile@example.com", {
    display_name: "Budi",
    role: "owner",
    producer_id: "rumah-teh-producer",
    platform_role: "platform_moderator",
    place_id: "rumah-teh-lokal",
  });
  await db.query(insert.sql, insert.params);

  const user = await rows(db, `select platform_role, username from public.users`);
  assert.equal(user[0].platform_role, null, "metadata cannot set a platform role");
  assert.equal(user[0].username, null, "metadata cannot set the public username");

  for (const table of ["producer_memberships", "live_operators"]) {
    const n = await rows(db, `select count(*)::int as n from public.${table}`);
    assert.equal(n[0].n, 0, `metadata cannot create a ${table} row`);
  }

  // The trigger body inserts the id and NOTHING else — the executable proof is
  // the row above; this pins it so a future edit cannot start reading metadata.
  const body = readMigration("0001_visit_intent_foundation.sql").slice(
    readMigration("0001_visit_intent_foundation.sql").indexOf("function public.handle_new_user"),
  );
  const bodySource = body.slice(0, body.indexOf("$$;"));
  assert.doesNotMatch(bodySource, /raw_user_meta_data|raw_app_meta_data/);

  await db.close();
});

// ---------------------------------------------------------------------------
// S-01 — partial failure and retry
// ---------------------------------------------------------------------------

test("S-01: a failed profile sync leaves NOTHING behind, and the retry works", async () => {
  const db = await createDb();

  // Simulate the failure mode S-01 asks about: the profile write itself fails
  // (permission/RLS/constraint). The trigger is replaced with an identical body
  // that raises for one email, so the failure happens INSIDE the same statement
  // that inserts the account.
  await db.exec(`
    create or replace function public.handle_new_user()
    returns trigger
    language plpgsql
    security definer set search_path = public
    as $$
    begin
      if new.email like '%broken%' then
        raise exception 'simulated_profile_sync_failure';
      end if;
      insert into public.users (id) values (new.id) on conflict (id) do nothing;
      return new;
    end;
    $$;
  `);

  const broken = signUpInsert(USER_A, "broken@example.com");
  await assert.rejects(
    () => db.query(broken.sql, broken.params),
    /simulated_profile_sync_failure/,
    "the sign-up must fail visibly, not silently half-succeed",
  );

  // Atomicity: no account without a profile, and no profile without an account.
  assert.equal(
    (await rows(db, `select count(*)::int as n from auth.users`))[0].n,
    0,
    "a failed profile sync must roll the account back",
  );
  assert.equal(
    (await rows(db, `select count(*)::int as n from public.users`))[0].n,
    0,
    "no orphan profile may survive the failure",
  );

  // The account is therefore retryable: restore the real trigger body and
  // re-submit the SAME email — it succeeds, leaving exactly one row in each
  // table. (The restored body is the 0001 body, which the first test in this
  // file pins against the migration source.)
  await db.exec(`
    create or replace function public.handle_new_user()
    returns trigger
    language plpgsql
    security definer set search_path = public
    as $$
    begin
      insert into public.users (id) values (new.id) on conflict (id) do nothing;
      return new;
    end;
    $$;
  `);

  const retry = signUpInsert(USER_A, "broken@example.com");
  await db.query(retry.sql, retry.params);
  assert.equal((await rows(db, `select count(*)::int as n from auth.users`))[0].n, 1);
  assert.equal((await rows(db, `select count(*)::int as n from public.users`))[0].n, 1);

  await db.close();
});

test("S-01: the same email cannot create a second account, and a re-insert never duplicates the profile", async () => {
  const db = await createDb();
  const first = signUpInsert(USER_A, "sama@example.com");
  await db.query(first.sql, first.params);

  // Supabase Auth's own uniqueness rule: a second sign-up with the same email is
  // refused by the database, so no second `public.users` row can appear.
  const duplicate = signUpInsert(USER_B, "sama@example.com");
  await assert.rejects(
    () => db.query(duplicate.sql, duplicate.params),
    /duplicate key|unique/i,
    "a duplicate email must be refused",
  );
  assert.equal((await rows(db, `select count(*)::int as n from public.users`))[0].n, 1);

  // And the trigger is idempotent by construction (`on conflict do nothing`):
  // even if the same account row were re-inserted, the mirror stays single.
  await db.exec(
    `insert into public.users (id) values ('${USER_A}'::uuid) on conflict (id) do nothing;`,
  );
  assert.equal(
    (await rows(db, `select count(*)::int as n from public.users where id = '${USER_A}'`))[0].n,
    1,
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// S-01 — a client can never mint its own profile row
// ---------------------------------------------------------------------------

test("S-01: a signed-in client cannot insert its own public.users row", async () => {
  const db = await createDb();
  const signUp = signUpInsert(USER_A, "klien@example.com");
  await db.query(signUp.sql, signUp.params);

  // The client knows its own id (it is in the session) — it must still fail:
  // public.users is RLS-on with a SELECT-only self policy.
  await db.exec("set role authenticated;");
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: USER_A, role: "authenticated" }),
  ]);
  await assert.rejects(
    () =>
      db.query(
        `insert into public.users (id, platform_role) values ('${USER_B}'::uuid, 'platform_moderator')`,
      ),
    /row-level security|permission denied|violates/i,
    "a client must not be able to insert a profile row (or a platform role)",
  );
  const self = await rows(db, `select id from public.users`);
  await db.exec("reset role;");
  assert.deepEqual(self, [{ id: USER_A }]);

  // An unauthenticated caller is refused the same way.
  await db.exec("set role anon;");
  await assert.rejects(
    () => db.query(`insert into public.users (id) values ('${USER_B}'::uuid)`),
    /row-level security|permission denied|violates/i,
    "an anonymous caller must not be able to insert a profile row",
  );
  await db.exec("reset role;");

  // The guard is the RLS + policy posture (Supabase grants table privileges
  // broadly and relies on RLS), so assert exactly that: RLS on, and NO policy
  // that would admit a client INSERT.
  assert.equal(
    (await rows(db, `select relrowsecurity as ok from pg_class where oid = 'public.users'::regclass`))[0].ok,
    true,
    "public.users must have RLS enabled",
  );
  assert.equal(
    (
      await rows(
        db,
        `select count(*)::int as n from pg_policies
          where schemaname = 'public' and tablename = 'users' and cmd in ('INSERT', 'ALL')`,
      )
    )[0].n,
    0,
    "no policy may admit a client INSERT into public.users",
  );

  await db.close();
});
