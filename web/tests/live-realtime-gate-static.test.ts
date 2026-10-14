import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * S-04 / S-05 — the eligibility gate on the Realtime JOIN and on the comment
 * BROADCAST.
 *
 * S-04 (MEDIUM): "assert_viewer_eligible benar-benar dijalankan untuk join
 * Realtime dan broadcast komentar (bukan hanya diuji statis)".
 * S-05 (LOW): "Perilaku rate limit & delivery broadcast di bawah beban belum
 * diukur di runtime".
 *
 * What runs here (RAN-PASSED):
 *  - the admission gate really runs for every participation path: the RPCs are
 *    the only write path, they all call assert_viewer_eligible, and an
 *    anonymous/unverified/admitted-less caller is refused AT CALL TIME on the
 *    real engine;
 *  - the private-channel RLS policies really decide join (receive) and broadcast
 *    (send): evaluated on Postgres with the realtime topic GUC, a session with
 *    no admitted presence sees NOTHING and cannot publish, an admitted viewer
 *    with a fresh presence lease sees the broadcast and can publish, and a stale
 *    lease or an ended session is refused;
 *  - the client never joins before admission and never falls back to polling.
 *
 * What is NOT-RUN here (needs the DEV Realtime runtime): an actual websocket
 * join/receive round trip and broadcast delivery under load. The manual steps
 * live in docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md §10 and must not be
 * reported as passed until executed there.
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
  "0009_live_realtime_private_channels.sql",
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
  "0054_live_comment_rate_limit.sql",
];

const SESSION = "live-gate-1";
const TOPIC = `live_session:${SESSION}`;
const VIEWER = "ddddddd1-0000-4000-8000-000000000001";
const STRANGER = "ddddddd1-0000-4000-8000-000000000002";

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

const viewerClient = readFileSync(
  new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url),
  "utf8",
);
const commentsRoute = readFileSync(new URL("../app/api/live/comments/route.ts", import.meta.url), "utf8");

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
    grant usage on schema public to anon, authenticated, service_role;

    create schema if not exists realtime;
    create table realtime.messages (id bigserial primary key, topic text, extension text, event text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated;
    -- Supabase's Realtime grants: authenticated may read and publish on
    -- realtime.messages; the RLS policies are the gate.
    grant select, insert on realtime.messages to authenticated;
    grant usage on sequence realtime.messages_id_seq to authenticated;
    create function realtime.topic() returns text language sql stable as 'select current_setting(''realtime.topic'', true)';
    create function realtime.send(p_payload jsonb, p_event text, p_topic text, p_private boolean default true)
      returns void language plpgsql as $$ begin insert into realtime.messages (topic, extension, event, payload) values (p_topic, 'broadcast', p_event, p_payload); end; $$;

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
    insert into auth.users (id, email, email_confirmed_at) values
      ('${VIEWER}', 'penonton@example.com', now()),
      ('${STRANGER}', 'asing@example.com', now())
    on conflict (id) do nothing;
    insert into public.users (id) values ('${VIEWER}'), ('${STRANGER}') on conflict (id) do nothing;
    insert into public.producers (id, display_name) values ('prod-gate', 'Pengelola Gate') on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('stage-gate', 'rumah-teh-lokal', 'Tahap Gate', 'x', 0, 'published') on conflict (id) do nothing;
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
    values ('${SESSION}', 'rumah-teh-lokal', 'prod-gate', 'stage-gate', 'live', 'gate-key-1')
    on conflict (id) do nothing;
  `);
}

async function asViewer(db: PGlite, userId: string, topic = TOPIC): Promise<void> {
  await db.exec("set role authenticated;");
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
  await db.query(`select set_config('realtime.topic', $1, false)`, [topic]);
}

async function resetRole(db: PGlite): Promise<void> {
  await db.exec("reset role;");
}

// ---------------------------------------------------------------------------
// S-04 — the gate on participation RPCs (call time, real engine)
// ---------------------------------------------------------------------------

test("S-04: every participation RPC runs the fail-closed gate and refuses anonymous callers", async () => {
  const db = await createDb();
  await seed(db);

  // Anonymous callers hold no EXECUTE at all (0008/0013) — the first layer.
  for (const call of [
    `select public.admit_live_viewer('${SESSION}')`,
    `select public.post_live_comment('${SESSION}', 'halo')`,
    `select public.submit_live_report('${SESSION}', 'other', null, null)`,
  ]) {
    await db.exec("set role anon;");
    await assert.rejects(
      () => db.query(call),
      (error: Error) => {
        assert.match(String(error.message), /permission denied/i, call);
        return true;
      },
      `anon must be refused: ${call}`,
    );
    await resetRole(db);
  }

  // A signed-in viewer with a confirmed email is still refused, because the
  // admission gate is deny-all while the verified-age mechanism is absent (B1),
  // and it is the SAME gate on every path.
  await asViewer(db, VIEWER);
  for (const call of [
    `select public.admit_live_viewer('${SESSION}')`,
    `select public.post_live_comment('${SESSION}', 'halo')`,
    `select public.submit_live_report('${SESSION}', 'other', null, null)`,
  ]) {
    await assert.rejects(
      () => db.query(call),
      /live_viewer_denied/,
      `${call} must run the B1 gate`,
    );
  }
  await resetRole(db);
  const viewers = await rows(db, `select count(*)::int as n from public.live_viewers`);
  assert.equal(Number(viewers[0].n), 0, "no participation is recorded for a denied caller");

  await db.close();
});

test("S-04: an expired presence lease or an unconfirmed email loses the gate", async () => {
  const db = await createDb();
  await seed(db);

  // The gate reads the AUTHORITATIVE email state, not a client boolean.
  await db.exec(`update auth.users set email_confirmed_at = null where id = '${VIEWER}'`);
  await asViewer(db, VIEWER);
  await assert.rejects(
    () => db.query(`select public.post_live_comment('${SESSION}', 'halo')`),
    /live_viewer_denied/,
  );
  await resetRole(db);

  // Back to confirmed: the gate's remaining reason is still B1 (deny-all),
  // proving the age requirement is not bypassed by a confirmed email.
  await db.exec(`update auth.users set email_confirmed_at = now() where id = '${VIEWER}'`);
  await asViewer(db, VIEWER);
  await assert.rejects(
    () => db.query(`select public.post_live_comment('${SESSION}', 'halo')`),
    /live_viewer_denied/,
  );
  await resetRole(db);

  await db.close();
});

// ---------------------------------------------------------------------------
// S-04 — the Realtime join/broadcast gate itself (RLS evaluated on Postgres)
// ---------------------------------------------------------------------------

test("S-04: the private channel refuses join and publish without admitted presence", async () => {
  const db = await createDb();
  await seed(db);
  // One broadcast already on the topic (written by the server).
  await db.exec(`
    insert into realtime.messages (topic, extension, event, payload)
    values ('${TOPIC}', 'broadcast', 'comment', '{"body":"hai"}'::jsonb)
  `);

  // (a) A signed-in stranger with no admission receives NOTHING and cannot publish.
  await asViewer(db, STRANGER);
  const visible = await rows(db, `select count(*)::int as n from realtime.messages`);
  assert.equal(Number(visible[0].n), 0, "join without admitted presence sees no broadcast");
  await assert.rejects(
    () =>
      db.query(
        `insert into realtime.messages (topic, extension, event, payload) values ('${TOPIC}', 'broadcast', 'comment', '{"body":"spam"}'::jsonb)`,
      ),
    (error: Error) => {
      assert.match(String(error.message), /row-level security|permission denied/i);
      return true;
    },
    "publish without admitted presence must be refused",
  );
  await resetRole(db);

  // (b) An admitted viewer with a FRESH presence lease joins and publishes.
  await db.exec(`
    insert into public.live_viewers (live_session_id, user_id, admitted_at, last_seen_at)
    values ('${SESSION}', '${VIEWER}', now(), now())
  `);
  await asViewer(db, VIEWER);
  const joined = await rows(db, `select count(*)::int as n from realtime.messages`);
  assert.equal(Number(joined[0].n), 1, "an admitted viewer with fresh presence receives the broadcast");
  await db.query(
    `insert into realtime.messages (topic, extension, event, payload) values ('${TOPIC}', 'broadcast', 'comment', '{"body":"siap"}'::jsonb)`,
  );
  await resetRole(db);

  // (c) The same viewer with an EXPIRED lease loses both (presence, fail closed).
  await db.exec(`
    update public.live_viewers
    set last_seen_at = now() - interval '6 minutes'
    where live_session_id = '${SESSION}' and user_id = '${VIEWER}'
  `);
  await asViewer(db, VIEWER);
  const afterExpiry = await rows(db, `select count(*)::int as n from realtime.messages`);
  assert.equal(Number(afterExpiry[0].n), 0, "an expired lease loses the join");
  await assert.rejects(
    () =>
      db.query(
        `insert into realtime.messages (topic, extension, event, payload) values ('${TOPIC}', 'broadcast', 'comment', '{"body":"x"}'::jsonb)`,
      ),
    /row-level security|permission denied/i,
  );
  await resetRole(db);

  // (d) A topic other than the session's own is never reachable.
  await asViewer(db, VIEWER, "live_session:somebody-else");
  const otherTopic = await rows(db, `select count(*)::int as n from realtime.messages`);
  assert.equal(Number(otherTopic[0].n), 0, "no broadcast leaks across session topics");
  await resetRole(db);

  await db.close();
});

test("S-04: an ended session closes the publish path even with a fresh lease", async () => {
  const db = await createDb();
  await seed(db);
  await db.exec(`
    insert into public.live_viewers (live_session_id, user_id, admitted_at, last_seen_at)
    values ('${SESSION}', '${VIEWER}', now(), now());
    update public.live_sessions set status = 'ended' where id = '${SESSION}';
  `);

  await asViewer(db, VIEWER);
  await assert.rejects(
    () =>
      db.query(
        `insert into realtime.messages (topic, extension, event, payload) values ('${TOPIC}', 'broadcast', 'comment', '{"body":"x"}'::jsonb)`,
      ),
    /row-level security|permission denied/i,
    "the send policy requires a live session",
  );
  await resetRole(db);

  await db.close();
});

// ---------------------------------------------------------------------------
// S-05 — client-side contract: no join before admission, no polling fallback
// ---------------------------------------------------------------------------

test("S-05: the client joins only after admission and never polls as a fallback", () => {
  // The realtime effect returns early until the server has admitted the viewer.
  const realtimeEffect = viewerClient.slice(
    viewerClient.indexOf("useEffect(() => {"),
    viewerClient.indexOf("channel.subscribe("),
  );
  assert.match(realtimeEffect, /if \(!admitted\) return;/);
  // The join is private and carries the caller's own token; a failure tears the
  // channels down instead of degrading to a public channel or a poll.
  assert.match(viewerClient, /config: \{ private: true, broadcast: \{ self: false \} \}/);
  assert.match(viewerClient, /status === "CHANNEL_ERROR"/);
  assert.match(viewerClient, /removeAllChannels\(\)/);
  assert.doesNotMatch(viewerClient, /postgres_changes/);
  assert.doesNotMatch(viewerClient, /setInterval[\s\S]{0,300}\/api\/live\/comments/);
  // The server, not the client, decides whether a comment is broadcast: the
  // only publish path runs after admission + the gated comment RPC.
  const admitIndex = commentsRoute.indexOf("admitLiveViewer(");
  const postIndex = commentsRoute.indexOf("postLiveComment(");
  const sendIndex = commentsRoute.indexOf("channel.send(");
  assert.ok(admitIndex > -1 && admitIndex < postIndex && postIndex < sendIndex);
});

test("S-05: the DEV-only Realtime runtime checks are documented, not claimed", () => {
  const checklist = readFileSync(
    new URL("../../docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md", import.meta.url),
    "utf8",
  );
  // The runtime join/broadcast round trip and the load behaviour are manual
  // DEV steps; they must appear in the runbook and must not be asserted here.
  assert.match(checklist, /S-04/);
  assert.match(checklist, /S-05/);
  assert.match(checklist, /NOT-RUN/);
});
