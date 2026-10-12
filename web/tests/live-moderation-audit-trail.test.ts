import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * LIVE-D — moderation authority, the producer audit reader, the account-level
 * Live-capability suspension, and the closing fixes for A-08/A-10/A-11/A-12/A-13.
 *
 * Runs the REAL migration chain (through 0056) on Postgres (PGlite) and proves
 * every role-matrix cell this stage added, as a BACKEND RESULT (RPC raise /
 * returned rows), never as a UI message:
 *
 *  A-12  anon can read the public Live metadata again (`live_sessions`, `places`)
 *        without a `permission denied for table live_operators`, while the
 *        provider-sensitive columns stay invisible.
 *  A-13  the capacity denial is recorded out of band while the denial itself
 *        still holds; the grant is service-role only.
 *  A-11  a Place's ACTIVE owner/manager reads that Place's Live audit; editor,
 *        delegated operator, other-Place producer and anon are refused; no
 *        cross-tenant read.
 *  A-10  only platform_moderator may suspend/restore the account Live
 *        capability; producer/editor/operator/anon are refused; suspend blocks
 *        start for every authority of the account; restore re-enables; repeats
 *        are idempotent and every decision is audited with actor/target/reason.
 *  A-08  an ended/suspended session gives no admission; the playback route
 *        denies non-live sessions before any token is minted and the moderation
 *        route triggers provider revocation with the real provider capability.
 *  Regression: `assert_viewer_eligible` / `admit_live_viewer` still deny all.
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
  "0027_live_viewer_cap_race_guard.sql",
  "0028_place_claims.sql",
  "0029_notification_fanout.sql",
  "0047_account_center_live_operator.sql",
  "0048_live_operator_invitations.sql",
  "0049_live_operator_authority.sql",
  "0051_live_auth_integrity.sql",
  "0052_live_session_column_privileges.sql",
  "0053_live_viewer_presence_capacity.sql",
  "0056_live_moderation_audit_trail.sql",
];

const PLACE_A = "rumah-teh-lokal"; // prod-a, existing live session (session A)
const PLACE_B = "kopi-dari-kebun"; // prod-b, existing live session (session B)
const PLACE_C = "dapur-rasa"; // prod-c, NO live session (start tests)

const u = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER_A = u(1);
const MANAGER_A = u(2);
const EDITOR_A = u(3);
const OTHER_PRODUCER = u(4);
const STREAMER = u(5);
const OPERATOR_A = u(6);
const OPERATOR_B = u(7);
const MODERATOR = u(8);
const VIEWER = u(9);

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz, encrypted_password text, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
    grant usage on schema auth to authenticated;

    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;

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
  }
  return db;
}

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    insert into public.producers (id, display_name) values
      ('prod-a', 'Pengelola A'), ('prod-b', 'Pengelola B'), ('prod-c', 'Pengelola C')
      on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status) values
      ('stage-a', '${PLACE_A}', 'Tahap A', 'x', 0, 'published'),
      ('stage-b', '${PLACE_B}', 'Tahap B', 'x', 1, 'published'),
      ('stage-c', '${PLACE_C}', 'Tahap C', 'x', 2, 'published')
      on conflict (id) do nothing;
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key) values
      ('sess-a', '${PLACE_A}', 'prod-a', 'stage-a', 'live', 'idem-a'),
      ('sess-b', '${PLACE_B}', 'prod-b', 'stage-b', 'live', 'idem-b')
      on conflict (id) do nothing;
    insert into public.live_eligibility (producer_id, path, active) values
      ('prod-a', 'ADMIN_APPROVED', true),
      ('prod-b', 'ADMIN_APPROVED', true),
      ('prod-c', 'ADMIN_APPROVED', true)
      on conflict (producer_id, path) do nothing;
  `);
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${OWNER_A}', 'owner-a@example.com', now()),
      ('${MANAGER_A}', 'manager-a@example.com', now()),
      ('${EDITOR_A}', 'editor-a@example.com', now()),
      ('${OTHER_PRODUCER}', 'other@example.com', now()),
      ('${STREAMER}', 'streamer@example.com', now()),
      ('${OPERATOR_A}', 'op-a@example.com', now()),
      ('${OPERATOR_B}', 'op-b@example.com', now()),
      ('${MODERATOR}', 'mod@example.com', now()),
      ('${VIEWER}', 'viewer@example.com', now())
      on conflict (id) do nothing;
    insert into public.users (id, platform_role) values
      ('${OWNER_A}', null), ('${MANAGER_A}', null), ('${EDITOR_A}', null),
      ('${OTHER_PRODUCER}', null), ('${STREAMER}', null), ('${OPERATOR_A}', null),
      ('${OPERATOR_B}', null), ('${MODERATOR}', 'platform_moderator'), ('${VIEWER}', null)
      on conflict (id) do update set platform_role = excluded.platform_role;
    insert into public.producer_memberships (user_id, producer_id, place_id, role) values
      ('${OWNER_A}', 'prod-a', '${PLACE_A}', 'owner'),
      ('${MANAGER_A}', 'prod-a', '${PLACE_A}', 'manager'),
      ('${EDITOR_A}', 'prod-a', '${PLACE_A}', 'editor'),
      ('${OTHER_PRODUCER}', 'prod-b', '${PLACE_B}', 'owner'),
      ('${STREAMER}', 'prod-c', '${PLACE_C}', 'owner')
      on conflict (user_id, place_id) do nothing;
    insert into public.live_operators (user_id, place_id, granted_by) values
      ('${OPERATOR_A}', '${PLACE_A}', 'prod-a'),
      ('${OPERATOR_B}', '${PLACE_B}', 'prod-b')
      on conflict (user_id, place_id) do nothing;
  `);
}

async function actAs(db: PGlite, userId: string | null): Promise<void> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "",
  ]);
}

async function asRole(db: PGlite, role: string, sub: string | null): Promise<void> {
  await db.exec(`reset role; set role ${role};`);
  await actAs(db, sub);
}

async function resetRole(db: PGlite): Promise<void> {
  await db.exec("reset role;");
  await actAs(db, null);
}

// ---------------------------------------------------------------------------
// 1. Migration shape
// ---------------------------------------------------------------------------

test("0056 applies cleanly and is idempotent", async () => {
  const db = await createDb();
  // Re-applying must be a no-op (forward-only, re-runnable).
  await db.exec(stripPgcrypto(readMigration("0056_live_moderation_audit_trail.sql")));

  const table = await rows(
    db,
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'live_capability_suspensions'
      order by column_name`,
  );
  assert.deepEqual(
    table.map((r) => r.column_name),
    ["reason", "revoke_reason", "revoked_at", "revoked_by", "suspended_at", "suspended_by", "user_id"],
  );

  const fns = await rows(
    db,
    `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and proname in (
        'is_active_live_operator_for_place','is_live_account_suspended',
        'suspend_live_capability','restore_live_capability',
        'list_place_live_audit','record_live_admission_denied'
      ) order by proname`,
  );
  assert.deepEqual(fns.map((r) => r.proname), [
    "is_active_live_operator_for_place",
    "is_live_account_suspended",
    "list_place_live_audit",
    "record_live_admission_denied",
    "restore_live_capability",
    "suspend_live_capability",
  ]);

  // A-13: the inert in-transaction insert is gone.
  const admit = String(
    (await rows(db, `select prosrc from pg_proc where proname = 'admit_live_viewer'`))[0].prosrc,
  );
  assert.doesNotMatch(admit, /insert into public\.live_audit/);
  assert.match(admit, /raise exception 'live_capacity_full'/);

  // No client role may write the suspension table directly.
  for (const role of ["anon", "authenticated"]) {
    await asRole(db, role, role === "authenticated" ? VIEWER : null);
    await assert.rejects(
      () => db.query(`select * from public.live_capability_suspensions`),
      /permission denied/i,
      `${role} must not read the suspension table`,
    );
  }
  await resetRole(db);
  await db.close();
});

// ---------------------------------------------------------------------------
// 2. A-12 — anon public reads work again; sensitive columns stay dark
// ---------------------------------------------------------------------------

test("A-12: anon reads public Live metadata and Places without the operator ACL error", async () => {
  const db = await createDb();
  await seed(db);

  await asRole(db, "anon", null);
  // The exact pre-fix failure was `permission denied for table live_operators`.
  const live = await rows(db, `select id, status, viewer_peak from public.live_sessions where status = 'live'`);
  assert.equal(live.length, 2, "anon must see the live sessions of published Places");
  assert.deepEqual(live.map((r) => r.id).sort(), ["sess-a", "sess-b"]);

  // Provider-sensitive columns stay invisible (0052 is not widened).
  await assert.rejects(
    () => db.query(`select live_input_id from public.live_sessions`),
    /permission denied/i,
  );
  await assert.rejects(
    () => db.query(`select * from public.live_sessions`),
    /permission denied/i,
  );

  const places = await rows(db, `select id from public.places`);
  assert.ok(places.length >= 3, "anon must read published Places");
  await resetRole(db);

  // The operator policy still works via the helper: with the Place unpublished
  // (so the public-read policy no longer applies), an ACTIVE operator keeps the
  // operating-scoped read, and a REVOKED one loses it — 0047 semantics intact.
  await db.exec(`update public.places set publication_status = 'draft' where id = '${PLACE_A}'`);
  await asRole(db, "authenticated", OPERATOR_A);
  const operatorRead = await rows(db, `select id from public.live_sessions where id = 'sess-a'`);
  assert.equal(operatorRead.length, 1, "an active operator keeps operating-scoped session read");
  await resetRole(db);

  await db.exec(`update public.live_operators set revoked_at = now()
    where user_id = '${OPERATOR_A}' and place_id = '${PLACE_A}'`);
  await asRole(db, "authenticated", OPERATOR_A);
  const revokedRead = await rows(db, `select id from public.live_sessions where id = 'sess-a'`);
  assert.equal(revokedRead.length, 0, "a revoked operator reads no session");
  await resetRole(db);

  await db.close();
});

// ---------------------------------------------------------------------------
// 3. A-10 — account Live-capability suspension: authority matrix + audit
// ---------------------------------------------------------------------------

test("A-10: only platform_moderator may suspend/restore; actors and target are audited", async () => {
  const db = await createDb();
  await seed(db);

  // Every non-moderator authority of the SAME account is refused (backend result).
  for (const [label, sub] of [
    ["owner", OWNER_A],
    ["manager", MANAGER_A],
    ["editor", EDITOR_A],
    ["delegated operator", OPERATOR_B],
    ["plain viewer", VIEWER],
  ] as Array<[string, string]>) {
    await asRole(db, "authenticated", sub);
    await assert.rejects(
      () => db.query(`select public.suspend_live_capability('${STREAMER}', 'nope')`),
      /platform_moderator_required/,
      `${label} must not suspend a Live capability`,
    );
    await assert.rejects(
      () => db.query(`select public.restore_live_capability('${STREAMER}', 'nope')`),
      /platform_moderator_required/,
      `${label} must not restore a Live capability`,
    );
  }

  // anon holds no EXECUTE at all.
  await asRole(db, "anon", null);
  await assert.rejects(
    () => db.query(`select public.suspend_live_capability('${STREAMER}', 'x')`),
    /permission denied/i,
  );
  await resetRole(db);

  // Moderator: the decision lands, and it is audited with actor/target/reason.
  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.suspend_live_capability('${STREAMER}', 'pelanggaran berulang')`);
  await resetRole(db);

  const row = await rows(db, `select * from public.live_capability_suspensions where user_id = '${STREAMER}'`);
  assert.equal(row.length, 1, "one canonical suspension row");
  assert.equal(row[0].suspended_by, MODERATOR);
  assert.equal(row[0].reason, "pelanggaran berulang");
  assert.ok(row[0].suspended_at, "suspended_at is recorded");
  assert.equal(row[0].revoked_at, null, "still active");

  const audit = await rows(
    db,
    `select actor_id, action, detail, created_at from public.live_audit
      where action = 'live_capability_suspended' order by id`,
  );
  assert.equal(audit.length, 1, "exactly one suspension audit row");
  assert.equal(audit[0].actor_id, MODERATOR);
  assert.equal((audit[0].detail as Row).target_user_id, STREAMER);
  assert.equal((audit[0].detail as Row).reason, "pelanggaran berulang");
  assert.ok(audit[0].created_at, "time is recorded");

  // Idempotent: a second suspend changes nothing and appends nothing.
  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.suspend_live_capability('${STREAMER}', 'lain')`);
  await resetRole(db);
  const row2 = await rows(db, `select * from public.live_capability_suspensions where user_id = '${STREAMER}'`);
  assert.equal(row2.length, 1);
  assert.equal(row2[0].reason, "pelanggaran berulang", "idempotent: the original reason is kept");
  const auditAfterSuspend = await rows(
    db,
    `select count(*)::int as n from public.live_audit where action = 'live_capability_suspended'`,
  );
  assert.equal(Number(auditAfterSuspend[0].n), 1, "repeated suspend records no second audit row");

  // Restore: moderator only, audited, and idempotent too.
  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.restore_live_capability('${STREAMER}', 'banding diterima')`);
  await resetRole(db);
  const restored = await rows(db, `select * from public.live_capability_suspensions where user_id = '${STREAMER}'`);
  assert.equal(restored[0].revoked_at !== null, true, "revoked_at is set on restore");
  assert.equal(restored[0].revoked_by, MODERATOR);
  assert.equal(restored[0].revoke_reason, "banding diterima");
  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.restore_live_capability('${STREAMER}', 'lagi')`);
  await resetRole(db);
  const auditAfterRestore = await rows(
    db,
    `select count(*)::int as n from public.live_audit where action = 'live_capability_restored'`,
  );
  assert.equal(Number(auditAfterRestore[0].n), 1, "repeated restore records no second audit row");
  await resetRole(db);

  await db.close();
});

test("A-10: a suspended account cannot start/operate any Live until restored", async () => {
  const db = await createDb();
  await seed(db);

  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.suspend_live_capability('${STREAMER}', 'suspend')`);
  // A delegated operator of a DIFFERENT Place is suspended account-wide too.
  await rows(db, `select public.suspend_live_capability('${OPERATOR_B}', 'suspend operator')`);
  await resetRole(db);

  // Owner of PLACE_C cannot start while suspended.
  await asRole(db, "authenticated", STREAMER);
  await assert.rejects(
    () => db.query(`select public.start_live_session('${PLACE_C}', 'stage-c', 'idem-c-1', null)`),
    /producer_authorization_required/,
    "a suspended owner cannot start Live",
  );
  await resetRole(db);

  // Delegated operator of PLACE_B cannot start while suspended.
  await asRole(db, "authenticated", OPERATOR_B);
  await assert.rejects(
    () => db.query(`select public.start_live_session('${PLACE_B}', 'stage-b', 'idem-b-2', null)`),
    /producer_authorization_required/,
    "a suspended operator cannot start Live",
  );
  await resetRole(db);

  // Restore the owner only: start works again for PLACE_C.
  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.restore_live_capability('${STREAMER}', 'banding')`);
  await resetRole(db);
  await asRole(db, "authenticated", STREAMER);
  const started = await rows(db, `select public.start_live_session('${PLACE_C}', 'stage-c', 'idem-c-1', null) as r`);
  assert.equal(typeof (started[0].r as Row).sessionId, "string", "restore re-enables broadcasting");
  await resetRole(db);

  await db.close();
});

// ---------------------------------------------------------------------------
// 4. A-11 / P6 — the producer audit reader is Place-scoped and tenant-safe
// ---------------------------------------------------------------------------

test("A-11: owner/manager read only their own Place's Live audit; everyone else is refused", async () => {
  const db = await createDb();
  await seed(db);

  // Canonical audit rows for two different Places.
  await db.exec(`
    insert into public.live_audit (live_session_id, action, detail) values
      ('sess-a', 'session_started', '{"place":"a"}'::jsonb),
      ('sess-a', 'session_ended', '{"reason":"producer_ended"}'::jsonb),
      ('sess-b', 'session_started', '{"place":"b"}'::jsonb);
  `);

  // Owner of A: succeeds, sees ONLY Place A rows.
  await asRole(db, "authenticated", OWNER_A);
  const ownerRows = await rows(db, `select live_session_id, action from public.list_place_live_audit('${PLACE_A}')`);
  assert.equal(ownerRows.length, 2, "owner reads its Place's audit only");
  assert.deepEqual([...new Set(ownerRows.map((r) => r.live_session_id))], ["sess-a"]);

  // Owner of A reading ANOTHER Place's audit is refused (no cross-tenant).
  await assert.rejects(
    () => db.query(`select * from public.list_place_live_audit('${PLACE_B}')`),
    /producer_authorization_required/,
    "no cross-tenant audit read",
  );
  await resetRole(db);

  // Manager of A: allowed.
  await asRole(db, "authenticated", MANAGER_A);
  const managerRows = await rows(db, `select id from public.list_place_live_audit('${PLACE_A}')`);
  assert.equal(managerRows.length, 2, "an active manager may read");
  await resetRole(db);

  // Editor of A, delegated operator of A, and a producer of another Place: refused.
  for (const [label, sub] of [
    ["editor", EDITOR_A],
    ["delegated operator", OPERATOR_A],
    ["other-place producer", OTHER_PRODUCER],
  ] as Array<[string, string]>) {
    await asRole(db, "authenticated", sub);
    await assert.rejects(
      () => db.query(`select * from public.list_place_live_audit('${PLACE_A}')`),
      /producer_authorization_required/,
      `${label} must not read the Place audit`,
    );
  }
  await resetRole(db);

  // anon holds no EXECUTE on the reader.
  await asRole(db, "anon", null);
  await assert.rejects(
    () => db.query(`select * from public.list_place_live_audit('${PLACE_A}')`),
    /permission denied/i,
  );
  await resetRole(db);

  // live_audit stays dark to every client role (no direct SELECT was added).
  await asRole(db, "authenticated", OWNER_A);
  await assert.rejects(
    () => db.query(`select * from public.live_audit`),
    /permission denied/i,
    "the audit table itself stays dark (tech §3)",
  );
  await resetRole(db);

  await db.close();
});

// ---------------------------------------------------------------------------
// 5. A-13 — the denial is recorded out of band; the denial itself holds
// ---------------------------------------------------------------------------

test("A-13: record_live_admission_denied is service-role only and writes the row", async () => {
  const db = await createDb();
  await seed(db);

  // No client role can execute the recorder (cannot forge/spam audit rows).
  for (const [label, sub] of [
    ["authenticated", VIEWER],
  ] as Array<[string, string]>) {
    await asRole(db, "authenticated", sub);
    await assert.rejects(
      () => db.query(`select public.record_live_admission_denied('sess-a', '${sub}', 'capacity_full')`),
      /permission denied/i,
      `${label} must not call the recorder`,
    );
  }
  await asRole(db, "anon", null);
  await assert.rejects(
    () => db.query(`select public.record_live_admission_denied('sess-a', null, 'capacity_full')`),
    /permission denied/i,
  );
  await resetRole(db);

  // The trusted service-role path records the denial.
  await asRole(db, "service_role", null);
  await rows(db, `select public.record_live_admission_denied('sess-a', '${VIEWER}', 'capacity_full')`);
  await resetRole(db);

  const recorded = await rows(
    db,
    `select actor_id, detail from public.live_audit where action = 'admission_denied'`,
  );
  assert.equal(recorded.length, 1, "the denial is recorded");
  assert.equal(recorded[0].actor_id, VIEWER);
  assert.equal((recorded[0].detail as Row).reason, "capacity_full");
  assert.equal((recorded[0].detail as Row).recorded_via, "server");

  // Recording grants NOTHING: the gate still denies and writes no ledger row.
  await asRole(db, "authenticated", VIEWER);
  await assert.rejects(
    () => db.query(`select public.admit_live_viewer('sess-a')`),
    /live_viewer_denied/,
    "the fail-closed gate is untouched by the recorder",
  );
  await resetRole(db);
  const viewers = await rows(db, `select count(*)::int as n from public.live_viewers`);
  assert.equal(Number(viewers[0].n), 0, "no admission resulted from recording");

  await db.close();
});

// ---------------------------------------------------------------------------
// 6. Moderation authority matrix + A-08 provider-revocation trigger
// ---------------------------------------------------------------------------

test("moderation actions: only platform_moderator succeeds; others get a backend refusal", async () => {
  const db = await createDb();
  await seed(db);

  for (const [label, sub] of [
    ["owner", OWNER_A],
    ["manager", MANAGER_A],
    ["editor", EDITOR_A],
    ["delegated operator", OPERATOR_A],
    ["plain viewer", VIEWER],
  ] as Array<[string, string]>) {
    await asRole(db, "authenticated", sub);
    await assert.rejects(
      () => db.query(`select public.moderate_live('sess-a', 'warn', 'x')`),
      /platform_moderator_required/,
      `${label} must not moderate`,
    );
  }
  await asRole(db, "anon", null);
  await assert.rejects(
    () => db.query(`select public.moderate_live('sess-a', 'warn', 'x')`),
    /permission denied/i,
  );
  await resetRole(db);

  // Moderator succeed, and the session ends; a producer cannot reopen it.
  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.moderate_live('sess-a', 'end', 'pelanggaran')`);
  await resetRole(db);
  const ended = await rows(db, `select status, ended_reason from public.live_sessions where id = 'sess-a'`);
  assert.equal(ended[0].status, "ended");
  assert.equal(ended[0].ended_reason, "moderation");

  // Producer cannot override the moderation: it cannot un-end, and a repeated
  // moderation does not duplicate STATE (idempotent).
  await asRole(db, "authenticated", OWNER_A);    const reopen = await rows(db, `select public.end_live_session('sess-a', 'producer-key', 'producer_ended', null) as r`);
  assert.ok(!reopen[0].r, "a producer cannot reopen/override a moderated end");
  await resetRole(db);
  await asRole(db, "authenticated", MODERATOR);
  await rows(db, `select public.moderate_live('sess-a', 'end', 'ulang')`);
  await resetRole(db);
  const stillEnded = await rows(db, `select status, ended_reason from public.live_sessions where id = 'sess-a'`);
  assert.equal(stillEnded[0].status, "ended");
  assert.equal(stillEnded[0].ended_reason, "moderation", "state is idempotent across repeated moderation");

  await db.close();
});

test("A-08: the playback route denies a non-live session before signing, and moderation triggers provider revocation", () => {
  const playback = readFileSync(new URL("../app/api/live/playback/route.ts", import.meta.url), "utf8");
  const moderationRoute = readFileSync(
    new URL("../app/api/admin/live/moderation/route.ts", import.meta.url),
    "utf8",
  );
  const service = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");

  // No new token for an ended/suspended session: the status check precedes signing.
  const statusCheck = playback.indexOf('session.status !== "live"');
  const sign = playback.indexOf("signPlaybackToken(");
  assert.ok(statusCheck > 0 && statusCheck < sign, "the live check must precede token signing");
  assert.match(playback, /live_session_not_live/);

  // Moderation is platform-moderator only and triggers the real provider
  // capability (Cloudflare live-input delete via the ended-input sweep).
  assert.match(moderationRoute, /requirePlatformModerator/);
  assert.match(service, /export async function moderateLiveSession/);
  assert.match(service, /sweepEndedLiveInputs\(\)/);
  assert.match(service, /params.action === "end" \|\| params.action === "suspend" \|\| params.action === "block_content"/);
});

// ---------------------------------------------------------------------------
// 7. Regression — the viewer gate is still fail-closed
// ---------------------------------------------------------------------------

test("assert_viewer_eligible / admit_live_viewer still deny, and an ended session admits nobody", async () => {
  const db = await createDb();
  await seed(db);

  await asRole(db, "authenticated", VIEWER);
  await assert.rejects(
    () => db.query(`select public.assert_viewer_eligible('sess-a')`),
    /live_viewer_denied/,
    "B1 gate still denies every viewer",
  );
  await assert.rejects(
    () => db.query(`select public.admit_live_viewer('sess-a')`),
    /live_viewer_denied/,
  );
  await resetRole(db);

  // A session that is not live is refused before the (still denying) age gate.
  await db.exec(`update public.live_sessions set status = 'ended' where id = 'sess-b'`);
  await asRole(db, "authenticated", VIEWER);
  await assert.rejects(
    () => db.query(`select public.admit_live_viewer('sess-b')`),
    /live_session_not_live/,
    "an ended session gives no admission",
  );
  await resetRole(db);
  const viewers = await rows(db, `select count(*)::int as n from public.live_viewers`);
  assert.equal(Number(viewers[0].n), 0, "no admission anywhere");

  await db.close();
});

// ---------------------------------------------------------------------------
// 8. The runnable DEV script (result set of check_name / passed / detail)
// ---------------------------------------------------------------------------

test("db-regression/live-moderation-audit-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-moderation-audit-access.sql", import.meta.url),
    "utf8",
  );

  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Array<Record<string, unknown>>;
  assert.ok(checkRows.length >= 18, `expected >= 18 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );

  const leftover = await rows(db, `select 1 as one from public.live_sessions where id = 'live-mod-dev'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});
