import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * A-02 — `live_sessions` provider-sensitive columns are server-side only
 * (migration 0052).
 *
 * The audit found `grant select on public.live_sessions to anon, authenticated`
 * (0008) exposing EVERY column to client roles; RLS restricts rows, not
 * columns. `live_input_id` (Cloudflare input UID) and `idempotency_key` were
 * therefore readable with the public anon key, against
 * MASTER_LIVE_TECH_v1.0.md §1.2/§5 (stream/provider data is server-side only).
 *
 * This suite runs the REAL migration chain on Postgres (PGlite) and proves:
 *  - the table-level SELECT is gone for anon/authenticated and replaced by a
 *    SAFE COLUMN grant that excludes live_input_id / idempotency_key;
 *  - nothing is granted to anon that it did not already have (strict subset:
 *    no table-level SELECT, no write privilege);
 *  - the denial is real AT CALL TIME (permission denied for the column), for
 *    both anon and a signed-in viewer, and `select *` fails the same way;
 *  - every legitimate read path still works: the caller-session reads of the
 *    safe columns (discovery/status/viewer page/producer console) and the
 *    service-role reads of the pointer columns (playback signing, publish-URL
 *    re-issuance, cleanup sweep);
 *  - 0052 applies cleanly and re-applies as a no-op (SQL-Editor paste path).
 *
 * The same contract, as a runnable DEV script emitting a result set, lives in
 * tests/db-regression/live-session-column-access.sql (executed here).
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
  "0052_live_session_column_privileges.sql",
];

/** The safe column set 0052 grants; the two provider columns are excluded. */
const SAFE_COLUMNS = [
  "id",
  "place_id",
  "producer_id",
  "stage_id",
  "status",
  "created_at",
  "started_at",
  "ended_at",
  "ended_reason",
  "end_note",
  "viewer_peak",
  "content_status",
];
const PROTECTED_COLUMNS = ["live_input_id", "idempotency_key"];

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

const USER_VIEWER = "aaaaaaaa-0000-4000-8000-000000000001";

/** Supabase-shaped harness: auth.users + auth.uid() from the JWT claims. */
async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key,
      email text unique,
      email_confirmed_at timestamptz,
      encrypted_password text,
      raw_user_meta_data jsonb,
      raw_app_meta_data jsonb
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
    -- Supabase's platform default: the client roles hold broad table grants on
    -- public (applied through default privileges at project creation, i.e.
    -- BEFORE any migration). The chain's own revokes must therefore stick.
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;

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
  }
  return db;
}

/** RLS-visible fixture: one published Place with one LIVE session. */
async function seedLiveSession(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at)
    values ('${USER_VIEWER}', 'penonton@example.com', now()) on conflict (id) do nothing;
    insert into public.producers (id, display_name)
    values ('prod-a02', 'Pengelola A02') on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('stage-a02', 'rumah-teh-lokal', 'Tahap A02', 'x', 0, 'published') on conflict (id) do nothing;
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, live_input_id, idempotency_key)
    values ('sess-a02', 'rumah-teh-lokal', 'prod-a02', 'stage-a02', 'live', 'input-secret-a02', 'start-key-a02')
    on conflict (id) do nothing;
  `);
}

async function asRole(db: PGlite, role: string, sub: string | null): Promise<void> {
  await db.exec(`set role ${role};`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    sub ? JSON.stringify({ sub, role }) : "",
  ]);
}

// ---------------------------------------------------------------------------
// 1. Migration shape: applies cleanly, re-applies as a no-op, safe column set
// ---------------------------------------------------------------------------

test("0052 applies cleanly, is idempotent, and grants only the safe columns", async () => {
  const db = await createDb();
  // Whole-file re-run (SQL Editor paste) must be a no-op.
  await db.exec(stripPgcrypto(readMigration("0052_live_session_column_privileges.sql")));

  const privilege = async (role: string, column: string): Promise<boolean> =>
    Boolean(
      (
        await rows(
          db,
          `select has_column_privilege($1, 'public.live_sessions', $2, 'SELECT') as ok`,
          [role, column],
        )
      )[0].ok,
    );

  for (const role of ["anon", "authenticated"]) {
    for (const column of SAFE_COLUMNS) {
      assert.equal(await privilege(role, column), true, `${role} must read live_sessions.${column}`);
    }
    for (const column of PROTECTED_COLUMNS) {
      assert.equal(
        await privilege(role, column),
        false,
        `${role} must NOT read live_sessions.${column}`,
      );
    }
    // No write privilege is added anywhere.
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      assert.equal(
        Boolean(
          (
            await rows(
              db,
              `select has_table_privilege($1, 'public.live_sessions', $2) as ok`,
              [role, action],
            )
          )[0].ok,
        ),
        false,
        `${role} must not hold ${action} on live_sessions`,
      );
    }
  }

  // The server infrastructure connection keeps full access (incl. the pointer).
  for (const column of [...SAFE_COLUMNS, ...PROTECTED_COLUMNS]) {
    assert.equal(
      await privilege("service_role", column),
      true,
      `service_role must keep reading live_sessions.${column}`,
    );
  }

  await db.close();
});

test("0052 only removes privileges from anon/authenticated — nothing is widened", () => {
  const source = readMigration("0052_live_session_column_privileges.sql");
  // The only grants in the migration are the safe column grant (anon,
  // authenticated) and the service-role read.
  const grants = [...source.matchAll(/^grant [^;]+;/gim)].map((match) => match[0]);
  assert.deepEqual(grants.sort(), [
    "grant select (\n  id,\n  place_id,\n  producer_id,\n  stage_id,\n  status,\n  created_at,\n  started_at,\n  ended_at,\n  ended_reason,\n  end_note,\n  viewer_peak,\n  content_status\n) on public.live_sessions to anon, authenticated;",
    "grant select on public.live_sessions to service_role;",
  ]);
  // No INSERT/UPDATE/DELETE grant, no schema-wide grant, no function grant.
  assert.doesNotMatch(source, /grant (insert|update|delete|truncate|all)/i);
  assert.doesNotMatch(source, /grant [^;]* on all tables/i);
  assert.doesNotMatch(source, /grant [^;]* on (function|schema)/i);
  // RLS policies and DML posture are untouched (grants only).
  assert.doesNotMatch(source, /create policy|drop policy|enable row level security/i);
});

// ---------------------------------------------------------------------------
// 2. Call-time behaviour: the provider columns are unreachable for clients
// ---------------------------------------------------------------------------

test("anon and a signed-in viewer are refused the protected columns at call time", async () => {
  const db = await createDb();
  await seedLiveSession(db);

  for (const [role, sub] of [
    ["anon", null],
    ["authenticated", USER_VIEWER],
  ] as Array<[string, string | null]>) {
    await asRole(db, role, sub);

    // `select *` expands to every column, so it is refused as well.
    for (const query of [
      "select live_input_id from public.live_sessions",
      "select idempotency_key from public.live_sessions",
      "select * from public.live_sessions",
    ]) {
      await assert.rejects(
        () => db.query(query),
        (error: Error) => {
          assert.match(String(error.message), /permission denied/i, `${role}: ${query}`);
          return true;
        },
        `${role} must be refused: ${query}`,
      );
    }

    await db.exec("reset role;");
  }

  // A signed-in viewer reads the safe column set (RLS still decides the rows).
  await asRole(db, "authenticated", USER_VIEWER);
  const safe = await rows(
    db,
    `select id, place_id, status, viewer_peak, content_status from public.live_sessions`,
  );
  assert.equal(safe.length, 1, "authenticated must still read the safe columns");
  assert.equal(safe[0].id, "sess-a02");
  assert.equal(safe[0].viewer_peak, 0);
  await db.exec("reset role;");

  // CHARACTERIZATION of a PRE-EXISTING defect this suite discovered (reported
  // as a new finding in the audit doc, NOT caused by 0052 and NOT fixed here):
  // migration 0047's `live_sessions_live_operator_read` policy (and the Places /
  // production_stages operator policies) reference public.live_operators, which
  // anon holds NO privilege on. RLS policy expressions run with the querying
  // role's privileges, so an ANONYMOUS read of live_sessions fails with
  // "permission denied for table live_operators" before any row is considered —
  // fail-closed, but it breaks public Live metadata reads. When the fix lands
  // (a SECURITY DEFINER helper instead of a direct table reference), this
  // assertion must be replaced by the anon positive read.
  await asRole(db, "anon", null);
  await assert.rejects(
    () => db.query(`select id from public.live_sessions`),
    (error: Error) => {
      assert.match(String(error.message), /permission denied for table live_operators/i);
      return true;
    },
    "documented pre-existing anon policy-ACL defect (fail-closed)",
  );
  await db.exec("reset role;");

  await db.close();
});

test("the service-role pointer path still works for the legitimate server flows", async () => {
  const db = await createDb();
  await seedLiveSession(db);

  // Playback signing / publish-URL re-issuance read the pointer this way.
  await db.exec("set role service_role;");
  const pointer = await rows(
    db,
    `select live_input_id from public.live_sessions where id = 'sess-a02'`,
  );
  await db.exec("reset role;");
  assert.equal(pointer[0].live_input_id, "input-secret-a02");

  // A-03's cleanup path (service-role only) still sees it end to end.
  await db.exec(`update public.live_sessions set status = 'ended' where id = 'sess-a02'`);
  await db.exec("set role service_role;");
  const released = await rows(db, `select public.release_live_input('sess-a02') as input_id`);
  await db.exec("reset role;");
  assert.equal(released[0].input_id, "input-secret-a02");
  const after = await rows(db, `select live_input_id from public.live_sessions where id = 'sess-a02'`);
  assert.equal(after[0].live_input_id, null);

  await db.close();
});

test("client sessions that name only safe columns keep every app read path working", async () => {
  const db = await createDb();
  await seedLiveSession(db);

  await asRole(db, "authenticated", USER_VIEWER);
  // Mirrors the real readers: viewer page, discovery/status routes, Place
  // strip, producer console and the service layer's safe-column selects.
  const session = await rows(
    db,
    `select id, place_id, producer_id, stage_id, status, started_at, ended_at, ended_reason, end_note, viewer_peak
       from public.live_sessions where id = 'sess-a02'`,
  );
  assert.equal(session.length, 1);
  assert.equal(session[0].status, "live");
  await db.exec("reset role;");

  // The typed service layer must not fall back to `select *` anywhere (that is
  // how the protected columns would be requested again).
  const serviceSource = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(serviceSource, /from\("live_sessions"\)\s*\.select\("\*"\)/);
  assert.match(serviceSource, /const LIVE_SESSION_SAFE_COLUMNS =/);
  const capSource = readFileSync(new URL("../lib/live/session-service-cap.ts", import.meta.url), "utf8");
  assert.match(capSource, /createSupabaseServiceClient\(\)/);
  const viewerPage = readFileSync(new URL("../app/live/[sessionId]/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(viewerPage, /\.select\("[^"]*live_input_id/);
  assert.match(
    viewerPage,
    /\.select\("id, place_id, stage_id, status, started_at, ended_at, ended_reason, viewer_peak"\)/,
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 3. The runnable DEV script (result set of check_name / passed / detail)
// ---------------------------------------------------------------------------

test("db-regression/live-session-column-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-session-column-access.sql", import.meta.url),
    "utf8",
  );

  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Array<Record<string, unknown>>;
  assert.ok(checkRows.length >= 20, `expected >= 20 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );

  const leftover = await rows(db, `select 1 as one from public.live_sessions where id = 'sess-a02-dev'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});
