import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0048 — LIVE OPERATOR INVITATION LIFECYCLE.
 *
 * Applies the real migration chain on Postgres (PGlite), then drives the real
 * server RPCs and asserts the LOCKED rules:
 * - invite by REGISTERED EMAIL, uniform response (no enumeration), no account
 *   creation, one pending per (Place, user);
 * - pending → accepted → revoked, pending → rejected/cancelled/expired; every
 *   other transition rejected by the DATABASE guard;
 * - accepting grants the public.live_operators assignment (granted_by derived);
 * - revoking withdraws that access immediately AND (replacement) a previous
 *   active operator is revoked in the same transaction when a new one accepts;
 * - at most one ACTIVE operator per Place (partial unique index);
 * - only the Place's owner/manager can invite/cancel/revoke, only the invitee can
 *   accept/reject, and a manager of Place A cannot act on Place B;
 * - notifications reuse the existing infrastructure (0025/0026/0029).
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

const MIGRATIONS = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
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
];

const MANAGER = "11111111-1111-1111-1111-111111111111";
const MANAGER_B = "11111111-1111-1111-1111-222222222222";
const OPERATOR = "22222222-2222-2222-2222-222222222222";
const OPERATOR_2 = "33333333-3333-3333-3333-333333333333";
const OUTSIDER = "44444444-4444-4444-4444-444444444444";

const PLACE_A = "rumah-teh-lokal"; // seeded by 0001
const PLACE_A_NAME = "Rumah Teh Lokal";
const PLACE_B = "kopi-dari-kebun"; // seeded by 0001
const PRODUCER_A = "prod-a";
const PRODUCER_B = "prod-b";

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(apply0048 = true): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
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
  const list = apply0048 ? MIGRATIONS : MIGRATIONS.slice(0, -1);
  const pre47 = list.filter((name) => !/^004[78]_/.test(name));
  const post47 = list.filter((name) => /^004[78]_/.test(name));
  for (const name of pre47) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  // Emulate Supabase's default schema/table privileges (RLS is what actually
  // decides) BEFORE 0047/0048, exactly as the account-center harness does — so
  // the policies under test are the thing that gates, and a missing grant shows
  // up as permission denied. 0047/0048 then tighten their own tables.
  await db.exec(
    `grant usage on schema public to anon, authenticated;
     grant all on all tables in schema public to anon, authenticated;
     grant usage, select on all sequences in schema public to anon, authenticated;`,
  );
  for (const name of post47) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  return db;
}

async function actAsActor(db: PGlite, userId: string | null): Promise<void> {
  await db.exec("reset role;");
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select ${
      userId ? `'${userId}'::uuid` : "null::uuid"
    } $fn$`,
  );
}

async function actAs(db: PGlite, userId: string | null): Promise<void> {
  await actAsActor(db, userId);
  await db.exec("set role authenticated;");
}

async function seedUser(db: PGlite, userId: string, email: string): Promise<void> {
  await db.exec(
    `insert into auth.users (id, email, email_confirmed_at) values ('${userId}', '${email}', now()) on conflict do nothing`,
  );
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing`);
}

async function seedManager(db: PGlite, userId: string, producerId: string, placeId: string): Promise<void> {
  await db.exec(
    `insert into public.producers (id, display_name) values ('${producerId}', 'Pengelola ${producerId}') on conflict do nothing`,
  );
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${userId}', '${producerId}', '${placeId}', 'owner') on conflict do nothing`,
  );
}

async function seedWorld(): Promise<PGlite> {
  const db = await createDb();
  await seedUser(db, MANAGER, "manager@example.com");
  await seedUser(db, MANAGER_B, "manager-b@example.com");
  await seedUser(db, OPERATOR, "operator@example.com");
  await seedUser(db, OPERATOR_2, "operator2@example.com");
  await seedUser(db, OUTSIDER, "outsider@example.com");
  await seedManager(db, MANAGER, PRODUCER_A, PLACE_A);
  await seedManager(db, MANAGER_B, PRODUCER_B, PLACE_B);
  return db;
}

async function invite(
  db: PGlite,
  placeId: string,
  email: string,
): Promise<void> {
  await db.query(`select public.invite_live_operator($1::text, $2::text)`, [placeId, email]);
}

async function invitationId(db: PGlite, placeId: string, userId: string): Promise<string> {
  await actAsActor(db, MANAGER);
  const found = await rows(
    db,
    `select id from public.live_operator_invitations where place_id = '${placeId}' and invited_user_id = '${userId}' and status = 'pending'`,
  );
  return String(found[0].id);
}

const notifications = (db: PGlite, userId?: string) =>
  rows(
    db,
    `select user_id, category, event_type, title, body, place_id, source_type, source_id from public.notifications${
      userId ? ` where user_id = '${userId}'` : ""
    } order by created_at, event_type`,
  );

const liveOperators = (db: PGlite) =>
  rows(db, `select user_id, place_id, granted_by, revoked_at from public.live_operators order by user_id`);

// ---------------------------------------------------------------------------
// A. Shape, grants, RLS
// ---------------------------------------------------------------------------

test("0048 applies cleanly and is idempotent; no grant reaches anon", async () => {
  const db = await createDb();
  // Re-apply the whole file (SQL-Editor whole-file paste) — must be a no-op.
  await db.exec(stripPgcrypto(readMigration("0048_live_operator_invitations.sql")));

  const table = await rows(
    db,
    `select rowsecurity from pg_tables where schemaname='public' and tablename='live_operator_invitations'`,
  );
  assert.equal(table.length, 1, "the invitations table must exist");
  assert.equal(table[0]?.rowsecurity, true, "RLS must be enabled");

  const policies = await rows(
    db,
    `select policyname, cmd from pg_policies where schemaname='public' and tablename='live_operator_invitations' order by 1`,
  );
  assert.deepEqual(
    policies.map((row) => `${row.policyname}:${row.cmd}`),
    [
      "live_operator_invitations_invitee_read:SELECT",
      "live_operator_invitations_manager_read:SELECT",
    ],
    "exactly two read policies, no direct write policy",
  );

  const grants = await rows(
    db,
    `select grantee, privilege_type from information_schema.role_table_grants
     where table_schema='public' and table_name='live_operator_invitations' and grantee in ('anon','authenticated') order by 1,2`,
  );
  assert.deepEqual(
    grants.map((row) => `${row.grantee}:${row.privilege_type}`),
    ["authenticated:SELECT"],
    "authenticated gets SELECT only; anon gets nothing",
  );

  const pendingIdx = await rows(
    db,
    `select indexdef from pg_indexes where schemaname='public' and indexname='live_operator_invitations_pending_unique_idx'`,
  );
  assert.match(String(pendingIdx[0]?.indexdef), /unique/i);
  assert.match(String(pendingIdx[0]?.indexdef), /status = 'pending'/i);

  const activeIdx = await rows(
    db,
    `select indexdef from pg_indexes where schemaname='public' and indexname='live_operators_one_active_per_place_idx'`,
  );
  assert.match(String(activeIdx[0]?.indexdef), /unique/i);
  assert.match(String(activeIdx[0]?.indexdef), /revoked_at is null/i);

  // The email-enumeration RPC must not be exposed (no direct email lookup RPC).
  const lookup = await rows(db, `select proname from pg_proc where proname = 'resolve_account_by_email'`);
  assert.equal(lookup.length, 0, "no email→account RPC may be exposed to clients");

  await db.close();
});

test("the lifecycle RPCs exist and are authenticated-only (public/anon denied)", async () => {
  const db = await createDb();
  const fns = [
    "invite_live_operator",
    "accept_live_operator_invitation",
    "reject_live_operator_invitation",
    "cancel_live_operator_invitation",
    "revoke_live_operator_invitation",
    "list_place_live_operator_invitations",
    "list_my_live_operator_invitations",
  ];
  for (const fn of fns) {
    const grantees = await rows(
      db,
      `select r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
       aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a join pg_roles r on r.oid=a.grantee
       where n.nspname='public' and p.proname='${fn}' and a.privilege_type='EXECUTE' order by 1`,
    );
    const names = grantees.map((row) => String(row.rolname));
    assert.ok(names.includes("authenticated"), `${fn}: authenticated must hold EXECUTE`);
    assert.ok(
      !names.includes("public") && !names.includes("anon"),
      `${fn}: public/anon must not hold EXECUTE`,
    );
  }
  await db.close();
});

// ---------------------------------------------------------------------------
// B. Invite — email lookup, uniform response, privacy
// ---------------------------------------------------------------------------

test("invite resolves a registered EMAIL and creates ONE pending invitation + notification", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");

  await actAsActor(db, MANAGER);
  const created = await rows(db, `select place_id, invited_user_id, invited_email, status from public.live_operator_invitations`);
  assert.equal(created.length, 1);
  assert.equal(created[0].invited_user_id, OPERATOR);
  assert.equal(created[0].invited_email, "operator@example.com");
  assert.equal(created[0].status, "pending");

  const notes = await notifications(db, OPERATOR);
  assert.equal(notes.length, 1, "exactly one pending notification for the invitee");
  assert.equal(String(notes[0].category), "safety_account");
  assert.equal(String(notes[0].event_type), "live_operator_invitation_pending");
  assert.match(String(notes[0].body), /Rumah Teh Lokal/);
  assert.match(String(notes[0].body), /Pengelola prod-a/);

  await db.close();
});

test("invite answers uniformly for an UNKNOWN email (no row, no disclosure, no account)", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  // Unknown email → the RPC returns void with no error, exactly like a hit.
  await invite(db, PLACE_A, "nobody@example.com");

  await actAsActor(db, MANAGER);
  const all = await rows(db, `select count(*)::int as n from public.live_operator_invitations`);
  assert.equal(all[0].n, 0, "no invitation row is written for an unknown email");
  const users = await rows(db, `select count(*)::int as n from public.users`);
  assert.equal(users[0].n, 5, "no account is ever created by an invite");
  await db.close();
});

test("a second invitation to the same (Place, user) while pending is absorbed", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  await invite(db, PLACE_A, "operator@example.com");
  await actAsActor(db, MANAGER);
  const count = await rows(db, `select count(*)::int as n from public.live_operator_invitations`);
  assert.equal(count[0].n, 1, "one pending invitation per (Place, user)");
  await db.close();
});

test("a manager cannot invite themself, and a non-manager cannot invite", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await assert.rejects(
    () => invite(db, PLACE_A, "manager@example.com"),
    /live_operator_invite_self_not_allowed/,
    "self-invite is rejected",
  );

  await actAs(db, OUTSIDER);
  await assert.rejects(
    () => invite(db, PLACE_A, "operator@example.com"),
    /producer_authorization_required/,
    "a user with no Place authority cannot invite",
  );
  await db.close();
});

test("the same account cannot be invited twice from two Places it does not manage", async () => {
  const db = await seedWorld();
  // MANAGER_B manages PLACE_B; inviting OPERATOR there is fine and scoped.
  await actAs(db, MANAGER_B);
  await invite(db, PLACE_B, "operator@example.com");
  await actAsActor(db, MANAGER_B);
  const created = await rows(db, `select place_id from public.live_operator_invitations`);
  assert.deepEqual(created.map((r) => r.place_id), [PLACE_B]);
  await db.close();
});

// ---------------------------------------------------------------------------
// C. Accept → assignment + replacement
// ---------------------------------------------------------------------------

test("only the invitee can accept; accepting grants the assignment with granted_by derived", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const id = await invitationId(db, PLACE_A, OPERATOR);

  // An unrelated account cannot accept someone else's invitation.
  await actAs(db, OUTSIDER);
  await assert.rejects(
    () => db.query(`select public.accept_live_operator_invitation($1::uuid)`, [id]),
    /live_operator_invitation_not_found/,
  );

  await actAs(db, OPERATOR);
  await db.query(`select public.accept_live_operator_invitation($1::uuid)`, [id]);

  await actAsActor(db, MANAGER);
  const status = await rows(db, `select status from public.live_operator_invitations where id = '${id}'`);
  assert.equal(status[0].status, "accepted");
  const ops = await liveOperators(db);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].user_id, OPERATOR);
  assert.equal(ops[0].place_id, PLACE_A);
  assert.equal(ops[0].granted_by, PRODUCER_A, "granted_by is the granting manager's Producer");
  assert.equal(ops[0].revoked_at, null);

  const notes = await notifications(db, MANAGER);
  assert.ok(notes.some((n) => n.event_type === "live_operator_invitation_accepted"));
  await db.close();
});

test("a new operator's acceptance replaces the previous active operator in one transaction", async () => {
  const db = await seedWorld();
  // OPERATOR becomes active.
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const first = await invitationId(db, PLACE_A, OPERATOR);
  await actAs(db, OPERATOR);
  await db.query(`select public.accept_live_operator_invitation($1::uuid)`, [first]);

  // OPERATOR_2 is invited and accepts.
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator2@example.com");
  const second = await invitationId(db, PLACE_A, OPERATOR_2);
  await actAs(db, OPERATOR_2);
  await db.query(`select public.accept_live_operator_invitation($1::uuid)`, [second]);

  await actAsActor(db, MANAGER);
  const active = await rows(
    db,
    `select user_id from public.live_operators where place_id='${PLACE_A}' and revoked_at is null`,
  );
  assert.deepEqual(active.map((r) => r.user_id), [OPERATOR_2], "exactly one ACTIVE operator remains");
  const all = await liveOperators(db);
  assert.equal(all.length, 2, "the previous assignment is kept as revoked history");
  const revoked = all.find((r) => r.user_id === OPERATOR);
  assert.notEqual(revoked?.revoked_at, null, "the previous operator is revoked");

  const priorInvitation = await rows(
    db,
    `select status from public.live_operator_invitations where id = '${first}'`,
  );
  assert.equal(priorInvitation[0].status, "revoked", "the previous invitation is marked revoked");
  await db.close();
});

test("the database refuses a second ACTIVE operator for the same Place", async () => {
  const db = await seedWorld();
  await actAsActor(db, MANAGER);
  await db.exec(
    `insert into public.live_operators (user_id, place_id, granted_by) values ('${OPERATOR}', '${PLACE_A}', '${PRODUCER_A}')`,
  );
  await assert.rejects(
    () =>
      db.query(
        `insert into public.live_operators (user_id, place_id, granted_by) values ('${OPERATOR_2}', '${PLACE_A}', '${PRODUCER_A}')`,
      ),
    /duplicate key|unique/i,
    "the partial unique index enforces max one active operator per Place",
  );
  await db.close();
});

// ---------------------------------------------------------------------------
// D. Reject / cancel / revoke / invalid transitions
// ---------------------------------------------------------------------------

test("the invitee can reject a pending invitation", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const id = await invitationId(db, PLACE_A, OPERATOR);
  await actAs(db, OPERATOR);
  await db.query(`select public.reject_live_operator_invitation($1::uuid)`, [id]);
  await actAsActor(db, MANAGER);
  const row = await rows(db, `select status from public.live_operator_invitations where id='${id}'`);
  assert.equal(row[0].status, "rejected");
  assert.ok((await notifications(db, MANAGER)).some((n) => n.event_type === "live_operator_invitation_rejected"));
  await db.close();
});

test("a manager can cancel a pending invitation; the invitee cannot cancel", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const id = await invitationId(db, PLACE_A, OPERATOR);

  // The invitee is not a manager of the Place.
  await actAs(db, OPERATOR);
  await assert.rejects(
    () => db.query(`select public.cancel_live_operator_invitation($1::uuid)`, [id]),
    /live_operator_invitation_not_found/,
  );

  await actAs(db, MANAGER);
  await db.query(`select public.cancel_live_operator_invitation($1::uuid)`, [id]);
  await actAsActor(db, MANAGER);
  const row = await rows(db, `select status from public.live_operator_invitations where id='${id}'`);
  assert.equal(row[0].status, "cancelled");
  assert.ok((await notifications(db, OPERATOR)).some((n) => n.event_type === "live_operator_invitation_cancelled"));
  await db.close();
});

test("revoking an ACCEPTED invitation removes the access immediately; a manager of another Place cannot", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const id = await invitationId(db, PLACE_A, OPERATOR);
  await actAs(db, OPERATOR);
  await db.query(`select public.accept_live_operator_invitation($1::uuid)`, [id]);

  // A manager of a DIFFERENT Place cannot revoke this invitation.
  await actAs(db, MANAGER_B);
  await assert.rejects(
    () => db.query(`select public.revoke_live_operator_invitation($1::uuid)`, [id]),
    /live_operator_invitation_not_found/,
  );

  await actAs(db, MANAGER);
  await db.query(`select public.revoke_live_operator_invitation($1::uuid)`, [id]);

  await actAsActor(db, MANAGER);
  const row = await rows(db, `select status from public.live_operator_invitations where id='${id}'`);
  assert.equal(row[0].status, "revoked");
  const ops = await liveOperators(db);
  assert.equal(ops.length, 1);
  assert.notEqual(ops[0].revoked_at, null, "access is withdrawn immediately");
  assert.ok((await notifications(db, OPERATOR)).some((n) => n.event_type === "live_operator_invitation_revoked"));
  await db.close();
});

test("the DB guard rejects every transition the state machine does not allow", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const id = await invitationId(db, PLACE_A, OPERATOR);
  await actAsActor(db, MANAGER);

  // pending → revoked is not a legal transition (only cancel/accept/reject/expire).
  await assert.rejects(
    () => db.query(`update public.live_operator_invitations set status='revoked' where id='${id}'`),
    /live_operator_invitation_invalid/,
  );
  // pending → accepted → cancelled is not legal (accepted may only be revoked).
  await db.query(`update public.live_operator_invitations set status='accepted' where id='${id}'`);
  await assert.rejects(
    () => db.query(`update public.live_operator_invitations set status='cancelled' where id='${id}'`),
    /live_operator_invitation_invalid/,
  );
  // Identity columns are frozen.
  await assert.rejects(
    () => db.query(`update public.live_operator_invitations set place_id='${PLACE_B}' where id='${id}'`),
    /live_operator_invitation_invalid/,
  );
  await db.close();
});

// ---------------------------------------------------------------------------
// E. Expiry
// ---------------------------------------------------------------------------

test("a pending invitation past its expiry is expired and the invitee notified", async () => {
  const db = await seedWorld();

  // Seed an ALREADY-EXPIRED pending invitation directly (expires_at is
  // immutable through the API by design; a real one simply ages).
  await actAsActor(db, MANAGER);
  const inserted = await rows(
    db,
    `insert into public.live_operator_invitations
       (place_id, invited_user_id, invited_email, invited_by_user_id, invited_by_producer_id, status, created_at, expires_at)
     values ('${PLACE_A}', '${OPERATOR}', 'operator@example.com', '${MANAGER}', '${PRODUCER_A}', 'pending', now() - interval '2 days', now() - interval '1 day')
     returning id`,
  );
  const id = String(inserted[0].id);

  // Accepting a LAPSED pending invitation fails closed as `expired` (the RPC
  // expires it lazily and refuses), and the invitee is notified.
  await actAs(db, OPERATOR);
  await assert.rejects(
    () => db.query(`select public.accept_live_operator_invitation($1::uuid)`, [id]),
    /live_operator_invitation_expired/,
  );

  // The lazy sweep on the manager list reports it as expired.
  await actAs(db, MANAGER);
  const listed = await rows(db, `select status from public.list_place_live_operator_invitations('${PLACE_A}')`);
  assert.deepEqual(listed.map((r) => r.status), ["expired"]);

  await actAsActor(db, MANAGER);
  assert.ok((await notifications(db, OPERATOR)).some((n) => n.event_type === "live_operator_invitation_expired"));
  await db.close();
});

// ---------------------------------------------------------------------------
// F. Listing + notifications shape
// ---------------------------------------------------------------------------

test("manager listing is scoped to the caller's Place; invitee listing carries place and manager names", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");

  // A manager of another Place cannot list this Place's invitations.
  await actAs(db, MANAGER_B);
  await assert.rejects(
    () => db.query(`select * from public.list_place_live_operator_invitations('${PLACE_A}')`),
    /producer_authorization_required/,
  );

  await actAs(db, MANAGER);
  const managerRows = await rows(db, `select place_name, invited_email, status from public.list_place_live_operator_invitations('${PLACE_A}')`);
  assert.equal(managerRows.length, 1);
  assert.equal(managerRows[0].place_name, PLACE_A_NAME);
  assert.equal(managerRows[0].status, "pending");

  await actAs(db, OPERATOR);
  const inviteeRows = await rows(db, `select place_name, invited_by_name, status from public.list_my_live_operator_invitations()`);
  assert.equal(inviteeRows.length, 1);
  assert.equal(inviteeRows[0].place_name, PLACE_A_NAME);
  assert.equal(inviteeRows[0].invited_by_name, "Pengelola prod-a");

  // A different account sees none of it.
  await actAs(db, OUTSIDER);
  const none = await rows(db, `select id from public.list_my_live_operator_invitations()`);
  assert.equal(none.length, 0);
  await db.close();
});

test("the exact Live authorization predicate is denied immediately after revoke (no cache)", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const id = await invitationId(db, PLACE_A, OPERATOR);
  await actAs(db, OPERATOR);
  await db.query(`select public.accept_live_operator_invitation($1::uuid)`, [id]);

  // This is exactly the query lib/live/operator-authorization.ts runs on every
  // Live start/end: an ACTIVE assignment for the EXACT Place, as the session.
  const allowed = async (placeId: string) =>
    (
      await rows(
        db,
        `select 1 from public.live_operators where user_id = auth.uid() and place_id = '${placeId}' and revoked_at is null`,
      )
    ).length > 0;

  await actAs(db, OPERATOR);
  assert.equal(await allowed(PLACE_A), true, "the active operator may operate the assigned Place");
  assert.equal(await allowed(PLACE_B), false, "and no other Place");

  await actAs(db, MANAGER);
  await db.query(`select public.revoke_live_operator_invitation($1::uuid)`, [id]);

  await actAs(db, OPERATOR);
  assert.equal(
    await allowed(PLACE_A),
    false,
    "revocation takes effect on the very next authorization read (no cache)",
  );
  await db.close();
});

test("notifications never duplicate for the same invitation event", async () => {
  const db = await seedWorld();
  await actAs(db, MANAGER);
  await invite(db, PLACE_A, "operator@example.com");
  const id = await invitationId(db, PLACE_A, OPERATOR);
  // Re-fire the identical domain event through the shared writer; the existing
  // dedup key absorbs it.
  await db.exec("reset role;");
  await db.query(
    `select public.notify_recipient($1::uuid, 'safety_account', 'live_operator_invitation_pending', 'Undangan Operator Live', 'duplikat', $2::text, 'live_operator_invitation', $3::text)`,
    [OPERATOR, PLACE_A, id],
  );
  const count = await rows(
    db,
    `select count(*)::int as n from public.notifications where user_id='${OPERATOR}' and event_type='live_operator_invitation_pending'`,
  );
  assert.equal(count[0].n, 1, "the dedup key absorbs a duplicate pending event");
  await db.close();
});
