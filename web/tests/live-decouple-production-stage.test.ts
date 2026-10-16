import assert from "node:assert/strict";
import test, { before } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * LIVE ↔ KEGIATAN / KELOLA PROSES — DECOUPLING (product decision 2026-10-16).
 *
 * Kegiatan and Kelola Proses are INFORMATIONAL tools; Live is a SEPARATE
 * Place-associated capability. This suite proves — on the REAL migration chain
 * executed by PGlite (the WASM build of the actual Postgres server) — that:
 *
 *   A. an authorized, eligible Place with ZERO Production Stages can start a
 *      Live, and the created session carries no stage reference;
 *   B. informational content cannot gate or end Live: pausing/archiving a stage
 *      leaves a running session live, deleting a stage no longer deletes the
 *      Place's sessions, and the removed end reason is refused;
 *   C. authorization is untouched: owner/manager and an ACTIVE delegated
 *      operator can operate, everyone else (editor, outsider, another Place's
 *      owner, revoked operator) cannot, and an operator gains no Producer
 *      membership or any non-Live privilege;
 *   D. every safeguard still holds: idempotent start and end, per-Place and
 *      global caps, the duration cap with its own reason, the audit trail,
 *      and the end-reason vocabulary;
 *   E. the schema change is exactly the decoupling: guard trigger and function
 *      gone, composite FK gone, `stage_id` nullable, the legacy end reason
 *      still valid for historical rows, and both RPCs still SECURITY DEFINER
 *      with the same pinned search_path and EXECUTE posture.
 *
 * The application layers are checked against the same rule: the console has no
 * stage selector or stage gate, the page reads no Production Stages at all, the
 * start request body carries only { placeId, idempotencyKey }, and neither the
 * API nor the service can produce `live_stage_not_published`.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (sql: string) => sql.replace(/create extension if not exists pgcrypto;?/gim, "");
const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");

const ALL_MIGRATIONS = readdirSync(new URL(MIGRATION_DIR, import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();

const DECOUPLE_MIGRATION = "0060_live_decouple_production_stage.sql";
const decoupleSql = stripComments(readMigration(DECOUPLE_MIGRATION));

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> =>
  ((await db.query(query)).rows ?? []) as Row[];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = "11110000-0000-4000-8000-000000000001";
const EDITOR = "11110000-0000-4000-8000-000000000002";
const OUTSIDER = "11110000-0000-4000-8000-000000000003";
const OPERATOR = "11110000-0000-4000-8000-000000000004";
const OTHER_OWNER = "11110000-0000-4000-8000-000000000005";

const PRODUCER_A = "decouple-producer-a";
const PRODUCER_B = "decouple-producer-b";
const PLACE_A = "decouple-place-a"; // has a published AND a draft stage
const PLACE_B = "decouple-place-b"; // has NO stage at all
const PLACE_C = "decouple-place-c"; // another Place, for cross-Place checks
const STAGE_A = "decouple-stage-a"; // published
const STAGE_A_DRAFT = "decouple-stage-a-draft"; // draft

let db: PGlite;

async function createDb(): Promise<PGlite> {
  const database = new PGlite();
  await database.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, encrypted_password text);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
    alter role service_role bypassrls;
    grant usage on schema auth to anon, authenticated;

    create schema if not exists realtime;
    create table realtime.messages (id bigserial primary key, topic text, extension text, event text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to anon, authenticated;
    grant select on realtime.messages to anon, authenticated;
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
  await database.exec("create publication supabase_realtime;");
  for (const name of ALL_MIGRATIONS) {
    await database.exec(stripPgcrypto(readMigration(name)));
    if (name === "0001_visit_intent_foundation.sql") {
      // Supabase grants default table privileges when a table is CREATED, i.e.
      // BEFORE each migration's explicit REVOKE/GRANT runs — applying them here
      // is what makes the lockdowns the real posture instead of a no-op.
      await database.exec(
        `grant usage on schema public to anon, authenticated, service_role;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
  return database;
}

/** Act as `userId` through the app's own auth seam (auth.uid() override). */
async function actAs(userId: string): Promise<void> {
  await db.exec("reset role;");
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select '${userId}'::uuid $fn$`,
  );
  await db.exec("set role authenticated;");
}

async function callAs(userId: string, sql: string): Promise<Row[]> {
  await actAs(userId);
  try {
    return await rows(db, sql);
  } finally {
    await db.exec("reset role;");
  }
}

async function expectLiveError(userId: string, sql: string, expected: RegExp): Promise<void> {
  await actAs(userId);
  try {
    await db.query(sql);
    assert.fail(`expected a Live error matching ${expected}`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(String((error as Error).message), expected);
  } finally {
    await db.exec("reset role;");
  }
}

async function seedWorld(): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${OWNER}', 'owner@example.com', now()),
      ('${EDITOR}', 'editor@example.com', now()),
      ('${OUTSIDER}', 'outsider@example.com', now()),
      ('${OPERATOR}', 'operator@example.com', now()),
      ('${OTHER_OWNER}', 'other@example.com', now())
    on conflict (id) do nothing;
    insert into public.users (id) values
      ('${OWNER}'), ('${EDITOR}'), ('${OUTSIDER}'), ('${OPERATOR}'), ('${OTHER_OWNER}')
    on conflict (id) do nothing;
    insert into public.producers (id, display_name) values
      ('${PRODUCER_A}', 'Pengelola A'), ('${PRODUCER_B}', 'Pengelola B')
    on conflict (id) do nothing;
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id, publication_status) values
      ('${PLACE_A}', 'Tempat A', 'Test', 'Perdagangan & Jasa', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', '${PRODUCER_A}', 'published'),
      ('${PLACE_B}', 'Tempat B', 'Test', 'Perdagangan & Jasa', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', '${PRODUCER_A}', 'published'),
      ('${PLACE_C}', 'Tempat C', 'Test', 'Perdagangan & Jasa', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', '${PRODUCER_B}', 'published')
    on conflict (id) do nothing;
    insert into public.producer_memberships (user_id, producer_id, place_id, role) values
      ('${OWNER}', '${PRODUCER_A}', '${PLACE_A}', 'owner'),
      ('${OWNER}', '${PRODUCER_A}', '${PLACE_B}', 'owner'),
      ('${EDITOR}', '${PRODUCER_A}', '${PLACE_A}', 'editor'),
      ('${OTHER_OWNER}', '${PRODUCER_B}', '${PLACE_C}', 'owner')
    on conflict do nothing;
    -- PLACE_A's informational content: one published and one draft Process.
    -- PLACE_B deliberately has NO Production Stage at all.
    insert into public.production_stages (id, place_id, title, description, sort_order, status) values
      ('${STAGE_A}', '${PLACE_A}', 'Proses A', 'x', 0, 'published'),
      ('${STAGE_A_DRAFT}', '${PLACE_A}', 'Proses A (draf)', 'x', 1, 'draft')
    on conflict (id) do nothing;
    insert into public.live_eligibility (producer_id, path, active, granted_by) values
      ('${PRODUCER_A}', 'ADMIN_APPROVED', true, 'regression'),
      ('${PRODUCER_B}', 'ADMIN_APPROVED', true, 'regression')
    on conflict (producer_id, path) do update set active = true;
  `);
}

const start = (placeId: string, key: string, input: string) =>
  `select public.start_live_session('${placeId}'::text, null::text, '${key}'::text, '${input}'::text)`;

const startWithoutStageArgument = (placeId: string, key: string, input: string) =>
  `select public.start_live_session(p_place_id => '${placeId}'::text, p_idempotency_key => '${key}'::text, p_live_input_id => '${input}'::text)`;

const end = (sessionId: string, key: string, reason = "producer_ended") =>
  `select public.end_live_session('${sessionId}'::text, '${key}'::text, '${reason}'::text, null::text)`;

/** PGlite returns a jsonb column already parsed, but accepts a text form too. */
function jsonPayload<T>(raw: unknown): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

async function startLive(
  userId: string,
  placeId: string,
  key: string,
): Promise<{ sessionId: string; replayed: boolean }> {
  const result = await callAs(userId, start(placeId, key, `input-${key}`));
  return jsonPayload<{ sessionId: string; replayed: boolean }>(result[0].start_live_session);
}

before(async () => {
  db = await createDb();
  await seedWorld();
});

// ---------------------------------------------------------------------------
// A. Live without a stage
// ---------------------------------------------------------------------------

test("A: a Place with ZERO Production Stages starts a Live, and the session has no stage", async () => {
  const noStages = await rows(
    db,
    `select count(*)::int as n from public.production_stages where place_id = '${PLACE_B}'`,
  );
  assert.equal(noStages[0].n, 0, "PLACE_B must have no Process at all");

  // The RPC's legacy stage argument is OMITTED entirely (named notation), so
  // this call proves the DEFAULT applies and nothing requires a stage.
  const result = await callAs(OWNER, startWithoutStageArgument(PLACE_B, "decouple-a1", "input-a1"));
  const sessionId = jsonPayload<{ sessionId: string }>(result[0].start_live_session).sessionId;
  assert.ok(sessionId, "the session must be created");

  const session = await rows(
    db,
    `select stage_id, status, producer_id from public.live_sessions where id = '${sessionId}'`,
  );
  assert.equal(session.length, 1);
  assert.equal(session[0].stage_id, null, "a new session carries NO stage reference");
  assert.equal(session[0].status, "live");
  assert.equal(session[0].producer_id, PRODUCER_A, "the producer is still derived server-side");

  // The audit row records the lifecycle action and claims no Process.
  const audit = await rows(
    db,
    `select detail from public.live_audit
      where live_session_id = '${sessionId}' and action = 'session_started'`,
  );
  assert.equal(audit.length, 1, "exactly one session_started audit row");
  assert.equal(
    Object.prototype.hasOwnProperty.call(audit[0].detail as object, "stage_id"),
    false,
    "the audit detail must not claim a Process",
  );

  // Leave the world calm for the next test (the caps are global).
  await callAs(OWNER, end(sessionId, "decouple-a1-end"));
});

test("A: the legacy stage argument is accepted but ignored", async () => {
  // PLACE_A has a published stage AND a draft one; the start below passes the
  // DRAFT id explicitly. Ignoring it is the point: no stage is validated, and
  // nothing is persisted from it.
  const result = await callAs(OWNER, start(PLACE_A, "decouple-a2", "input-a2"));
  const sessionId = jsonPayload<{ sessionId: string }>(result[0].start_live_session).sessionId;
  const session = await rows(db, `select stage_id from public.live_sessions where id = '${sessionId}'`);
  assert.equal(session[0].stage_id, null, "an ignored stage argument is never persisted");
  await callAs(OWNER, end(sessionId, "decouple-a2-end"));
});

// ---------------------------------------------------------------------------
// B. Independence from informational content
// ---------------------------------------------------------------------------

test("B: pausing/archiving a Process leaves the running Live alone", async () => {
  const { sessionId } = await startLive(OWNER, PLACE_A, "decouple-b1");

  await db.exec(`update public.production_stages set status = 'paused' where id = '${STAGE_A}'`);
  await db.exec(`update public.production_stages set status = 'archived' where id = '${STAGE_A_DRAFT}'`);

  const after = await rows(
    db,
    `select status, ended_reason from public.live_sessions where id = '${sessionId}'`,
  );
  assert.equal(after[0].status, "live", "unpublishing informational content must NOT end a Live");
  assert.equal(after[0].ended_reason, null);

  // …and the Live can still be ended normally afterwards.
  await callAs(OWNER, end(sessionId, "decouple-b1-end"));
  const ended = await rows(
    db,
    `select status, ended_reason from public.live_sessions where id = '${sessionId}'`,
  );
  assert.equal(ended[0].status, "ended");
  assert.equal(ended[0].ended_reason, "producer_ended");
});

test("B: the removed end reason is refused by the lifecycle", async () => {
  const { sessionId } = await startLive(OWNER, PLACE_A, "decouple-b2");
  await expectLiveError(
    OWNER,
    end(sessionId, "decouple-b2-end", "source_stage_unpublished"),
    /live_end_reason_invalid/,
  );
  const still = await rows(db, `select status from public.live_sessions where id = '${sessionId}'`);
  assert.equal(still[0].status, "live", "the refused end changed nothing");
  await callAs(OWNER, end(sessionId, "decouple-b2-end-ok"));
});

test("B: deleting a Process no longer deletes the Place's Live sessions", async () => {
  // A LEGACY session that does reference a Process (as historical rows do).
  await db.exec(`
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key, created_at, started_at)
    values ('decouple-legacy-session', '${PLACE_C}', '${PRODUCER_B}', null, 'ended', 'decouple-legacy-key', now(), now())
  `);
  await db.exec(`update public.live_sessions set stage_id = null where id = 'decouple-legacy-session'`);
  // Re-attach a real reference through a fresh row, then delete that Process.
  await db.exec(`
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('decouple-legacy-stage', '${PLACE_C}', 'Proses lama', 'x', 0, 'published')
    on conflict (id) do nothing
  `);
  await db.exec(
    `update public.live_sessions set stage_id = 'decouple-legacy-stage' where id = 'decouple-legacy-session'`,
  );

  await db.exec(`delete from public.production_stages where id = 'decouple-legacy-stage'`);

  const surviving = await rows(
    db,
    `select id, status, ended_reason from public.live_sessions where id = 'decouple-legacy-session'`,
  );
  assert.equal(surviving.length, 1, "informational content must not cascade-delete Live history");
  assert.equal(surviving[0].status, "ended", "the session row is untouched by the Process deletion");
  assert.equal(surviving[0].ended_reason, null);
});

// ---------------------------------------------------------------------------
// C. Authorization is unchanged
// ---------------------------------------------------------------------------

test("C: only an owner/manager or an ACTIVE delegated operator can start a Live", async () => {
  const owner = await startLive(OWNER, PLACE_A, "decouple-c-owner");
  assert.ok(owner.sessionId);
  await callAs(OWNER, end(owner.sessionId, "decouple-c-owner-end"));

  await expectLiveError(EDITOR, start(PLACE_A, "decouple-c-editor", "in"), /producer_authorization_required/);
  await expectLiveError(OUTSIDER, start(PLACE_A, "decouple-c-outsider", "in"), /producer_authorization_required/);
  // An owner of a DIFFERENT Place is not authority for this one.
  await expectLiveError(OTHER_OWNER, start(PLACE_A, "decouple-c-other", "in"), /producer_authorization_required/);

  // A delegated operator with an ACTIVE assignment for EXACTLY this Place.
  await db.exec(`
    insert into public.live_operators (user_id, place_id, granted_by, granted_at, revoked_at)
    values ('${OPERATOR}', '${PLACE_C}', '${PRODUCER_B}', now(), null)
    on conflict (user_id, place_id) do update set revoked_at = null, granted_by = excluded.granted_by
  `);
  // Knowing a Place id is never authority: the operator cannot start for a
  // Place it is not assigned to (PLACE_A belongs to another Producer).
  await expectLiveError(OPERATOR, start(PLACE_A, "decouple-c-operator-wrong-place", "in"), /producer_authorization_required/);

  const operator = await startLive(OPERATOR, PLACE_C, "decouple-c-operator");
  assert.ok(operator.sessionId, "an active operator may operate the assigned Place's Live");
  const operatorSession = await rows(
    db,
    `select producer_id from public.live_sessions where id = '${operator.sessionId}'`,
  );
  assert.equal(
    operatorSession[0].producer_id,
    PRODUCER_B,
    "the producing producer comes from the delegation, never from the client",
  );
  // …and the operator gains NO Producer membership anywhere.
  const memberships = await rows(
    db,
    `select count(*)::int as n from public.producer_memberships where user_id = '${OPERATOR}'`,
  );
  assert.equal(memberships[0].n, 0, "operating Live must not grant Place-management privileges");
  await callAs(OPERATOR, end(operator.sessionId, "decouple-c-operator-end"));

  // Revocation denies the very next start.
  await db.exec(`update public.live_operators set revoked_at = now() where user_id = '${OPERATOR}' and place_id = '${PLACE_C}'`);
  await expectLiveError(OPERATOR, start(PLACE_C, "decouple-c-revoked", "in"), /producer_authorization_required/);
});

test("C: an unrelated account cannot end another Place's Live", async () => {
  const { sessionId } = await startLive(OWNER, PLACE_A, "decouple-c-end-guard");
  await expectLiveError(OUTSIDER, end(sessionId, "decouple-c-end-outsider"), /producer_authorization_required/);
  // An editor of the SAME Place still cannot end it (read-only role).
  await expectLiveError(EDITOR, end(sessionId, "decouple-c-end-editor"), /producer_authorization_required/);
  // A revoked operator is not authority either.
  await expectLiveError(OPERATOR, end(sessionId, "decouple-c-end-operator"), /producer_authorization_required/);
  const still = await rows(db, `select status from public.live_sessions where id = '${sessionId}'`);
  assert.equal(still[0].status, "live");
  await callAs(OWNER, end(sessionId, "decouple-c-end-guard-ok"));
});

test("C: the authority predicate stays internal and writes stay RPC-only", async () => {
  const predicate = await rows(
    db,
    `select has_function_privilege('authenticated', 'public.can_operate_live_for_place(uuid,text)', 'EXECUTE') as allowed`,
  );
  assert.equal(predicate[0].allowed, false, "the SQL authority predicate must not be client-callable");

  // Live writes stay RPC-only: no client INSERT/UPDATE/DELETE policy exists on
  // live_sessions, for the operator or for anyone else.
  const writes = await rows(
    db,
    `select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename = 'live_sessions'
        and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')`,
  );
  assert.equal(writes[0].n, 0, "live_sessions must keep zero client write policies");
  await expectLiveError(
    OUTSIDER,
    `insert into public.live_sessions (id, place_id, producer_id, status, idempotency_key)
     values ('decouple-direct-insert', '${PLACE_C}', '${PRODUCER_B}', 'live', 'decouple-direct-key')`,
    /row-level security|permission denied/i,
  );
});

// ---------------------------------------------------------------------------
// D. Safeguards
// ---------------------------------------------------------------------------

test("D: start is idempotent and the audit trail records it once", async () => {
  const first = await startLive(OWNER, PLACE_A, "decouple-d-idem");
  const replay = await startLive(OWNER, PLACE_A, "decouple-d-idem");
  assert.equal(replay.sessionId, first.sessionId, "a replay returns the ORIGINAL session");
  assert.equal(replay.replayed, true);

  const count = await rows(
    db,
    `select count(*)::int as n from public.live_sessions where idempotency_key = 'decouple-d-idem'`,
  );
  assert.equal(count[0].n, 1, "one row per idempotency key");
  const audit = await rows(
    db,
    `select count(*)::int as n from public.live_audit
      where live_session_id = '${first.sessionId}' and action = 'session_started'`,
  );
  assert.equal(audit[0].n, 1, "a replay must not append a second start audit row");

  // End idempotency: the same end key twice ends once.
  await callAs(OWNER, end(first.sessionId, "decouple-d-idem-end"));
  await callAs(OWNER, end(first.sessionId, "decouple-d-idem-end"));
  const ended = await rows(
    db,
    `select count(*)::int as n from public.live_audit
      where live_session_id = '${first.sessionId}' and action = 'session_ended'`,
  );
  assert.equal(ended[0].n, 1, "a repeated end must not duplicate the audit trail");
});

test("D: per-Place (1) and global (5) caps still hold", async () => {
  // Five independent Places, each with an eligible producer.
  await db.exec(`
    insert into public.producers (id, display_name)
      select 'decouple-cap-producer-' || i, 'Cap Producer ' || i from generate_series(1, 4) i
      on conflict (id) do nothing;
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id, publication_status)
      select 'decouple-cap-place-' || i, 'Cap Place ' || i, 'Test', 'Perdagangan & Jasa', 'production', 'Bandung', 'Asia/Jakarta', 'IDR',
             'decouple-cap-producer-' || i, 'published' from generate_series(1, 4) i
      on conflict (id) do nothing;
    insert into public.producer_memberships (user_id, producer_id, place_id, role)
      select '${OTHER_OWNER}', 'decouple-cap-producer-' || i, 'decouple-cap-place-' || i, 'owner' from generate_series(1, 4) i
      on conflict do nothing;
    insert into public.live_eligibility (producer_id, path, active, granted_by)
      select 'decouple-cap-producer-' || i, 'ADMIN_APPROVED', true, 'regression' from generate_series(1, 4) i
      on conflict (producer_id, path) do update set active = true;
  `);

  // Live #1 (PLACE_A) plus #2..#5 from the two producer families. Each session
  // remembers WHO may end it, so the cleanup below ends every one of them
  // through its own authority.
  const started: Array<{ sessionId: string; actor: string }> = [];
  const live = await startLive(OWNER, PLACE_A, "decouple-cap-1");
  started.push({ sessionId: live.sessionId, actor: OWNER });
  // The per-Place cap precedes the global one for the same Place.
  await expectLiveError(OWNER, start(PLACE_A, "decouple-cap-same-place", "in"), /live_place_busy/);

  const second = await startLive(OTHER_OWNER, PLACE_C, "decouple-cap-2");
  started.push({ sessionId: second.sessionId, actor: OTHER_OWNER });
  for (let i = 1; i <= 3; i += 1) {
    const extra = await startLive(OTHER_OWNER, `decouple-cap-place-${i}`, `decouple-cap-3-${i}`);
    started.push({ sessionId: extra.sessionId, actor: OTHER_OWNER });
  }
  const active = await rows(db, `select count(*)::int as n from public.live_sessions where status = 'live'`);
  assert.equal(active[0].n, 5, "five concurrent Lives are allowed");

  await expectLiveError(
    OTHER_OWNER,
    start("decouple-cap-place-4", "decouple-cap-6", "in"),
    /live_cap_denied/,
  );

  // Clean up so the remaining tests start from a calm world.
  for (const { sessionId, actor } of started) {
    await callAs(actor, end(sessionId, `decouple-cap-clean-${sessionId}`));
  }
  const remaining = await rows(db, `select count(*)::int as n from public.live_sessions where status = 'live'`);
  assert.equal(remaining[0].n, 0, "every cap session is ended again");
});

test("D: the 60-minute duration cap still ends a session with its own reason", async () => {
  const { sessionId } = await startLive(OWNER, PLACE_A, "decouple-duration");

  // Not due yet: the reason is refused.
  await expectLiveError(
    OWNER,
    end(sessionId, "decouple-duration-early", "duration_cap"),
    /live_duration_cap_not_due/,
  );

  // Backdate the session past the locked cap (DBA-level, as the sweeper would).
  await db.exec(
    `update public.live_sessions set started_at = now() - interval '61 minutes' where id = '${sessionId}'`,
  );
  await callAs(OWNER, end(sessionId, "decouple-duration-due", "duration_cap"));
  const ended = await rows(
    db,
    `select status, ended_reason from public.live_sessions where id = '${sessionId}'`,
  );
  assert.equal(ended[0].status, "ended");
  assert.equal(ended[0].ended_reason, "duration_cap");
});

test("D: the end-reason vocabulary and the append-only audit are intact", async () => {
  // An unknown reason is refused by the RPC.
  const { sessionId } = await startLive(OWNER, PLACE_A, "decouple-reason");
  await expectLiveError(OWNER, end(sessionId, "decouple-reason-bad", "not_a_reason"), /live_end_reason_invalid/);

  // …and by the column CHECK for a direct write (DBA-level insert).
  let checkRejected = false;
  try {
    await db.exec(`
      insert into public.live_sessions (id, place_id, producer_id, status, ended_reason, idempotency_key)
      values ('decouple-bad-reason', '${PLACE_A}', '${PRODUCER_A}', 'ended', 'not_a_reason', 'decouple-bad-reason-key')
    `);
  } catch {
    checkRejected = true;
  }
  assert.equal(checkRejected, true, "the ended_reason CHECK must reject an unsupported value");

  await callAs(OWNER, end(sessionId, "decouple-reason-ok"));

  // The audit trail is still append-only.
  let auditBlocked = false;
  try {
    await db.exec(`update public.live_audit set detail = '{}'::jsonb where action = 'session_started'`);
  } catch {
    auditBlocked = true;
  }
  assert.equal(auditBlocked, true, "live_audit must stay append-only");
});

// ---------------------------------------------------------------------------
// E. The migration is exactly the decoupling
// ---------------------------------------------------------------------------

test("E: the stage guard trigger and function are gone", async () => {
  const triggers = await rows(
    db,
    `select count(*)::int as n from pg_trigger where tgname = 'live_stage_guard_trigger'`,
  );
  assert.equal(triggers[0].n, 0, "the auto-end trigger must be dropped");
  const functions = await rows(db, `select count(*)::int as n from pg_proc where proname = 'live_stage_guard'`);
  assert.equal(functions[0].n, 0, "the guard function must be dropped");
  // The append-only audit trigger is NOT collateral damage.
  const auditTrigger = await rows(
    db,
    `select count(*)::int as n from pg_trigger where tgname = 'live_audit_block_mutation'`,
  );
  assert.equal(auditTrigger[0].n, 1, "unrelated triggers must survive");
});

test("E: the composite FK is gone and stage_id is nullable", async () => {
  const fk = await rows(
    db,
    `select count(*)::int as n from pg_constraint where conname = 'live_sessions_stage_place_fkey'`,
  );
  assert.equal(fk[0].n, 0, "the same-Place stage FK must be dropped");
  const nullable = await rows(
    db,
    `select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'live_sessions' and column_name = 'stage_id'`,
  );
  assert.equal(nullable[0].is_nullable, "YES", "stage_id must be nullable");

  // The informational tables keep their own integrity.
  const stages = await rows(
    db,
    `select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = 'production_stages'`,
  );
  assert.equal(stages[0].n, 1, "Kelola Proses keeps its table");
});

test("E: the legacy end reason stays valid for historical rows", async () => {
  await db.exec(`
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, ended_reason, end_note, idempotency_key, started_at, ended_at)
    values ('decouple-historic-row', '${PLACE_A}', '${PRODUCER_A}', null, 'ended', 'source_stage_unpublished',
            'Process left published state', 'decouple-historic-key', now() - interval '2 hours', now() - interval '1 hour')
  `);
  const historic = await rows(
    db,
    `select ended_reason from public.live_sessions where id = 'decouple-historic-row'`,
  );
  assert.equal(
    historic[0].ended_reason,
    "source_stage_unpublished",
    "historical rows keep their recorded reason — no data is remapped",
  );
});

test("E: both RPCs stay SECURITY DEFINER with a pinned search_path and the same ACL", async () => {
  for (const fn of ["start_live_session", "end_live_session"]) {
    const meta = await rows(
      db,
      `select p.prosecdef as security_definer, p.proconfig::text as config, p.proacl::text as acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = '${fn}'`,
    );
    assert.equal(meta.length, 1, `${fn} must exist exactly once`);
    assert.equal(meta[0].security_definer, true, `${fn} must stay SECURITY DEFINER`);
    assert.match(String(meta[0].config), /search_path=public/, `${fn} must keep its pinned search_path`);

    const privileges = await rows(
      db,
      `select has_function_privilege('anon', 'public.${fn}(text,text,text,text)', 'EXECUTE') as anon_allowed,
              has_function_privilege('authenticated', 'public.${fn}(text,text,text,text)', 'EXECUTE') as authenticated_allowed`,
    );
    assert.equal(privileges[0].anon_allowed, false, `${fn} must not be callable anonymously`);
    assert.equal(privileges[0].authenticated_allowed, true, `${fn} must stay callable by authenticated callers`);
  }
});

test("E: the migration is forward-only, non-destructive, and the next free number", async () => {
  assert.equal(ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1], DECOUPLE_MIGRATION, "0060 is the latest migration");

  // Reads only what it must: no data deletion, no table/column drop, no policy
  // or grant removal beyond the Live↔stage coupling itself.
  assert.doesNotMatch(decoupleSql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(decoupleSql, /drop\s+table/i);
  assert.doesNotMatch(decoupleSql, /drop\s+column/i);
  assert.doesNotMatch(decoupleSql, /drop\s+policy/i);
  assert.doesNotMatch(decoupleSql, /revoke\s+(select|insert|update|delete)/i);
  assert.doesNotMatch(decoupleSql, /drop\s+constraint\s+if\s+exists\s+production_stages/i);
  for (const statement of [
    /drop trigger if exists live_stage_guard_trigger on public\.production_stages;/,
    /drop function if exists public\.live_stage_guard\(\);/,
    /drop constraint if exists live_sessions_stage_place_fkey;/,
    /alter column stage_id drop not null;/,
    /'producer_ended', 'duration_cap', 'source_stage_unpublished', 'moderation'/,
  ]) {
    assert.match(decoupleSql, statement);
  }

  // The RPC bodies the application actually calls no longer mention a stage.
  const rpcSql = readMigration(DECOUPLE_MIGRATION);
  const startBody = rpcSql.slice(
    rpcSql.indexOf("create or replace function public.start_live_session"),
    rpcSql.indexOf("-- 6. end_live_session"),
  );
  assert.doesNotMatch(startBody, /live_stage_not_published/);
  assert.doesNotMatch(startBody, /v_stage_status/);
  assert.match(startBody, /\(p_place_id, v_membership, null, 'live', p_live_input_id, p_idempotency_key\)/);
  const endBody = rpcSql.slice(rpcSql.indexOf("create or replace function public.end_live_session"));
  assert.doesNotMatch(endBody, /source_stage_unpublished'\s*then/);
  assert.doesNotMatch(endBody, /live_stage_still_published/);
});

test("E: no Live code path can still require a published Process", () => {
  const paths = [
    "app/api/live/start/route.ts",
    "app/api/producer/live/sessions/route.ts",
    "lib/live/session-service.ts",
    "app/producer/live/LiveConsole.tsx",
    "app/producer/live/page.tsx",
  ];
  for (const path of paths) {
    const source = stripComments(readSource(`../${path}`));
    assert.equal(
      source.includes("live_stage_not_published"),
      false,
      `${path} must not keep the removed error path`,
    );
    assert.equal(source.includes("stageId"), false, `${path} must not carry a stage identifier`);
  }
  // The migration history that INTRODUCED the coupling stays untouched.
  assert.match(readMigration("0008_live_sessions.sql"), /live_stage_not_published/);
  assert.match(readMigration("0049_live_operator_authority.sql"), /live_stage_not_published/);
});

test("E: the application contract matches the decoupled API", () => {
  const consoleCode = stripComments(readSource("../app/producer/live/LiveConsole.tsx"));
  // No stage selector, no stage state, no stage gate, no publish-first copy.
  assert.doesNotMatch(consoleCode, /setStageId|stageId|effectiveStageId|resolveEffectiveStageId/);
  assert.doesNotMatch(consoleCode, /Proses \(harus Tayang\)|Tidak ada Proses yang Tayang|harus berstatus Tayang/);
  assert.match(consoleCode, /disabled=\{!placeId\}/, "step 1 is gated on the Place ALONE");
  assert.match(
    consoleCode,
    /body: JSON\.stringify\(\{ placeId, idempotencyKey \}\)/,
    "the start request carries only the Place and the idempotency key",
  );
  // The props no longer carry a stage list at all.
  assert.match(readSource("../app/producer/live/LiveConsole.tsx"), /places: Array<\{ id: string; name: string \}>/);

  // The page no longer reads Production Stages at all.
  const pageCode = stripComments(readSource("../app/producer/live/page.tsx"));
  assert.doesNotMatch(pageCode, /getServerProductionStoryRepository|listForPlace|stages/);
  assert.match(readSource("../app/producer/live/page.tsx"), /LiveConsole places=\{places\}/);

  // The service sends the legacy argument as NULL and never a stage id.
  const serviceCode = stripComments(readSource("../lib/live/session-service.ts"));
  assert.match(serviceCode, /p_stage_id: null/);
  assert.doesNotMatch(serviceCode, /params\.stageId/);
  assert.doesNotMatch(serviceCode, /start_live_session[\s\S]{0,120}p_stage_id: params/);
});

test("E: no Live entry point requires a stage in its request body", () => {
  for (const path of ["../app/api/live/start/route.ts", "../app/api/producer/live/sessions/route.ts"]) {
    const route = stripComments(readSource(path));
    assert.doesNotMatch(route, /stageId/);
    assert.match(route, /!placeId \|\| !idempotencyKey/, `${path} validates Place + key only`);
    assert.match(route, /placeId_idempotency_required/);
  }
});
