import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0049 — DELEGATED OPERATOR LIVE AUTHORITY (start/end).
 *
 * The gap: 0047/0048 create an ACTIVE public.live_operators assignment for an
 * accepted invitation, and the routes already authorize it
 * (lib/live/operator-authorization.ts), but start_live_session (0008) and
 * end_live_session (0012) still required producer_memberships owner/manager, so
 * the RPC refused the operator the route had just allowed.
 *
 * This suite runs the real chain on Postgres (PGlite) and drives the real RPCs:
 * - an owner/manager still starts and ends Live (no regression);
 * - a delegated operator with an ACCEPTED, still-active invitation starts and
 *   ends Live, and the session belongs to the granting Producer;
 * - after the invitation is revoked, the operator's VERY NEXT start and end are
 *   refused (authorization is inside the RPC and uncached);
 * - an operator of Place A cannot start or end Live for Place B;
 * - an unrelated account and an editor are refused;
 * - the authority predicate is internal (no client EXECUTE) and 0008/0012 are
 *   untouched.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

const PRE_47 = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0012_live_end_idempotency.sql",
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
];

const POST_47 = [
  "0047_account_center_live_operator.sql",
  "0048_live_operator_invitations.sql",
  "0049_live_operator_authority.sql",
];

const MANAGER = "11111111-1111-1111-1111-111111111111";
const MANAGER_B = "11111111-1111-1111-1111-222222222222";
const OPERATOR = "22222222-2222-2222-2222-222222222222";
const EDITOR = "55555555-5555-5555-5555-555555555555";
const OUTSIDER = "44444444-4444-4444-4444-444444444444";

const PLACE_A = "rumah-teh-lokal"; // seeded by 0001
const PLACE_B = "kopi-dari-kebun"; // seeded by 0001
const PRODUCER_A = "prod-a";
const PRODUCER_B = "prod-b";
const STAGE_A = "stage-auth-a";
const STAGE_B = "stage-auth-b";

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
  for (const name of PRE_47) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  // Supabase-style default privileges before the 004x hardening migrations.
  await db.exec(
    `grant usage on schema public to anon, authenticated;
     grant all on all tables in schema public to anon, authenticated;
     grant usage, select on all sequences in schema public to anon, authenticated;`,
  );
  for (const name of POST_47) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  return db;
}

async function actAs(db: PGlite, userId: string | null): Promise<void> {
  await db.exec("reset role;");
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select ${
      userId ? `'${userId}'::uuid` : "null::uuid"
    } $fn$`,
  );
  await db.exec("set role authenticated;");
}

async function resetRole(db: PGlite): Promise<void> {
  await db.exec("reset role;");
}

async function seedUser(db: PGlite, userId: string, email: string): Promise<void> {
  await db.exec(
    `insert into auth.users (id, email, email_confirmed_at) values ('${userId}', '${email}', now()) on conflict do nothing`,
  );
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing`);
}

async function seedMembership(
  db: PGlite,
  userId: string,
  producerId: string,
  placeId: string,
  role: string,
): Promise<void> {
  await db.exec(
    `insert into public.producers (id, display_name) values ('${producerId}', 'Pengelola ${producerId}') on conflict do nothing`,
  );
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${userId}', '${producerId}', '${placeId}', '${role}') on conflict do nothing`,
  );
}

async function seedWorld(): Promise<PGlite> {
  const db = await createDb();
  await seedUser(db, MANAGER, "manager@example.com");
  await seedUser(db, MANAGER_B, "manager-b@example.com");
  await seedUser(db, OPERATOR, "operator@example.com");
  await seedUser(db, EDITOR, "editor@example.com");
  await seedUser(db, OUTSIDER, "outsider@example.com");
  await seedMembership(db, MANAGER, PRODUCER_A, PLACE_A, "owner");
  await seedMembership(db, MANAGER_B, PRODUCER_B, PLACE_B, "owner");
  await seedMembership(db, EDITOR, PRODUCER_A, PLACE_A, "editor");

  // Live eligibility + a published stage for each Place, so the ONLY thing that
  // can refuse a start is the authorization predicate.
  await db.exec(
    `insert into public.live_eligibility (producer_id, path, active, granted_by)
     values ('${PRODUCER_A}', 'ADMIN_APPROVED', true, 'regression'),
            ('${PRODUCER_B}', 'ADMIN_APPROVED', true, 'regression')
     on conflict (producer_id, path) do update set active = true;`,
  );
  await db.exec(
    `insert into public.production_stages (id, place_id, title, description, sort_order, status)
     values ('${STAGE_A}', '${PLACE_A}', 'Tahap A', 'x', 0, 'published'),
            ('${STAGE_B}', '${PLACE_B}', 'Tahap B', 'x', 0, 'published')
     on conflict (id) do nothing;`,
  );
  return db;
}

/** Invite `email` to `placeId` as `manager`, then accept as the invitee. */
async function inviteAndAccept(
  db: PGlite,
  manager: string,
  placeId: string,
  email: string,
  invitee: string,
): Promise<void> {
  await actAs(db, manager);
  await db.query(`select public.invite_live_operator($1::text, $2::text)`, [placeId, email]);
  await resetRole(db);
  const found = await rows(
    db,
    `select id from public.live_operator_invitations where place_id = $1 and status = 'pending'`,
    [placeId],
  );
  await actAs(db, invitee);
  await db.query(`select public.accept_live_operator_invitation($1::uuid)`, [String(found[0].id)]);
  await resetRole(db);
}

async function startSession(
  db: PGlite,
  actor: string,
  placeId: string,
  stageId: string,
  key: string,
): Promise<string> {
  await actAs(db, actor);
  const out = await rows(
    db,
    `select public.start_live_session($1::text, $2::text, $3::text, $4::text) as sid`,
    [placeId, stageId, key, `input-${key}`],
  );
  await resetRole(db);
  const value = out[0].sid as Record<string, unknown>;
  return String(value.sessionId);
}

// ---------------------------------------------------------------------------
// Migration shape
// ---------------------------------------------------------------------------

test("0049 applies cleanly, is idempotent, and keeps anon off both Live RPCs", async () => {
  const db = await createDb();
  // Whole-file re-run (SQL-Editor paste) must be a no-op.
  await db.exec(stripPgcrypto(readMigration("0049_live_operator_authority.sql")));

  for (const fn of [
    "public.start_live_session(text,text,text,text)",
    "public.end_live_session(text,text,text,text)",
  ]) {
    assert.equal(
      Boolean((await rows(db, `select has_function_privilege('authenticated','${fn}','EXECUTE') as ok`))[0].ok),
      true,
      `${fn}: authenticated must hold EXECUTE`,
    );
    assert.equal(
      Boolean((await rows(db, `select has_function_privilege('anon','${fn}','EXECUTE') as ok`))[0].ok),
      false,
      `${fn}: anon must not hold EXECUTE`,
    );
  }

  // The predicate is internal: only the definer RPCs may call it.
  for (const role of ["authenticated", "anon"]) {
    assert.equal(
      Boolean(
        (await rows(
          db,
          `select has_function_privilege('${role}','public.can_operate_live_for_place(uuid,text)','EXECUTE') as ok`,
        ))[0].ok,
      ),
      false,
      `${role} must not be able to probe the authority predicate`,
    );
  }

  await db.close();
});

// ---------------------------------------------------------------------------
// Authorization behaviour through the real RPCs
// ---------------------------------------------------------------------------

test("an owner/manager can still start and end Live (no regression)", async () => {
  const db = await seedWorld();
  const sid = await startSession(db, MANAGER, PLACE_A, STAGE_A, "mgr-key-1");
  assert.ok(sid, "the owner started a session");

  await actAs(db, MANAGER);
  const ended = await rows(
    db,
    `select public.end_live_session($1::text, $2::text, 'producer_ended', null) as ok`,
    [sid, "mgr-end-1"],
  );
  assert.equal(ended[0].ok, true, "the owner ended the session");
  await resetRole(db);

  const stored = await rows(
    db,
    `select status, producer_id from public.live_sessions where id = $1`,
    [sid],
  );
  assert.equal(stored[0].status, "ended");
  assert.equal(stored[0].producer_id, PRODUCER_A, "an owner/manager session keeps the membership producer");
  await db.close();
});

test("an accepted operator can start AND end Live, and the session belongs to the granting Producer", async () => {
  const db = await seedWorld();
  await inviteAndAccept(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  await resetRole(db);
  const assignment = await rows(
    db,
    `select revoked_at from public.live_operators where user_id = $1 and place_id = $2`,
    [OPERATOR, PLACE_A],
  );
  assert.equal(assignment.length, 1, "accept created the active assignment");
  assert.equal(assignment[0].revoked_at, null);

  const sid = await startSession(db, OPERATOR, PLACE_A, STAGE_A, "op-key-1");
  await resetRole(db);
  const stored = await rows(
    db,
    `select status, producer_id from public.live_sessions where id = $1`,
    [sid],
  );
  assert.equal(stored[0].status, "live", "a delegated operator started Live");
  assert.equal(
    stored[0].producer_id,
    PRODUCER_A,
    "the session's producer is the granting Producer (live_operators.granted_by), never client input",
  );

  await actAs(db, OPERATOR);
  const ended = await rows(
    db,
    `select public.end_live_session($1::text, $2::text, 'producer_ended', null) as ok`,
    [sid, "op-end-1"],
  );
  assert.equal(ended[0].ok, true, "the delegated operator ended Live");
  await resetRole(db);
  await db.close();
});

test("revoking the invitation denies the operator's very next start AND end", async () => {
  const db = await seedWorld();
  await inviteAndAccept(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  const sid = await startSession(db, OPERATOR, PLACE_A, STAGE_A, "op-key-2");

  // The manager revokes the accepted invitation.
  await resetRole(db);
  const invitation = await rows(
    db,
    `select id from public.live_operator_invitations where place_id = $1 and invited_user_id = $2 and status = 'accepted'`,
    [PLACE_A, OPERATOR],
  );
  await actAs(db, MANAGER);
  await db.query(`select public.revoke_live_operator_invitation($1::uuid)`, [
    String(invitation[0].id),
  ]);
  await resetRole(db);

  const activeNow = await rows(
    db,
    `select 1 from public.live_operators where user_id = $1 and place_id = $2 and revoked_at is null`,
    [OPERATOR, PLACE_A],
  );
  assert.equal(activeNow.length, 0, "revocation cleared the active assignment immediately");

  // The very next END is refused, inside the RPC.
  await actAs(db, OPERATOR);
  await assert.rejects(
    () =>
      db.query(`select public.end_live_session($1::text, $2::text, 'producer_ended', null)`, [
        sid,
        "op-end-2",
      ]),
    /producer_authorization_required/,
    "a revoked operator cannot end Live",
  );
  await resetRole(db);

  // ...and the very next START is refused too.
  await actAs(db, OPERATOR);
  await assert.rejects(
    () =>
      db.query(`select public.start_live_session($1::text, $2::text, $3::text, $4::text)`, [
        PLACE_A,
        STAGE_A,
        "op-key-3",
        "input-op-key-3",
      ]),
    /producer_authorization_required/,
    "a revoked operator cannot start Live",
  );
  await resetRole(db);
  await db.close();
});

test("an operator of Place A cannot start or end Live for Place B", async () => {
  const db = await seedWorld();
  await inviteAndAccept(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  // A live session for PLACE_B, started by its own owner.
  const sidB = await startSession(db, MANAGER_B, PLACE_B, STAGE_B, "mgrb-key-1");

  // The operator of A tries to END B's session.
  await actAs(db, OPERATOR);
  await assert.rejects(
    () =>
      db.query(`select public.end_live_session($1::text, $2::text, 'producer_ended', null)`, [
        sidB,
        "op-end-b",
      ]),
    /producer_authorization_required/,
    "an operator of A cannot end a session of B",
  );
  await resetRole(db);

  // ...and cannot START Live for B either.
  await actAs(db, OPERATOR);
  await assert.rejects(
    () =>
      db.query(`select public.start_live_session($1::text, $2::text, $3::text, $4::text)`, [
        PLACE_B,
        STAGE_B,
        "op-key-b",
        "input-op-key-b",
      ]),
    /producer_authorization_required/,
    "an operator of A cannot start Live for B",
  );
  await resetRole(db);
  await db.close();
});

test("an unrelated account and an editor are refused, inside the RPC", async () => {
  const db = await seedWorld();
  await inviteAndAccept(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  for (const [name, actor] of [
    ["an unrelated authenticated account", OUTSIDER],
    ["an editor of the Place", EDITOR],
  ] as const) {
    await actAs(db, actor);
    await assert.rejects(
      () =>
        db.query(`select public.start_live_session($1::text, $2::text, $3::text, $4::text)`, [
          PLACE_A,
          STAGE_A,
          `key-${name}`,
          `input-${name}`,
        ]),
      /producer_authorization_required/,
      `${name} must be refused`,
    );
    await resetRole(db);
  }

  // Anonymous has no EXECUTE at all — the call cannot even be made.
  await db.exec("set role anon;");
  await assert.rejects(
    () => db.query(`select public.start_live_session($1::text, $2::text, $3::text, $4::text)`, [
      PLACE_A,
      STAGE_A,
      "key-anon",
      "input-anon",
    ]),
    /permission denied|does not exist/i,
    "an unauthenticated caller cannot reach the RPC as a client (anon has no EXECUTE)",
  );
  await db.close();
});

// ---------------------------------------------------------------------------
// Scope guards: 0008 / 0012 untouched; the route keeps using the one helper
// ---------------------------------------------------------------------------

test("0008 and 0012 are untouched: the operator rule lives only in 0049", () => {
  const source0008 = readMigration("0008_live_sessions.sql");
  const source0012 = readMigration("0012_live_end_idempotency.sql");
  const source0049 = readMigration("0049_live_operator_authority.sql");

  for (const [name, source] of [
    ["0008", source0008],
    ["0012", source0012],
  ] as const) {
    assert.equal(
      source.includes("public.live_operators"),
      false,
      `${name} must not be rewritten to know about operator assignments`,
    );
  }

  // 0049 carries the operator branch INSIDE both RPCs.
  assert.match(source0049, /create or replace function public\.start_live_session/);
  assert.match(source0049, /create or replace function public\.end_live_session/);
  assert.equal(
    (source0049.match(/can_operate_live_for_place\(auth\.uid\(\)/g) ?? []).length,
    2,
    "both RPCs authorize through the same SQL predicate",
  );
  assert.match(source0049, /public\.can_operate_live_for_place\(auth\.uid\(\), v_session\.place_id\)/);
  assert.match(source0049, /raise exception 'producer_authorization_required'/);
});

test("the manual DEV access-check script executes end-to-end on a real Postgres engine", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-operator-invitations-access.sql", import.meta.url),
    "utf8",
  )
    // psql meta-commands are client-side; PGlite parses only SQL.
    .split("\n")
    .filter((line) => !/^\s*\\/.test(line))
    .join("\n");

  // The script raises at its final verdict if ANY check failed, so completing
  // without an exception IS "LIVE OPERATOR ACCESS: ALL CHECKS PASSED".
  await db.exec(script);
  await db.close();
});

test("the Live routes keep authorizing through the single server helper", () => {
  const startRoute = readFileSync(
    new URL("../app/api/live/start/route.ts", import.meta.url),
    "utf8",
  );
  const endRoute = readFileSync(new URL("../app/api/live/end/route.ts", import.meta.url), "utf8");
  const helper = readFileSync(
    new URL("../lib/live/operator-authorization.ts", import.meta.url),
    "utf8",
  );

  assert.match(startRoute, /canOperateLiveForPlace/);
  assert.match(endRoute, /canOperateLiveForPlace/);
  assert.match(helper, /export async function canOperateLiveForPlace/);
  assert.match(helper, /\.is\("revoked_at", null\)/);
});
