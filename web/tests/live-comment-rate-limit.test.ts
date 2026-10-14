import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Regression: comment rate limiting (Handoff §8 item 3, tech §6).
 *
 * A-09 (migration 0054): the window used to live in server-process memory, so on
 * any multi-instance/serverless deployment it could be bypassed by spreading
 * requests across instances. The canonical window now lives in the SHARED store
 * (`public.live_comment_rate_limits`) and is claimed atomically inside
 * `post_live_comment`, which MASTER_LIVE_TECH §6 explicitly allows ("in-RPC
 * window check … TUNABLE mechanism").
 *
 * Locked contract:
 *   1. Enforcement is server-side only (service layer + DB RPC, "server-only").
 *   2. Scope is per viewer AND per session (composite key) — viewers never
 *      bleed into each other's windows.
 *   3. A second comment inside the TUNABLE ~1/5s window is rejected BEFORE the
 *      window is (re)filled — denied attempts do not extend the window.
 *   4. Denial paths (auth, session, moderation, admission, rate limit) all
 *      return before the Realtime broadcast — every server-delivered comment
 *      has passed the limiter, so client-side bypass is impossible.
 *   5. The limiter keeps NO process memory, and the store has ZERO client
 *      access, so the window is identical across instances and cannot be
 *      tampered with from a client.
 */

const serviceSource = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../app/api/live/comments/route.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../lib/live/types.ts", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("../app/live/[sessionId]/LiveViewerClient.tsx", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../supabase/migrations/0054_live_comment_rate_limit.sql", import.meta.url),
  "utf8",
);

/** The TUNABLE window, in seconds, as the TypeScript mirror declares it. */
const WINDOW_SECONDS = Number(
  (typesSource.match(/LIVE_COMMENT_MIN_INTERVAL_MS = ([\d_]+)/) ?? [])[1]?.replace(/_/g, ""),
) / 1000;

test("Rate limit 1: enforcement is server-side only and fail-closed", () => {
  assert.match(serviceSource, /import "server-only";/);
  // The route maps the rejection to a 400 and never falls through open.
  assert.match(routeSource, /error instanceof LiveValidationError/);
  assert.match(routeSource, /status: 400/);
  // The service maps the DB rejection to the same error code the UI shows.
  assert.match(serviceSource, /live_comment_rate_limited/);
  assert.match(serviceSource, /LiveValidationError\("live_comment_rate_limited"\)/);
  // The viewer surfaces the rejection message.
  assert.match(viewerSource, /live_comment_rate_limited/);
});

test("Rate limit 2: scope is per viewer AND per session, actor server-derived", () => {
  // Composite key in the shared store: a different viewer or session never
  // shares a window.
  assert.match(
    migration,
    /primary key \(live_session_id, user_id\)/,
  );
  assert.match(
    migration,
    /on conflict \(live_session_id, user_id\) do update/,
  );
  // The RPC takes only the session id: the viewer is derived server-side.
  const signature = migration.slice(migration.indexOf("create or replace function public.post_live_comment"));
  assert.match(signature, /p_session_id text, p_body text/);
  assert.doesNotMatch(signature, /p_user_id/);
  assert.match(signature, /values \(p_session_id, auth\.uid\(\), now\(\)\)/);
});

test("Rate limit 3: a second comment inside the window is rejected before refill", () => {
  // The conditional UPDATE only writes when the previous accepted comment is
  // already outside the window, so a denied attempt cannot extend it.
  assert.match(
    migration,
    /where public\.live_comment_rate_limits\.last_comment_at <= now\(\) - interval '5 seconds'/,
  );
  assert.match(migration, /if not found then\s*raise exception 'live_comment_rate_limited' using errcode = 'P0001';/);
  // The TUNABLE mirror in TypeScript cannot drift from the DB window.
  assert.equal(WINDOW_SECONDS, 5, "LIVE_COMMENT_MIN_INTERVAL_MS must mirror the DB window");
  assert.match(migration, new RegExp(`interval '${WINDOW_SECONDS} seconds'`));
  assert.match(typesSource, /LIVE_COMMENT_MIN_INTERVAL_MS = 5000/);
});

test("Rate limit 4: every denial path returns before the broadcast (no bypass)", () => {
  // Order: auth -> session gate -> moderation -> admission -> rate-limited
  // post -> broadcast. Every earlier gate returns early on denial.
  const authOffset = routeSource.indexOf("auth.getUser()");
  const sessionOffset = routeSource.indexOf('session.status !== "live"');
  const moderationOffset = routeSource.indexOf("moderateLiveComment(");
  const admitOffset = routeSource.indexOf("admitLiveViewer(");
  const postOffset = routeSource.indexOf("postLiveComment(");
  const sendOffset = routeSource.indexOf("channel.send(");
  for (const [label, offset] of [
    ["auth", authOffset],
    ["session", sessionOffset],
    ["moderation", moderationOffset],
    ["admission", admitOffset],
    ["post (rate limit)", postOffset],
  ] as Array<[string, number]>) {
    assert.ok(offset > -1, `${label} gate must exist`);
    assert.ok(offset < sendOffset, `${label} gate must precede the broadcast`);
  }
  assert.ok(authOffset < sessionOffset && sessionOffset < moderationOffset);
  assert.ok(moderationOffset < admitOffset && admitOffset < postOffset);
  assert.match(routeSource, /return NextResponse\.json\(\{ error: "live_comment_rejected" \}, \{ status: 400 \}\)/);
  assert.match(routeSource, /error: "live_comments_unavailable"/);
});

test("Rate limit 5: the limiter keeps no process memory (cross-instance identical)", () => {
  // The old in-process Map is gone: nothing in the service module holds request
  // state between calls, so spreading requests over instances cannot bypass the
  // window — the state is the shared database row.
  assert.doesNotMatch(serviceSource, /new Map\(/);
  assert.doesNotMatch(serviceSource, /commentTimestamps/);
  assert.doesNotMatch(serviceSource, /enforceCommentRateLimit/);
  assert.match(serviceSource, /live_comment_rate_limits/);
  // And the store itself is unreachable from every client role.
  assert.match(migration, /alter table public\.live_comment_rate_limits enable row level security;/);
  assert.match(migration, /revoke all on public\.live_comment_rate_limits from public, anon, authenticated;/);
  assert.doesNotMatch(migration, /create policy/);
  assert.doesNotMatch(migration, /grant [^;]* to (anon|authenticated|public)/);
  for (const action of ["select", "insert", "update", "delete"]) {
    assert.equal(
      migration.includes(`grant ${action}`) && /grant [^;]* to (anon|authenticated)/.test(migration),
      false,
      `no ${action} grant may reach a client role`,
    );
  }
});

// ---------------------------------------------------------------------------
// Executable proof on Postgres (PGlite): the shared store really is the gate
// ---------------------------------------------------------------------------

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

const SESSION = "live-rate-1";
const OTHER_SESSION = "live-rate-2";
const VIEWER = "ccccccc1-0000-4000-8000-000000000001";
const OTHER_VIEWER = "ccccccc1-0000-4000-8000-000000000002";

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

/** Fixtures + a stubbed eligibility gate (B1 denies all, so the limiter would be unreachable). */
async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${VIEWER}', 'komentator@example.com', now()),
      ('${OTHER_VIEWER}', 'lain@example.com', now())
    on conflict (id) do nothing;
    insert into public.users (id) values ('${VIEWER}'), ('${OTHER_VIEWER}') on conflict (id) do nothing;
    insert into public.producers (id, display_name) values ('prod-rate', 'Pengelola Rate') on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('stage-rate', 'rumah-teh-lokal', 'Tahap Rate', 'x', 0, 'published'),
           ('stage-rate-2', 'kopi-dari-kebun', 'Tahap Rate 2', 'x', 0, 'published')
    on conflict (id) do nothing;
    -- One session per Place (the locked per-Place cap of 1), so the two
    -- sessions used for the per-session isolation check sit on different Places.
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
    values ('${SESSION}', 'rumah-teh-lokal', 'prod-rate', 'stage-rate', 'live', 'rate-key-1'),
           ('${OTHER_SESSION}', 'kopi-dari-kebun', 'prod-rate', 'stage-rate-2', 'live', 'rate-key-2')
    on conflict (id) do nothing;
    -- Only the admission gate is stubbed: the limiter itself stays the real one.
    create or replace function public.assert_viewer_eligible(p_session_id text)
      returns boolean language plpgsql security definer set search_path = public as $$ begin return true; end $$;
  `);
}

async function actAs(db: PGlite, userId: string): Promise<void> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
}

const comment = async (db: PGlite, session: string, body = "halo") =>
  rows(db, `select public.post_live_comment('${session}', '${body}') as ok`);

test("the DB window rejects a second comment and frees the slot after 5 seconds", async () => {
  const db = await createDb();
  await seed(db);
  await actAs(db, VIEWER);

  const first = await comment(db, SESSION);
  assert.equal(first[0].ok !== null, true, "the first comment is accepted");

  await assert.rejects(() => comment(db, SESSION), /live_comment_rate_limited/);

  // A denied attempt must not extend the window: backdate the stored stamp past
  // the window and the next comment is accepted immediately.
  await db.exec(`
    update public.live_comment_rate_limits
    set last_comment_at = now() - interval '6 seconds'
    where live_session_id = '${SESSION}' and user_id = '${VIEWER}'
  `);
  const afterWindow = await comment(db, SESSION);
  assert.equal(afterWindow[0].ok !== null, true, "outside the window the comment is accepted again");

  // The stored row never contains comment text (ephemeral comments).
  const stored = await rows(db, `select * from public.live_comment_rate_limits`);
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0]).sort(), ["last_comment_at", "live_session_id", "user_id"]);

  await db.close();
});

test("the window is per viewer AND per session (no bleed, no shared slot)", async () => {
  const db = await createDb();
  await seed(db);

  await actAs(db, VIEWER);
  await comment(db, SESSION);
  await assert.rejects(() => comment(db, SESSION), /live_comment_rate_limited/);

  // Another viewer on the same session is unaffected.
  await actAs(db, OTHER_VIEWER);
  const otherViewer = await comment(db, SESSION);
  assert.equal(otherViewer[0].ok !== null, true, "a different viewer has its own window");

  // The same viewer on another session is unaffected.
  await actAs(db, VIEWER);
  const otherSession = await comment(db, OTHER_SESSION);
  assert.equal(otherSession[0].ok !== null, true, "a different session has its own window");

  const stored = await rows(
    db,
    `select live_session_id, user_id from public.live_comment_rate_limits order by user_id, live_session_id`,
  );
  assert.equal(stored.length, 3, "one claim row per (session, viewer)");

  await db.close();
});

test("an over-length body is rejected without consuming the window", async () => {
  const db = await createDb();
  await seed(db);
  await actAs(db, VIEWER);

  await assert.rejects(
    () => comment(db, SESSION, "x".repeat(301)),
    /live_comment_too_long/,
  );
  const stored = await rows(db, `select count(*)::int as n from public.live_comment_rate_limits`);
  assert.equal(Number(stored[0].n), 0, "a rejected body must not claim a slot");
  const accepted = await comment(db, SESSION);
  assert.equal(accepted[0].ok !== null, true);

  await db.close();
});

test("client roles cannot read or write the shared rate-limit store", async () => {
  const db = await createDb();
  await seed(db);
  await actAs(db, VIEWER);
  await comment(db, SESSION);

  for (const role of ["anon", "authenticated"]) {
    for (const query of [
      "select * from public.live_comment_rate_limits",
      "insert into public.live_comment_rate_limits (live_session_id, user_id, last_comment_at) values ('live-rate-1', 'ccccccc1-0000-4000-8000-000000000001', now())",
      "update public.live_comment_rate_limits set last_comment_at = now() - interval '1 hour'",
      "delete from public.live_comment_rate_limits",
    ]) {
      await db.exec(`set role ${role};`);
      await assert.rejects(
        () => db.query(query),
        (error: Error) => {
          assert.match(String(error.message), /permission denied|row-level security/i, `${role}: ${query}`);
          return true;
        },
        `${role} must be refused: ${query}`,
      );
      await db.exec("reset role;");
    }
  }

  await db.close();
});

test("db-regression/live-comment-rate-limit-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/live-comment-rate-limit-access.sql", import.meta.url),
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

  const leftover = await rows(db, `select 1 as one from public.live_sessions where id = 'live-rate-dev'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});

test("the real gate still denies comments for every viewer (B1 intact)", async () => {
  const db = await createDb(); // no stub
  await seed(db);
  // Restore the real deny-all gate from 0008.
  const realGate = readMigration("0008_live_sessions.sql");
  const start = realGate.indexOf("create or replace function public.assert_viewer_eligible");
  const end = realGate.indexOf("$$;", realGate.indexOf("B1 (blocked)")) + 3;
  await db.exec(stripPgcrypto(realGate.slice(start, end)));
  await actAs(db, VIEWER);
  await assert.rejects(
    () => comment(db, SESSION),
    /live_viewer_denied/,
  );
  const stored = await rows(db, `select count(*)::int as n from public.live_comment_rate_limits`);
  assert.equal(Number(stored[0].n), 0, "a denied comment claims no slot");

  await db.close();
});
