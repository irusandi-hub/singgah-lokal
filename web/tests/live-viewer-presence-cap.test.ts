import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * A-04 — the 100-concurrent cap counts ACTIVE PRESENCE, not a rolling
 * admission window (migration 0053).
 *
 * The audit found `admit_live_viewer` counting `live_viewers` rows with
 * `admitted_at > now() - interval '5 minutes'`. The locked limit is 100
 * CONCURRENT viewers (MASTER_LIVE_POLICY §6, §12.2 #1) and MASTER_LIVE_TECH §6
 * requires the gate to count active presence ("live_viewers ledger rows are
 * historical metadata only and never count toward the cap"), so a viewer who
 * watched longer than five minutes silently stopped counting — ~200 real
 * viewers could be counted as 100 and viewer_peak was understated.
 *
 * This suite runs the REAL migration chain on Postgres (PGlite) and proves:
 *  - the presence lease exists (`last_seen_at`, not-null, indexed) and 0053
 *    applies cleanly + re-applies as a no-op;
 *  - a LONG WATCH keeps counting: 100 viewers with fresh leases (all admitted
 *    well over five minutes ago) still block the 101st admission, while the
 *    OLD admission-window rule counts 0 of them — the exact A-04 defect;
 *  - a viewer whose lease expired STOPS counting, and an expired lease is the
 *    only thing that frees a slot (presence, fail closed);
 *  - renewal is limited to the caller's own admitted presence
 *    (`touch_live_viewer_presence`): anonymous, never-admitted and non-live
 *    callers are refused, and nobody can renew for somebody else;
 *  - repeated/concurrent-style admissions cannot exceed the cap or double-count
 *    (still serialized per session, still audited);
 *  - the effective private-channel Realtime policies evaluate the SAME lease;
 *  - the real fail-closed gate is untouched: B1 still denies every viewer and
 *    writes no ledger row.
 *
 * test/db-regression/live-viewer-presence-access.sql is the runnable DEV
 * version of the same contract (this suite executes it).
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

const CAP = 100;
const GRACE = "5 minutes";
const SESSION = "live-presence-1";

/** uuids for the synthetic viewers (valid v4-shaped uuids). */
const uuidFor = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LATEST_USER = uuidFor(101);
const NEVER_ADMITTED = uuidFor(102);
const OTHER_PRESENT = uuidFor(103);

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text unique, email_confirmed_at timestamptz, encrypted_password text, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
    -- Same shape as Supabase's auth.uid(): derived from the session JWT claims,
    -- so the DEV regression script (which sets request.jwt.claims) runs here too.
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

/** One published Place + one LIVE session (canonical server shape). */
async function seedLiveSession(db: PGlite, status = "live"): Promise<void> {
  await db.exec(`
    insert into public.producers (id, display_name)
    values ('prod-presence', 'Pengelola Presence') on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('stage-presence', 'rumah-teh-lokal', 'Tahap Presence', 'x', 0, 'published')
    on conflict (id) do nothing;
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
    values ('${SESSION}', 'rumah-teh-lokal', 'prod-presence', 'stage-presence', '${status}', 'idem-presence-1')
    on conflict (id) do nothing;
    insert into auth.users (id, email, email_confirmed_at)
    values ('${LATEST_USER}', 'baru@example.com', now()),
           ('${NEVER_ADMITTED}', 'belum@example.com', now()),
           ('${OTHER_PRESENT}', 'lain@example.com', now())
    on conflict (id) do nothing;
    insert into public.users (id) values ('${LATEST_USER}'), ('${NEVER_ADMITTED}'), ('${OTHER_PRESENT}')
    on conflict (id) do nothing;
  `);
}

/**
 * B1 (the verified-age mechanism) is deliberately absent, so the REAL gate
 * denies every admission — which would make capacity semantics untestable.
 * These capacity tests therefore stub ONLY `assert_viewer_eligible` to allow,
 * and the suite separately asserts (with the real gate restored, i.e. a fresh
 * database) that admission is still denied and writes no ledger row.
 */
async function stubEligibilityGate(db: PGlite): Promise<void> {
  await db.exec(`
    create or replace function public.assert_viewer_eligible(p_session_id text)
    returns boolean language plpgsql security definer set search_path = public as $$
    begin
      return true;
    end $$;
  `);
}

async function actAs(db: PGlite, userId: string | null): Promise<void> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "",
  ]);
}

/** `count` viewers on the ledger: admitted `admittedAgo`, last seen `seenAgo`. */
async function seedPresentViewers(
  db: PGlite,
  count: number,
  admittedAgo = "30 minutes",
  seenAgo = "1 minute",
): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at)
    select ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'penonton' || i || '@example.com', now()
    from generate_series(1, ${count}) i
    on conflict (id) do nothing;
    insert into public.users (id)
    select id from auth.users where email like 'penonton%@example.com'
    on conflict (id) do nothing;
    insert into public.live_viewers (live_session_id, user_id, admitted_at, last_seen_at)
    select '${SESSION}', u.id, now() - interval '${admittedAgo}', now() - interval '${seenAgo}'
    from auth.users u where u.email like 'penonton%@example.com'
    on conflict (live_session_id, user_id) do nothing;
  `);
}

// ---------------------------------------------------------------------------
// 1. Migration shape
// ---------------------------------------------------------------------------

test("0053 applies cleanly, is idempotent, and adds the presence lease", async () => {
  const db = await createDb();
  await db.exec(stripPgcrypto(readMigration("0053_live_viewer_presence_capacity.sql")));

  const column = await rows(
    db,
    `select is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = 'live_viewers' and column_name = 'last_seen_at'`,
  );
  assert.equal(column.length, 1, "live_viewers.last_seen_at must exist");
  assert.equal(column[0].is_nullable, "NO", "the presence lease is not nullable");
  assert.match(String(column[0].column_default), /now\(\)/);

  const index = await rows(
    db,
    `select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'live_viewers' and indexname = 'live_viewers_presence_idx'`,
  );
  assert.equal(index.length, 1, "presence counting must be index-backed");

  // The cap value and the grace value are unchanged (the locked numbers).
  const body = String(
    (
      await rows(
        db,
        `select prosrc from pg_proc where proname = 'admit_live_viewer'`,
      )
    )[0].prosrc,
  );
  assert.match(body, /v_concurrent >= 100/);
  assert.match(body, new RegExp(`interval '${GRACE}'`));
  assert.doesNotMatch(body, /admitted_at > now\(\)/, "capacity must not count the admission window");

  await db.close();
});

// ---------------------------------------------------------------------------
// 2. The A-04 defect itself: a long watch keeps counting
// ---------------------------------------------------------------------------

test("a viewer watching longer than the grace window KEEPS counting toward the cap", async () => {
  const db = await createDb();
  await seedLiveSession(db);
  await stubEligibilityGate(db);
  // 100 viewers present with fresh leases, all admitted 30 minutes ago.
  await seedPresentViewers(db, CAP, "30 minutes", "1 minute");

  const presenceCount = await rows(
    db,
    `select count(*)::int as n from public.live_viewers
      where live_session_id = '${SESSION}' and last_seen_at > now() - interval '${GRACE}'`,
  );
  const oldRuleCount = await rows(
    db,
    `select count(*)::int as n from public.live_viewers
      where live_session_id = '${SESSION}' and admitted_at > now() - interval '${GRACE}'`,
  );
  assert.equal(Number(presenceCount[0].n), CAP, "active presence counts all 100 watching viewers");
  assert.equal(
    Number(oldRuleCount[0].n),
    0,
    "the superseded admission-window rule counted NONE of them (the A-04 defect)",
  );

  // The 101st viewer is refused: the cap is enforced against real presence.
  await actAs(db, LATEST_USER);
  await assert.rejects(
    () => db.query(`select public.admit_live_viewer('${SESSION}')`),
    /live_capacity_full/,
  );

  const ledger = await rows(db, `select count(*)::int as n from public.live_viewers`);
  assert.equal(Number(ledger[0].n), CAP, "a denied admission writes no ledger row");
  // A-13 (fixed in 0056): the old in-transaction audit insert could never
  // commit — the `raise exception` rolled it back with the aborted statement —
  // so it is GONE and the denial is recorded out of band instead.
  const denialSource = String(
    (await rows(db, `select prosrc from pg_proc where proname = 'admit_live_viewer'`))[0].prosrc,
  );
  assert.doesNotMatch(
    denialSource,
    /insert into public\.live_audit/,
    "A-13: the inert in-transaction denial insert is removed",
  );
  const recorder = await rows(
    db,
    `select proname from pg_proc where proname = 'record_live_admission_denied'`,
  );
  assert.equal(recorder.length, 1, "A-13: the out-of-band recorder exists");
  const audit = await rows(
    db,
    `select detail from public.live_audit where action = 'admission_denied'`,
  );
  assert.equal(
    audit.length,
    0,
    "the RAISE leaves no row; the trusted server path records the denial separately",
  );
  // The fail-closed decision itself is unaffected: denial is still raised…
  await assert.rejects(() => db.query(`select public.admit_live_viewer('${SESSION}')`), /live_capacity_full/);
  // …and the separate, service-role recording transaction writes the row.
  await rows(db, `select public.record_live_admission_denied('${SESSION}', '${LATEST_USER}', 'capacity_full')`);
  const recorded = await rows(
    db,
    `select detail from public.live_audit where action = 'admission_denied'`,
  );
  assert.equal(recorded.length, 1, "A-13: the denial is now recorded");
  assert.equal(String((recorded[0].detail as Record<string, unknown>).reason), "capacity_full");
  // Recording never changed the decision: the cap still refuses and the ledger
  // is still at CAP.
  await assert.rejects(() => db.query(`select public.admit_live_viewer('${SESSION}')`), /live_capacity_full/);
  const ledgerAfter = await rows(db, `select count(*)::int as n from public.live_viewers`);
  assert.equal(Number(ledgerAfter[0].n), CAP, "recording the denial grants nothing");

  await db.close();
});

test("an EXPIRED presence lease frees exactly one slot (presence, fail closed)", async () => {
  const db = await createDb();
  await seedLiveSession(db);
  await stubEligibilityGate(db);
  await seedPresentViewers(db, CAP, "30 minutes", "1 minute");

  // One viewer stopped heartbeating: its lease is outside the grace window.
  await db.exec(`
    update public.live_viewers
    set last_seen_at = now() - interval '6 minutes'
    where user_id = '${uuidFor(1)}'
  `);

  await actAs(db, LATEST_USER);
  const admitted = await rows(db, `select public.admit_live_viewer('${SESSION}') as ok`);
  assert.equal(admitted[0].ok, true, "a stale presence no longer occupies the cap");

  const present = await rows(
    db,
    `select user_id from public.live_viewers
      where live_session_id = '${SESSION}' and last_seen_at > now() - interval '${GRACE}'`,
  );
  assert.equal(present.length, CAP, "still exactly 100 present (1 stale out, 1 fresh in)");

  await db.close();
});

// ---------------------------------------------------------------------------
// 3. Renewal: own presence only, live sessions only, admitted viewers only
// ---------------------------------------------------------------------------

test("touch_live_viewer_presence renews only the caller's own admitted presence", async () => {
  const db = await createDb();
  await seedLiveSession(db);
  await stubEligibilityGate(db);
  await db.exec(`
    insert into public.live_viewers (live_session_id, user_id, admitted_at, last_seen_at)
    values ('${SESSION}', '${LATEST_USER}', now() - interval '30 minutes', now() - interval '6 minutes'),
           ('${SESSION}', '${OTHER_PRESENT}', now() - interval '30 minutes', now() - interval '6 minutes')
  `);

  await actAs(db, LATEST_USER);
  const renewed = await rows(db, `select public.touch_live_viewer_presence('${SESSION}') as ok`);
  assert.equal(renewed[0].ok, true);
  const self = await rows(
    db,
    `select (last_seen_at > now() - interval '10 seconds') as fresh
       from public.live_viewers where user_id = '${LATEST_USER}'`,
  );
  assert.equal(self[0].fresh, true, "the caller's lease is renewed");
  const other = await rows(
    db,
    `select (last_seen_at > now() - interval '10 seconds') as fresh
       from public.live_viewers where user_id = '${OTHER_PRESENT}'`,
  );
  assert.equal(other[0].fresh, false, "nobody can renew somebody else's presence");

  // A caller with no admitted ledger row gets nothing (presence is never
  // granted by the heartbeat).
  await actAs(db, NEVER_ADMITTED);
  await assert.rejects(
    () => db.query(`select public.touch_live_viewer_presence('${SESSION}')`),
    /live_viewer_denied/,
  );
  const leaked = await rows(
    db,
    `select count(*)::int as n from public.live_viewers where user_id = '${NEVER_ADMITTED}'`,
  );
  assert.equal(Number(leaked[0].n), 0, "the heartbeat can never create a ledger row");

  // Anonymous callers are refused.
  await actAs(db, null);
  await assert.rejects(
    () => db.query(`select public.touch_live_viewer_presence('${SESSION}')`),
    /live_viewer_denied/,
  );

  // A session that is no longer live cannot be renewed.
  await db.exec(`update public.live_sessions set status = 'ended' where id = '${SESSION}'`);
  await actAs(db, LATEST_USER);
  await assert.rejects(
    () => db.query(`select public.touch_live_viewer_presence('${SESSION}')`),
    /live_session_not_live/,
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 4. Serialization / no over-admission, and the client heartbeat contract
// ---------------------------------------------------------------------------

test("admissions are still serialized per session and can never exceed the cap", async () => {
  const db = await createDb();
  await seedLiveSession(db);
  await stubEligibilityGate(db);
  await seedPresentViewers(db, CAP, "30 minutes", "30 seconds");

  // Three different viewers attempt admission against a full session: all are
  // refused and none is added (the advisory lock still guards check + insert).
  for (const userId of [LATEST_USER, NEVER_ADMITTED, OTHER_PRESENT]) {
    await actAs(db, userId);
    await assert.rejects(() => db.query(`select public.admit_live_viewer('${SESSION}')`), /live_capacity_full/);
  }
  const ledger = await rows(db, `select count(*)::int as n from public.live_viewers`);
  assert.equal(Number(ledger[0].n), CAP, "no admission may slip past the cap");

  const body = String(
    (await rows(db, `select prosrc from pg_proc where proname = 'admit_live_viewer'`))[0].prosrc,
  );
  assert.match(body, /perform pg_advisory_xact_lock\(/);
  assert.match(body, /hashtextextended\('live_viewer_admission_lock:' \|\| p_session_id, 0\)/);
  const lockIndex = body.indexOf("pg_advisory_xact_lock");
  const countIndex = body.indexOf("select count(*) into v_concurrent");
  const insertIndex = body.indexOf("insert into public.live_viewers");
  assert.ok(lockIndex > 0 && lockIndex < countIndex && countIndex < insertIndex);

  // Client heartbeat contract: it must renew well inside the server grace
  // window, and it must be the presence route (not a data poll).
  const typesSource = readFileSync(new URL("../lib/live/types.ts", import.meta.url), "utf8");
  const intervalMs = Number(
    (typesSource.match(/LIVE_VIEWER_PRESENCE_INTERVAL_MS = ([\d_]+)/) ?? [])[1]?.replace(/_/g, ""),
  );
  assert.ok(Number.isFinite(intervalMs), "the heartbeat interval constant must exist");
  assert.ok(
    intervalMs > 0 && intervalMs < 5 * 60 * 1000,
    "the heartbeat must fire inside the TUNABLE 5-minute grace window",
  );
  const viewerSource = readFileSync(
    new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(viewerSource, /fetch\("\/api\/live\/presence"/);
  assert.match(viewerSource, /LIVE_VIEWER_PRESENCE_INTERVAL_MS/);
  // Fail closed: a refused renewal stops the heartbeat instead of pretending.
  assert.match(viewerSource, /if \(!response\.ok && timer\) clearInterval\(timer\)/);
  const routeSource = readFileSync(new URL("../app/api/live/presence/route.ts", import.meta.url), "utf8");
  assert.match(routeSource, /touchLiveViewerPresence/);
  assert.match(routeSource, /authentication_required/);
  assert.match(routeSource, /status: 403/);
  // The route never accepts a user id from the client.
  assert.doesNotMatch(routeSource, /userId/);

  await db.close();
});

// ---------------------------------------------------------------------------
// 5. The effective Realtime gate evaluates the same lease
// ---------------------------------------------------------------------------

test("the effective private-channel policies evaluate the presence lease", async () => {
  const db = await createDb();

  const policies = await rows(
    db,
    `select policyname, cmd, qual::text as qual, with_check::text as with_check
       from pg_policies
      where schemaname = 'realtime' and tablename = 'messages'
      order by policyname`,
  );
  const receive = policies.filter((row) => row.policyname === "live_realtime_receive");
  const send = policies.filter((row) => row.policyname === "live_realtime_send");
  assert.equal(receive.length, 1, "exactly one receive policy");
  assert.equal(send.length, 1, "exactly one send policy");
  for (const row of [receive[0], send[0]]) {
    const predicate = String(row.qual ?? row.with_check);
    assert.match(predicate, /last_seen_at/);
    // Postgres renders the interval literal as '00:05:00'::interval in the
    // stored predicate — both spellings mean the same TUNABLE grace window.
    assert.match(predicate, /00:05:00|5 minutes/);
    assert.doesNotMatch(predicate, /admitted_at/, "the admission window is superseded");
    assert.match(predicate, /live_viewers/);
  }
  // The producer branch and the extension restriction survive the recreation.
  assert.match(String(send[0].qual ?? send[0].with_check), /producer_memberships/);
  assert.match(String(receive[0].qual ?? receive[0].with_check), /broadcast/);

  await db.close();
});

// ---------------------------------------------------------------------------
// 6. Fail-closed regression: B1 is untouched by 0053
// ---------------------------------------------------------------------------

test("the real gate still denies every admission and writes nothing (B1 intact)", async () => {
  const db = await createDb(); // no eligibility stub
  await seedLiveSession(db);
  await db.exec(`
    insert into public.live_viewers (live_session_id, user_id, admitted_at, last_seen_at)
    values ('${SESSION}', '${OTHER_PRESENT}', now() - interval '30 minutes', now())
  `);

  await actAs(db, LATEST_USER);
  await assert.rejects(
    () => db.query(`select public.admit_live_viewer('${SESSION}')`),
    /live_viewer_denied/,
  );
  const ledger = await rows(
    db,
    `select count(*)::int as n from public.live_viewers where user_id = '${LATEST_USER}'`,
  );
  assert.equal(Number(ledger[0].n), 0, "a denied admission writes no ledger row");

  // Presence renewal is not an admission path either: it needs an existing own
  // row, which the still-deny-all gate could not have created.
  await assert.rejects(
    () => db.query(`select public.touch_live_viewer_presence('${SESSION}')`),
    /live_viewer_denied/,
  );

  // The deny-all tail of assert_viewer_eligible is still the last statement.
  const body = readFileSync(new URL(MIGRATION_DIR + "0008_live_sessions.sql", import.meta.url), "utf8");
  assert.match(
    body,
    /-- B1 \(blocked\): verified-age mechanism is Phase 2\.1; until then deny all\.\s*raise exception 'live_viewer_denied' using errcode = 'P0001';/,
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 7. The runnable DEV script (result set of check_name / passed / detail)
// ---------------------------------------------------------------------------

test("db-regression/live-viewer-presence-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-viewer-presence-access.sql", import.meta.url),
    "utf8",
  );

  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Array<Record<string, unknown>>;
  assert.ok(checkRows.length >= 10, `expected >= 10 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );

  const leftover = await rows(db, `select 1 as one from public.live_sessions where id = 'live-presence-dev'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});
