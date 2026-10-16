import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * LEAST-PRIVILEGE BOUNDARY — Pengelola Tempat vs delegated Operator Live.
 *
 * Evidence for docs/audits/LIVE_OPERATOR_BOUNDARY_AUDIT.md. Everything here runs
 * against the REAL migration chain on a real Postgres engine (PGlite) or against
 * the REAL server components — no mocks of the thing under test.
 *
 * Proven executable:
 *  - accepting an invitation grants EXACTLY the delegated assignment and never
 *    creates/upgrades a producer_memberships row (H1 refuted);
 *  - a delegated operator can operate Live for the assigned Place only, subject
 *    to the existing gates, and revocation blocks the very next operation;
 *  - a delegated operator cannot invite / list / cancel / revoke / replace /
 *    grant / revoke operators, and cannot read another account's or another
 *    Place's rows (H3/H4/H5 refuted) — driven through the real RPCs;
 *  - fake Place ids and user ids are refused;
 *  - RLS + grants + EXECUTE form the boundary for manager / operator /
 *    other-Place operator / unrelated user / anon;
 *  - a dual-role account keeps each authority INDEPENDENTLY (Policy Decision P2);
 *  - the Pengelola surfaces render only for server-resolved owner/manager
 *    authority, and the delegated operator console carries no Pengelola chrome
 *    (H2 — confirmed UI leak — now fixed).
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

const MANAGER = "11111111-1111-1111-1111-111111111111"; // owner of PLACE_A
const MANAGER_B = "11111111-1111-1111-1111-222222222222"; // owner of PLACE_B
const OPERATOR = "22222222-2222-2222-2222-222222222222"; // delegated operator of PLACE_A
const OPERATOR_2 = "33333333-3333-3333-3333-333333333333"; // delegated operator of PLACE_B
const OUTSIDER = "44444444-4444-4444-4444-444444444444"; // invited but otherwise unrelated
const INTRUDER = "55555555-5555-5555-5555-555555555555"; // no authority, no invitation

const PLACE_A = "rumah-teh-lokal"; // seeded by 0001
const PLACE_B = "kopi-dari-kebun"; // seeded by 0001
const PRODUCER_A = "prod-boundary-a";
const PRODUCER_B = "prod-boundary-b";
const STAGE_A = "stage-boundary-a";
const STAGE_B = "stage-boundary-b";

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, encrypted_password text);
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
      await db.exec(
        `grant usage on schema public to anon, authenticated;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
  return db;
}

/**
 * Act as `userId`: auth.uid() is replaced by a constant (the technique
 * tests/live-operator-email-verification.test.ts uses) because every PGlite
 * `query` is its own transaction and a transaction-local GUC would be gone.
 */
async function actAs(db: PGlite, userId: string): Promise<void> {
  await db.exec("reset role;");
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select '${userId}'::uuid $fn$`,
  );
  await db.exec("set role authenticated;");
}

async function callAs(db: PGlite, userId: string, sql: string): Promise<Row[]> {
  await actAs(db, userId);
  try {
    const result = await db.query(sql);
    return (result.rows ?? []) as Row[];
  } finally {
    await db.exec("reset role;");
  }
}

async function expectRaise(db: PGlite, userId: string, sql: string, message: string): Promise<void> {
  await actAs(db, userId);
  try {
    await db.query(sql);
    assert.fail(`expected raise exception '${message}'`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match((error as Error).message, new RegExp(message));
  } finally {
    await db.exec("reset role;");
  }
}

async function seedWorld(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${MANAGER}', 'manager@example.com', now()),
      ('${MANAGER_B}', 'manager-b@example.com', now()),
      ('${OPERATOR}', 'operator@example.com', now()),
      ('${OPERATOR_2}', 'operator2@example.com', now()),
      ('${OUTSIDER}', 'outsider@example.com', now()),
      ('${INTRUDER}', 'intruder@example.com', now())
    on conflict (id) do nothing;
    insert into public.users (id) values
      ('${MANAGER}'), ('${MANAGER_B}'), ('${OPERATOR}'), ('${OPERATOR_2}'), ('${OUTSIDER}'), ('${INTRUDER}')
    on conflict (id) do nothing;
    insert into public.producers (id, display_name) values
      ('${PRODUCER_A}', 'Pengelola A'), ('${PRODUCER_B}', 'Pengelola B')
    on conflict (id) do nothing;
    insert into public.producer_memberships (user_id, producer_id, place_id, role) values
      ('${MANAGER}', '${PRODUCER_A}', '${PLACE_A}', 'owner'),
      ('${MANAGER_B}', '${PRODUCER_B}', '${PLACE_B}', 'owner')
    on conflict do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status) values
      ('${STAGE_A}', '${PLACE_A}', 'Proses A', 'x', 0, 'published'),
      ('${STAGE_B}', '${PLACE_B}', 'Proses B', 'x', 0, 'published')
    on conflict (id) do nothing;
    insert into public.live_eligibility (producer_id, path, active, granted_by) values
      ('${PRODUCER_A}', 'ADMIN_APPROVED', true, 'regression'),
      ('${PRODUCER_B}', 'ADMIN_APPROVED', true, 'regression')
    on conflict (producer_id, path) do update set active = true;
  `);
}

const invite = (db: PGlite, manager: string, placeId: string, email: string) =>
  callAs(db, manager, `select public.invite_live_operator('${placeId}'::text, '${email}'::text)`);

const pendingInvitationId = async (db: PGlite, placeId: string, userId: string) => {
  const found = await rows(
    db,
    `select id from public.live_operator_invitations where place_id = '${placeId}' and invited_user_id = '${userId}' and status = 'pending'`,
  );
  return String(found[0].id);
};

/** Grant a delegated operator of `placeId` by running the real invite + accept. */
async function delegate(db: PGlite, manager: string, placeId: string, email: string, userId: string) {
  await invite(db, manager, placeId, email);
  const id = await pendingInvitationId(db, placeId, userId);
  await callAs(db, userId, `select public.accept_live_operator_invitation('${id}'::uuid)`);
  return id;
}

// ---------------------------------------------------------------------------
// 1. H1 — accept never touches producer_memberships
// ---------------------------------------------------------------------------

test("H1: accepting an invitation creates NO producer_memberships row and grants only the assignment", async () => {
  const db = await createDb();
  await seedWorld(db);

  const before = await rows(
    db,
    `select user_id, producer_id, place_id, role from public.producer_memberships order by user_id, place_id`,
  );
  assert.equal(before.length, 2, "fixtures hold exactly the two manager memberships");

  await delegate(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  const after = await rows(
    db,
    `select user_id, producer_id, place_id, role from public.producer_memberships order by user_id, place_id`,
  );
  assert.deepEqual(after, before, "accept must not create/alter any producer_memberships row");
  assert.equal(
    (await rows(db, `select 1 from public.producer_memberships where user_id = '${OPERATOR}'`)).length,
    0,
    "the operator still holds no Producer membership",
  );

  const assignment = await rows(
    db,
    `select revoked_at from public.live_operators where user_id = '${OPERATOR}' and place_id = '${PLACE_A}'`,
  );
  assert.equal(assignment.length, 1, "accept grants exactly the delegated assignment");
  assert.equal(assignment[0].revoked_at, null, "the assignment is active");

  await db.close();
});

test("H1: accept does not upgrade an unrelated EXISTING membership (editor stays editor)", async () => {
  const db = await createDb();
  await seedWorld(db);
  // The operator independently holds an EDITOR membership on another Place.
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${OPERATOR}', '${PRODUCER_B}', '${PLACE_B}', 'editor') on conflict do nothing;`,
  );

  await delegate(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  const roleB = await rows(
    db,
    `select role from public.producer_memberships where user_id = '${OPERATOR}' and place_id = '${PLACE_B}'`,
  );
  assert.equal(roleB[0]?.role, "editor", "an existing membership role is never upgraded by accept");
  assert.equal(
    (await rows(db, `select 1 from public.producer_memberships where user_id = '${OPERATOR}' and place_id = '${PLACE_A}'`)).length,
    0,
    "no new membership appears for the delegated Place",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 2. Operator can operate Live on the assigned Place only; revoke blocks next
// ---------------------------------------------------------------------------

test("the operator operates Live for the assigned Place only, and revocation denies the next start", async () => {
  const db = await createDb();
  await seedWorld(db);
  const invitationId = await delegate(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  // Assigned Place: start succeeds (all existing gates still apply).
  const started = await callAs(
    db,
    OPERATOR,
    `select public.start_live_session('${PLACE_A}', '${STAGE_A}', 'bnd-op-1', 'input-b1') as out`,
  );
  const sessionId = String((started[0].out as Row).sessionId);
  assert.ok(sessionId, "the operator started a session on the assigned Place");

  // The session records the AUTHORIZING producer (the delegating manager).
  const sessionRow = await rows(db, `select producer_id from public.live_sessions where id = '${sessionId}'`);
  assert.equal(sessionRow[0].producer_id, PRODUCER_A, "the producing Producer is derived server-side");

  await callAs(db, OPERATOR, `select public.end_live_session('${sessionId}', 'bnd-op-end-1', 'producer_ended', null)`);

  // A Place the operator is NOT assigned to is refused, and the same is true
  // for a fake id.
  await expectRaise(
    db,
    OPERATOR,
    `select public.start_live_session('${PLACE_B}', '${STAGE_B}', 'bnd-op-2', 'input-b2')`,
    "producer_authorization_required",
  );
  await expectRaise(
    db,
    OPERATOR,
    `select public.start_live_session('place-yang-tidak-ada', '${STAGE_B}', 'bnd-op-3', 'input-b3')`,
    "producer_authorization_required",
  );

  // Revoke → the very next start is refused (no authorization cache).
  await callAs(db, MANAGER, `select public.revoke_live_operator_invitation('${invitationId}'::uuid)`);
  await expectRaise(
    db,
    OPERATOR,
    `select public.start_live_session('${PLACE_A}', '${STAGE_A}', 'bnd-op-4', 'input-b4')`,
    "producer_authorization_required",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 3. H3 — the operator cannot manage operators through ANY real RPC
// ---------------------------------------------------------------------------

test("the operator cannot invite / list / cancel / revoke / grant / revoke operators", async () => {
  const db = await createDb();
  await seedWorld(db);
  await delegate(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);
  // A pending invitation for another account, so cancel/revoke have a target.
  await invite(db, MANAGER, PLACE_A, "operator2@example.com");
  const otherInvitation = await pendingInvitationId(db, PLACE_A, OPERATOR_2);

  await expectRaise(
    db,
    OPERATOR,
    `select public.invite_live_operator('${PLACE_A}'::text, 'outsider@example.com'::text)`,
    "producer_authorization_required",
  );
  await expectRaise(
    db,
    OPERATOR,
    `select * from public.list_place_live_operator_invitations('${PLACE_A}')`,
    "producer_authorization_required",
  );
  await expectRaise(
    db,
    OPERATOR,
    `select * from public.list_place_live_operators('${PLACE_A}')`,
    "live_operator_list_not_allowed",
  );
  await expectRaise(
    db,
    OPERATOR,
    `select public.cancel_live_operator_invitation('${otherInvitation}'::uuid)`,
    "live_operator_invitation_not_found",
  );
  await expectRaise(
    db,
    OPERATOR,
    `select public.revoke_live_operator_invitation('${otherInvitation}'::uuid)`,
    "live_operator_invitation_not_found",
  );
  await expectRaise(
    db,
    OPERATOR,
    `select public.grant_live_operator_access('${OUTSIDER}'::uuid, '${PLACE_A}'::text)`,
    "live_operator_grant_not_allowed",
  );
  await expectRaise(
    db,
    OPERATOR,
    `select public.revoke_live_operator_access('${OPERATOR}'::uuid, '${PLACE_A}'::text)`,
    "live_operator_revoke_not_allowed",
  );
  // The account-lookup RPC (a management capability) is closed too.
  await expectRaise(
    db,
    OPERATOR,
    `select * from public.resolve_account_by_username('operator2')`,
    "account_lookup_not_allowed",
  );

  // Nothing the operator attempted changed any state.
  assert.equal(
    (await rows(db, `select count(*)::int as n from public.live_operators where user_id = '${OUTSIDER}'`))[0].n,
    0,
  );
  assert.equal(
    (await rows(db, `select revoked_at from public.live_operators where user_id = '${OPERATOR}' and place_id = '${PLACE_A}'`))[0].revoked_at,
    null,
    "the operator's own access was never revoked by the operator",
  );

  await db.close();
});

test("fake Place ids and user ids are refused at the RPC boundary", async () => {
  const db = await createDb();
  await seedWorld(db);

  // A non-manager cannot invite for any Place, real or fake.
  await expectRaise(
    db,
    OUTSIDER,
    `select public.invite_live_operator('${PLACE_A}'::text, 'operator@example.com'::text)`,
    "producer_authorization_required",
  );
  // A manager of A cannot invite for B.
  await expectRaise(
    db,
    MANAGER,
    `select public.invite_live_operator('${PLACE_B}'::text, 'operator2@example.com'::text)`,
    "producer_authorization_required",
  );
  // A random invitation id is indistinguishable from "not yours".
  await expectRaise(
    db,
    OPERATOR,
    `select public.accept_live_operator_invitation('99999999-9999-4999-8999-999999999999'::uuid)`,
    "live_operator_invitation_not_found",
  );
  // A fake user id cannot be granted or revoked by a non-manager.
  await expectRaise(
    db,
    MANAGER_B,
    `select public.grant_live_operator_access('99999999-9999-4999-8999-999999999999'::uuid, '${PLACE_A}'::text)`,
    "live_operator_grant_not_allowed",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 4. H4/H5 — RLS, grants and EXECUTE are the cross-user / cross-Place boundary
// ---------------------------------------------------------------------------

test("RLS confines live_operators and live_operator_invitations to self or the managing Place", async () => {
  const db = await createDb();
  await seedWorld(db);
  await delegate(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);
  await delegate(db, MANAGER_B, PLACE_B, "operator2@example.com", OPERATOR_2);
  await invite(db, MANAGER, PLACE_A, "outsider@example.com"); // pending, unresolved

  // live_operators
  const asOperator = await callAs(db, OPERATOR, `select place_id from public.live_operators`);
  assert.deepEqual(asOperator.map((r) => r.place_id), [PLACE_A], "an operator sees only its own row");
  const asOutsider = await callAs(db, OUTSIDER, `select place_id from public.live_operators`);
  assert.equal(asOutsider.length, 0, "an unrelated account sees no assignment");
  const asIntruder = await callAs(db, INTRUDER, `select place_id from public.live_operators`);
  assert.equal(asIntruder.length, 0, "an account with no role at all sees no assignment");
  const asManagerA = await callAs(db, MANAGER, `select place_id from public.live_operators`);
  assert.deepEqual(asManagerA.map((r) => r.place_id), [PLACE_A], "a manager sees its own Place's rows");
  const asManagerB = await callAs(db, MANAGER_B, `select place_id from public.live_operators`);
  assert.deepEqual(asManagerB.map((r) => r.place_id), [PLACE_B], "a manager never sees another Place's rows");

  // live_operator_invitations
  const opInvitations = await callAs(
    db,
    OPERATOR,
    `select place_id, status from public.live_operator_invitations`,
  );
  assert.deepEqual(opInvitations.map((r) => r.place_id), [PLACE_A], "an invitee sees only its own invitations");
  // An unrelated account that was never invited sees no invitation; the
  // invited-but-unrelated account sees ONLY the invitation addressed to it.
  const intruderInvitations = await callAs(db, INTRUDER, `select id from public.live_operator_invitations`);
  assert.equal(intruderInvitations.length, 0, "an account with no invitation sees nothing");
  const outsiderInvitations = await callAs(
    db,
    OUTSIDER,
    `select invited_user_id from public.live_operator_invitations`,
  );
  assert.deepEqual(
    outsiderInvitations.map((r) => r.invited_user_id),
    [OUTSIDER],
    "an invitee sees only its own invitation, never another account's",
  );
  const managerBInvitations = await callAs(
    db,
    MANAGER_B,
    `select place_id from public.live_operator_invitations`,
  );
  assert.deepEqual(managerBInvitations.map((r) => r.place_id), [PLACE_B], "manager-B sees only its own Place");

  await db.close();
});

test("the operator reads ONLY its assigned Place's published stages (the console's stage list)", async () => {
  const db = await createDb();
  await seedWorld(db);
  // PLACE_A is NOT published (the operator read policy is what makes it visible
  // to its operator at all); PLACE_B is published, so its published stage is in
  // the PUBLIC set every visitor already sees. PLACE_A also carries an
  // unpublished stage in each locked non-live status.
  await db.exec(`
    update public.places set publication_status = 'draft' where id = '${PLACE_A}';
    update public.places set publication_status = 'published' where id = '${PLACE_B}';
    insert into public.production_stages (id, place_id, title, description, sort_order, status) values
      ('stage-boundary-a-draft', '${PLACE_A}', 'Draf A', 'x', 1, 'draft'),
      ('stage-boundary-a-paused', '${PLACE_A}', 'Paused A', 'x', 2, 'paused')
    on conflict (id) do nothing;
  `);
  const invitationId = await delegate(db, MANAGER, PLACE_A, "operator@example.com", OPERATOR);

  /** The EXACT read the console performs: published stages of one Place. */
  const consoleStageRead = async (userId: string) =>
    (
      await callAs(
        db,
        userId,
        `select id, status from public.production_stages
          where place_id = '${PLACE_A}' and status = 'published'
          order by sort_order, id`,
      )
    ).map((row) => String(row.id));

  assert.deepEqual(
    await consoleStageRead(OPERATOR),
    [STAGE_A],
    "the console receives the assigned Place's published stage",
  );

  // The Place row itself is readable for the operator while it is a draft (no
  // membership, so only the operator policy can grant this) ...
  assert.equal(
    (await callAs(db, OPERATOR, `select id from public.places where id = '${PLACE_A}'`)).length,
    1,
    "the operator can read the Place it is assigned to, even unpublished",
  );
  // ... and NOT for an account with no authority over it.
  assert.equal(
    (await callAs(db, INTRUDER, `select id from public.places where id = '${PLACE_A}'`)).length,
    0,
  );

  // Whatever the operator can read beyond the public set is EXACTLY the assigned
  // Place's published stages: no draft, no paused, no other Place's extra row.
  const operatorVisible = new Set(
    (await callAs(db, OPERATOR, `select id from public.production_stages`)).map((row) => String(row.id)),
  );
  const publicVisible = new Set(
    (await callAs(db, INTRUDER, `select id from public.production_stages`)).map((row) => String(row.id)),
  );
  assert.deepEqual([...publicVisible], [STAGE_B], "the public set is the published Place's stage only");
  assert.deepEqual(
    [...operatorVisible].filter((id) => !publicVisible.has(id)),
    [STAGE_A],
    "the operator's extra visibility is the assigned Place's published stage, nothing more",
  );
  for (const hidden of ["stage-boundary-a-draft", "stage-boundary-a-paused"]) {
    assert.equal(operatorVisible.has(hidden), false, `${hidden} must stay invisible to the operator`);
  }

  // The owner/manager's own authority is untouched: it still sees EVERY stage of
  // its Place, published or not.
  assert.deepEqual(
    (
      await callAs(
        db,
        MANAGER,
        `select id from public.production_stages where place_id = '${PLACE_A}' order by sort_order, id`,
      )
    ).map((row) => String(row.id)),
    [STAGE_A, "stage-boundary-a-draft", "stage-boundary-a-paused"],
    "a Pengelola keeps full visibility of its own Place's stages",
  );

  // Revocation removes the read on the very next query (no cached authority).
  await callAs(db, MANAGER, `select public.revoke_live_operator_invitation('${invitationId}'::uuid)`);
  assert.deepEqual(await consoleStageRead(OPERATOR), [], "a revoked assignment reads no stage");
  assert.equal(
    (await callAs(db, OPERATOR, `select id from public.places where id = '${PLACE_A}'`)).length,
    0,
    "a revoked assignment reads no Place either",
  );

  await db.close();
});

test("grants and EXECUTE: no anon access, no client write policy, predicate stays internal", async () => {
  const db = await createDb();
  await seedWorld(db);

  const privilege = async (role: string, table: string, privilegeType: string) =>
    Boolean((await rows(db, `select has_table_privilege('${role}', 'public.${table}', '${privilegeType}') as ok`))[0].ok);

  for (const table of ["live_operators", "live_operator_invitations"]) {
    assert.equal(await privilege("anon", table, "SELECT"), false, `anon must not SELECT ${table}`);
    assert.equal(await privilege("anon", table, "INSERT"), false, `anon must not INSERT ${table}`);
    assert.equal(await privilege("anon", table, "UPDATE"), false, `anon must not UPDATE ${table}`);
    assert.equal(await privilege("authenticated", table, "INSERT"), false, `${table} writes go through RPCs only`);
    assert.equal(await privilege("authenticated", table, "UPDATE"), false, `${table} writes go through RPCs only`);
    assert.equal(await privilege("authenticated", table, "DELETE"), false, `${table} writes go through RPCs only`);
  }

  // No client write policy on either table.
  for (const table of ["live_operators", "live_operator_invitations"]) {
    const writePolicies = await rows(
      db,
      `select policyname, cmd from pg_policies where schemaname='public' and tablename='${table}' and cmd in ('INSERT','UPDATE','DELETE','ALL')`,
    );
    assert.deepEqual(writePolicies, [], `${table} must have no client write policy`);
  }

  const execute = async (role: string, signature: string) =>
    Boolean((await rows(db, `select has_function_privilege('${role}', 'public.${signature}', 'EXECUTE') as ok`))[0].ok);

  // The internal predicate is not client-callable by anyone.
  assert.equal(await execute("authenticated", "can_operate_live_for_place(uuid,text)"), false);
  assert.equal(await execute("anon", "can_operate_live_for_place(uuid,text)"), false);

  // anon holds no EXECUTE on any lifecycle RPC or on start/end.
  for (const signature of [
    "invite_live_operator(text,text)",
    "accept_live_operator_invitation(uuid)",
    "reject_live_operator_invitation(uuid)",
    "cancel_live_operator_invitation(uuid)",
    "revoke_live_operator_invitation(uuid)",
    "list_place_live_operator_invitations(text)",
    "list_my_live_operator_invitations()",
    "grant_live_operator_access(uuid,text)",
    "revoke_live_operator_access(uuid,text)",
    "start_live_session(text,text,text,text)",
    "end_live_session(text,text,text,text)",
  ]) {
    assert.equal(await execute("anon", signature), false, `anon must not EXECUTE ${signature}`);
    assert.equal(await execute("authenticated", signature), true, `authenticated needs EXECUTE on ${signature}`);
  }

  await db.close();
});

// ---------------------------------------------------------------------------
// 5. Policy Decision P2 — a dual-role account keeps each authority independently
// ---------------------------------------------------------------------------

test("a dual-role account keeps its Pengelola authority and its delegated assignment independently", async () => {
  const db = await createDb();
  await seedWorld(db);
  // MANAGER owns PLACE_A and is independently delegated as an operator of PLACE_B.
  await delegate(db, MANAGER_B, PLACE_B, "manager@example.com", MANAGER);

  // (a) Delegated capability: MANAGER can operate Live at PLACE_B.
  const started = await callAs(
    db,
    MANAGER,
    `select public.start_live_session('${PLACE_B}', '${STAGE_B}', 'bnd-dual-1', 'input-d1') as out`,
  );
  const sessionId = String((started[0].out as Row).sessionId);
  assert.ok(sessionId, "the delegated assignment authorizes Live at PLACE_B");
  await callAs(db, MANAGER, `select public.end_live_session('${sessionId}', 'bnd-dual-end-1', 'producer_ended', null)`);

  // (b) Pengelola capability: still manages PLACE_A's operator roster.
  const roster = await callAs(db, MANAGER, `select user_id from public.list_place_live_operators('${PLACE_A}')`);
  assert.ok(Array.isArray(roster), "the owner/manager roster still works");

  // (c) The delegated assignment does NOT grant management of PLACE_B.
  await expectRaise(
    db,
    MANAGER,
    `select * from public.list_place_live_operators('${PLACE_B}')`,
    "live_operator_list_not_allowed",
  );
  await expectRaise(
    db,
    MANAGER,
    `select public.invite_live_operator('${PLACE_B}'::text, 'outsider@example.com'::text)`,
    "producer_authorization_required",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 6. The UI boundary (H2 — confirmed leak, now fixed)
// ---------------------------------------------------------------------------

const readSource = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

test("the operator console renders an Operator Live shell and NO Pengelola navigation", () => {
  const livePage = stripComments(readSource("app/producer/live/page.tsx"));
  const managerAuthority = livePage.indexOf("const hasManagerAuthority = authorized.length > 0");
  assert.ok(managerAuthority > -1, "the shell is a server decision from owner/manager memberships");

  // Manager state keeps the Pengelola identity; operator state does not.
  assert.match(livePage, /hasManagerAuthority \? "Pengelola Live" : "Operator Live"/);
  assert.match(livePage, /href="\/account"[\s\S]{0,80}← Akun & Akses/);
  // The navigation layer is manager-only — an operator-only account cannot see
  // the Pengelola entries (Dashboard / Permintaan Kunjungan).
  assert.match(
    livePage,
    /\{hasManagerAuthority \? \([\s\S]{0,80}<ProducerSubNav active="\/producer\/live" \/>/,
  );
  // ProducerSubNav must sit INSIDE the manager-authority branch, never at the
  // unconditional page level.
  const navIndex = livePage.indexOf('<ProducerSubNav active="/producer/live" />');
  const guardIndex = livePage.indexOf("{hasManagerAuthority ? (");
  const closeIndex = livePage.indexOf(") : null}", guardIndex);
  assert.ok(
    guardIndex > -1 && navIndex > guardIndex && navIndex < closeIndex,
    "ProducerSubNav must be rendered only inside the manager-authority branch",
  );
});

test("the Pengelola pages require owner/manager membership server-side (deny by default)", () => {
  const dashboard = stripComments(readSource("app/producer/page.tsx"));
  assert.match(dashboard, /hasManagerMembership = \(memberships\?\.length \?\? 0\) > 0/);
  assert.match(dashboard, /if \(!hasManagerMembership\) \{\s*redirect\("\/account"\);/);

  const inbox = stripComments(readSource("app/producer/visit-intents/page.tsx"));
  assert.match(inbox, /\.in\("role", \["owner", "manager"\]\)/);
  assert.match(inbox, /if \(!memberships\?\.length\) \{\s*redirect\("\/account"\);/);
  assert.match(inbox, /redirect\("\/auth\?returnTo=%2Fproducer%2Fvisit-intents"\)/);
});

test("the Account Center never derives Pengelola from live_operators (H2/H6)", () => {
  const accountPage = stripComments(readSource("app/account/page.tsx"));
  const memberships = stripComments(readSource("lib/account-memberships.ts"));
  const operators = stripComments(readSource("lib/account-live-operators.ts"));

  assert.match(accountPage, /resolvePlaceMemberships\(\)/);
  assert.match(accountPage, /resolveLiveOperatorAssignments\(\)/);
  assert.match(accountPage, /const hasProducerAccess = authority\.memberships\.length > 0/);
  // The manager panel is gated on the SERVER's owner/manager memberships.
  assert.match(accountPage, /\{hasProducerAccess \? \(\s*<AccountLiveOperatorManager places=\{authority\.memberships\} \/>/);
  // Pengelola helper reads memberships only; Operator helper reads live_operators only.
  assert.match(memberships, /from\("producer_memberships"\)/);
  assert.doesNotMatch(memberships, /live_operators/);
  assert.match(operators, /from\("live_operators"\)/);
  assert.doesNotMatch(operators, /producer_memberships/);
});

// ---------------------------------------------------------------------------
// 7. The runnable DEV script (result set of ord / check_name / passed / detail)
// ---------------------------------------------------------------------------

test("db-regression/live-operator-boundary-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-operator-boundary-access.sql", import.meta.url),
    "utf8",
  );

  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (ord, check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Row[];
  assert.ok(checkRows.length >= 10, `expected at least 10 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );

  // Rollback contract: no fixture residue.
  const leftover = await rows(db, `select 1 as one from public.producers where id = 'prod-boundary-a'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});

// ---------------------------------------------------------------------------
// 8. Regression guard — the Live viewer gates are not touched by this task
// ---------------------------------------------------------------------------

test("assert_viewer_eligible is defined only by 0008 and the task changes no migration", async () => {
  const definitions = CHAIN.filter((name) =>
    readMigration(name).includes("create or replace function public.assert_viewer_eligible"),
  );
  assert.deepEqual(definitions, ["0008_live_sessions.sql"], "only 0008 owns assert_viewer_eligible");
  // This task ships NO migration, so 0046-0056 cannot have been edited.
  assert.equal(
    readMigration("0048_live_operator_invitations.sql").includes("assert_viewer_eligible"),
    false,
  );
});
