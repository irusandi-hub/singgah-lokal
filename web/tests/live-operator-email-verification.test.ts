import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * A-06 — a VERIFIED EMAIL is required for the delegated Operator Live
 * authority (migration 0051, section 2).
 *
 * The audit found an account whose email was never confirmed could hold a
 * delegated operator assignment and broadcast Live, while a viewer with the
 * same unconfirmed email is refused. The authoritative source is
 * auth.users.email_confirmed_at — never a client boolean or user metadata.
 *
 * POLICY DECISION (recorded in the migration header and the audit update):
 * the masters leave the requirement undecided for owner/manager, so the gate
 * applies to the OPERATOR-DELEGATE scope only (audit §5.5 flags A-06 on the
 * operator row of the matrix). This suite locks that scope explicitly.
 *
 * Proven here on a real Postgres engine:
 *  - an unverified invitee cannot ACCEPT (email_verification_required, and the
 *    invitation stays pending);
 *  - an ACTIVE assignment whose email is unconfirmed cannot START;
 *  - after confirmation the same invitee accepts and starts;
 *  - revocation denies the very next start (no authorization cache);
 *  - an owner/manager WITHOUT a confirmed email still starts (policy scope);
 *  - the authority predicate stays internal (no client EXECUTE).
 *
 * The same contract, as a runnable DEV script emitting a result set, lives in
 * tests/db-regression/live-operator-email-verification-access.sql (executed
 * by the last test in this file).
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

const MANAGER = "11111111-1111-1111-1111-111111111111";
const OPERATOR = "22222222-2222-2222-2222-222222222222";
const PLACE_A = "rumah-teh-lokal"; // seeded by 0001
const PRODUCER_A = "prod-email-op";
const STAGE_A = "stage-email-op";

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  // auth.uid() follows the Supabase contract: it reads the request.jwt.claims
  // GUC, so a test only has to switch role + set the claims (mirroring what
  // the PostgREST runtime does for a signed-in session).
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

async function seedWorld(db: PGlite, operatorEmailConfirmed: boolean): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${MANAGER}', 'manager@example.com', now()),
      ('${OPERATOR}', 'operator@example.com', ${operatorEmailConfirmed ? "now()" : "null"})
    on conflict (id) do update set email_confirmed_at = excluded.email_confirmed_at;
    insert into public.users (id) values ('${MANAGER}'), ('${OPERATOR}') on conflict (id) do nothing;
    insert into public.producers (id, display_name) values ('${PRODUCER_A}', 'Pengelola Email') on conflict (id) do nothing;
    insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values ('${MANAGER}', '${PRODUCER_A}', '${PLACE_A}', 'owner') on conflict do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
      values ('${STAGE_A}', '${PLACE_A}', 'Tahap Email', 'x', 0, 'published')
      on conflict (id) do nothing;
    insert into public.live_eligibility (producer_id, path, active, granted_by)
      values ('${PRODUCER_A}', 'ADMIN_APPROVED', true, 'regression')
      on conflict (producer_id, path) do update set active = true;
  `);
}

/**
 * Act as `userId` for the next statement.
 *
 * `auth.uid()` is replaced by a constant (the same technique
 * tests/live-operator-authority-migration.test.ts uses), NOT the
 * request.jwt.claims GUC: `set_config(..., true)` is transaction-local and
 * every `db.query` here is its own transaction, so a GUC set in one statement
 * is already gone — and therefore NULL — by the time the RPC reads it.
 */
async function actAs(db: PGlite, userId: string): Promise<void> {
  await db.exec(`reset role;`);
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select '${userId}'::uuid $fn$`,
  );
  await db.exec(`set role authenticated;`);
}

async function callAs(db: PGlite, userId: string, sql: string): Promise<Row[]> {
  await actAs(db, userId);
  try {
    const result = await db.query(sql);
    return (result.rows ?? []) as Row[];
  } finally {
    await db.exec(`reset role;`);
  }
}

async function expectRaise(db: PGlite, userId: string, sql: string, message: string): Promise<void> {
  await actAs(db, userId);
  try {
    await db.query(sql);
    assert.fail(`expected raise exception '${message}'`);
  } catch (error) {
    assert.equal((error as Error).message, message);
  } finally {
    await db.exec(`reset role;`);
  }
}

// ---------------------------------------------------------------------------
// 1. Migration shape
// ---------------------------------------------------------------------------

test("0051 gates the OPERATOR branch on a confirmed email and leaves owner/manager untouched", async () => {
  const db = await createDb();

  // The predicate source: the email EXISTS check sits inside the operator
  // branch only; the membership branch is byte-for-byte the 0049 rule.
  const source = readMigration("0051_live_auth_integrity.sql");
  const predicateStart = source.indexOf("function public.can_operate_live_for_place");
  const predicateEnd = source.indexOf("$$;", predicateStart);
  const predicate = source.slice(predicateStart, predicateEnd);
  assert.match(predicate, /from public\.producer_memberships m[\s\S]*?m\.role in \('owner', 'manager'\)/);
  assert.match(predicate, /from public\.live_operators lo[\s\S]*?lo\.revoked_at is null/);
  assert.match(predicate, /from auth\.users u\s*where u\.id = p_user_id\s*and u\.email_confirmed_at is not null/);
  // The email check must not gate the owner/manager membership branch.
  assert.doesNotMatch(
    predicate.slice(0, predicate.indexOf("or exists")),
    /email_confirmed_at/,
    "the owner/manager branch must not require a verified email (policy scope)",
  );

  // The accept RPC raises before the invitation lookup (fail-closed earliest).
  const acceptStart = source.indexOf("function public.accept_live_operator_invitation");
  const acceptEnd = source.indexOf("$$;", acceptStart);
  const accept = source.slice(acceptStart, acceptEnd);
  const emailCheckOffset = accept.indexOf("email_verification_required");
  const lookupOffset = accept.indexOf("from public.live_operator_invitations");
  assert.ok(emailCheckOffset > -1, "accept must raise email_verification_required");
  assert.ok(
    emailCheckOffset < lookupOffset,
    "the email gate must run before the invitation lookup",
  );

  // Privileges: the predicate stays internal; accept stays authenticated-only.
  assert.equal(
    Boolean((await rows(db, `select has_function_privilege('authenticated','public.can_operate_live_for_place(uuid,text)','EXECUTE') as ok`))[0].ok),
    false,
  );
  assert.equal(
    Boolean((await rows(db, `select has_function_privilege('authenticated','public.accept_live_operator_invitation(uuid)','EXECUTE') as ok`))[0].ok),
    true,
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 2. Behaviour through the real RPCs
// ---------------------------------------------------------------------------

test("an unverified operator is refused accept AND start; after confirmation both succeed; revoke denies again", async () => {
  const db = await createDb();
  await seedWorld(db, false);

  // The manager invites the unverified account (invitations have no gate).
  await callAs(
    db,
    MANAGER,
    `select public.invite_live_operator('${PLACE_A}'::text, 'operator@example.com'::text)`,
  );
  const invitation = (
    await rows(db, `select id from public.live_operator_invitations where status = 'pending'`)
  )[0];
  assert.ok(invitation, "a pending invitation exists");

  // ACCEPT refused: email_verification_required.
  await expectRaise(
    db,
    OPERATOR,
    `select public.accept_live_operator_invitation('${String(invitation.id)}'::uuid)`,
    "email_verification_required",
  );
  assert.equal(
    (await rows(db, `select status from public.live_operator_invitations where id = $1`, [invitation.id]))[0].status,
    "pending",
    "the invitation stays pending after the refused accept",
  );

  // Even holding an ACTIVE assignment, the unverified operator cannot start.
  await db.exec(`
    insert into public.live_operators (user_id, place_id, granted_by, granted_at, revoked_at)
    values ('${OPERATOR}', '${PLACE_A}', '${PRODUCER_A}', now(), null)
    on conflict (user_id, place_id) do update set revoked_at = null;
  `);
  await expectRaise(
    db,
    OPERATOR,
    `select public.start_live_session('${PLACE_A}', '${STAGE_A}', 'op-unverified-key', 'input-1')`,
    "producer_authorization_required",
  );

  // Confirm the email (the authoritative source) — accept now succeeds.
  await db.exec(`update auth.users set email_confirmed_at = now() where id = '${OPERATOR}';`);
  await callAs(
    db,
    OPERATOR,
    `select public.accept_live_operator_invitation('${String(invitation.id)}'::uuid)`,
  );
  assert.equal(
    (await rows(db, `select status from public.live_operator_invitations where id = $1`, [invitation.id]))[0].status,
    "accepted",
  );
  assert.equal(
    (await rows(db, `select revoked_at from public.live_operators where user_id = '${OPERATOR}' and place_id = '${PLACE_A}'`))[0].revoked_at,
    null,
    "the assignment is active after the verified accept",
  );

  // And the verified operator can now start.
  const started = await callAs(
    db,
    OPERATOR,
    `select public.start_live_session('${PLACE_A}', '${STAGE_A}', 'op-verified-key', 'input-2') as out`,
  );
  const session = started[0].out as Record<string, unknown>;
  assert.ok(String(session.sessionId), "the verified operator started a session");

  // End it (same authority) so the Place is free again.
  await callAs(
    db,
    OPERATOR,
    `select public.end_live_session('${String(session.sessionId)}', 'op-verified-end', 'producer_ended', null)`,
  );

  // Revoke as the manager → the operator's NEXT start is refused.
  const accepted = (
    await rows(db, `select id from public.live_operator_invitations where status = 'accepted'`)
  )[0];
  await callAs(
    db,
    MANAGER,
    `select public.revoke_live_operator_invitation('${String(accepted.id)}'::uuid)`,
  );
  await expectRaise(
    db,
    OPERATOR,
    `select public.start_live_session('${PLACE_A}', '${STAGE_A}', 'op-revoked-key', 'input-3')`,
    "producer_authorization_required",
  );

  await db.close();
});

test("POLICY DECISION: an owner/manager without a confirmed email still starts Live", async () => {
  const db = await createDb();
  await seedWorld(db, true);

  // Un-confirm the OWNER's email: the operator-scope gate must not touch them.
  await db.exec(`update auth.users set email_confirmed_at = null where id = '${MANAGER}';`);

  const started = await callAs(
    db,
    MANAGER,
    `select public.start_live_session('${PLACE_A}', '${STAGE_A}', 'mgr-unverified-key', 'input-9') as out`,
  );
  const session = started[0].out as Record<string, unknown>;
  assert.ok(String(session.sessionId), "an unverified-email owner still starts (policy scope)");

  await db.close();
});

// ---------------------------------------------------------------------------
// 3. The runnable DEV script (result set of check_name / passed / detail)
// ---------------------------------------------------------------------------

test("db-regression/live-operator-email-verification-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-operator-email-verification-access.sql", import.meta.url),
    "utf8",
  );

  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Array<Record<string, unknown>>;
  assert.equal(checkRows.length, 10, `expected 10 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );

  // Rollback contract: no fixture residue.
  const leftover = await rows(db, `select 1 as one from auth.users where id = '${OPERATOR}'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});
