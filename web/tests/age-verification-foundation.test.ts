import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

import {
  AGE_VERIFICATION_PROVIDER_ENV,
  getAgeVerificationProvider,
  registeredAgeVerificationProviders,
  type AgeVerificationProvider,
} from "../lib/age-verification/provider";
import {
  ageVerificationStatusFor,
  requestAgeVerification,
  verifyAgeVerificationCallback,
} from "../lib/age-verification/core";

/**
 * Age-verification foundation (migration 0055) — provider-neutral, FAIL-CLOSED,
 * and deliberately NOT wired into the Live viewer gate.
 *
 * What this suite locks:
 *   * no vendor exists: the registry is empty, no selection → null, an unknown
 *     selection → null, and `provider_not_configured` is the answer with NOTHING
 *     written (never a verified row);
 *   * the age facts are minimal: one boolean "meets the minimum age" plus
 *     timestamps — no age number, no date of birth, no document, no biometrics;
 *   * a callback must be authenticated by the provider, its event id is applied
 *     at most once (anti-replay), and an unknown reference is never created;
 *   * clients can neither write nor escalate a status, and cannot read another
 *     account's row;
 *   * the internal check is exact: verified + minimum_age_confirmed + not expired
 *     + not revoked;
 *   * THE POINT OF THE STAGE: even a FULLY VALID verified row does not let a
 *     viewer in — `assert_viewer_eligible`/`admit_live_viewer` still deny every
 *     viewer, because nothing is wired yet.
 *
 * The mock provider exists ONLY in this test file and is passed straight into
 * the pure core; production resolves providers exclusively from the registry in
 * lib/age-verification/provider.ts, so no test double is reachable from DEV or
 * production code.
 */

const providerSource = readFileSync(new URL("../lib/age-verification/provider.ts", import.meta.url), "utf8");
const coreSource = readFileSync(new URL("../lib/age-verification/core.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../lib/age-verification/service.ts", import.meta.url), "utf8");
const startRouteSource = readFileSync(
  new URL("../app/api/live/age-verification/start/route.ts", import.meta.url),
  "utf8",
);
const callbackRouteSource = readFileSync(
  new URL("../app/api/live/age-verification/callback/route.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../supabase/migrations/0055_age_verification_foundation.sql", import.meta.url),
  "utf8",
);

/** Comments explain why something is NOT there — assertions must see code only. */
const stripJsComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
/**
 * SQL as EXECUTED: line comments and `comment on …` documentation removed, so
 * an assertion about what the schema does is not defeated by prose that explains
 * what it deliberately does NOT do.
 */
const stripSqlDoc = (source: string): string =>
  source
    .replace(/comment on [\s\S]*?;/gim, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

// ---------------------------------------------------------------------------
// 1. Provider neutrality: nothing is configured, nothing is reachable
// ---------------------------------------------------------------------------

test("no provider is registered: every entry point fails closed with provider_not_configured", async () => {
  const previous = process.env[AGE_VERIFICATION_PROVIDER_ENV];
  try {
    delete process.env[AGE_VERIFICATION_PROVIDER_ENV];
    assert.equal(getAgeVerificationProvider(), null, "unset selection → no provider");
    assert.deepEqual(registeredAgeVerificationProviders(), [], "the registry must be EMPTY");

    // An unregistered id is not a provider either (no fallback, no default).
    process.env[AGE_VERIFICATION_PROVIDER_ENV] = "some-vendor";
    assert.equal(getAgeVerificationProvider(), null, "unknown id → no provider");

    const start = await requestAgeVerification(null, { userId: "u-1" });
    assert.equal(start.status, "provider_not_configured");
    const callback = await verifyAgeVerificationCallback(null, { rawBody: "{}", headers: {} });
    assert.equal(callback.status, "provider_not_configured");
  } finally {
    if (previous === undefined) delete process.env[AGE_VERIFICATION_PROVIDER_ENV];
    else process.env[AGE_VERIFICATION_PROVIDER_ENV] = previous;
  }

  // The registry can only be populated by editing this file — there is no
  // registration API for any other module (including tests) to call.
  assert.match(providerSource, /const PROVIDERS: Readonly<Record<string, AgeVerificationProvider>> = Object\.freeze\(\{\}\);/);
  assert.doesNotMatch(providerSource, /registerAgeVerificationProvider/);
  for (const source of [providerSource, coreSource, serviceSource, startRouteSource, callbackRouteSource]) {
    assert.doesNotMatch(stripJsComments(source), /mock|fake|stub|test-double|vitest|jest/i, "no test double may be reachable");
  }
  // The production routes go through the server-only service, which resolves the
  // provider from the registry — never from a request value.
  assert.match(startRouteSource, /from "@\/lib\/age-verification\/service"/);
  assert.match(callbackRouteSource, /from "@\/lib\/age-verification\/service"/);
  // No secret and no vendor key is read anywhere in the foundation.
  for (const source of [providerSource, coreSource, serviceSource, startRouteSource, callbackRouteSource]) {
    assert.doesNotMatch(source, /api[_-]?key|client[_-]?secret|api[_-]?secret/i);
  }
});

test("the age facts are minimal: one boolean + timestamps, never an age or a DOB", () => {
  // The interface carries exactly the minimum-age boolean and timestamps…
  assert.match(providerSource, /minimumAgeConfirmed: boolean/);
  assert.match(providerSource, /verifiedAt: string \| null/);
  assert.match(providerSource, /expiresAt: string \| null/);
  // …and no number-of-years/date-of-birth/document/biometric input or output.
  for (const source of [providerSource, coreSource]) {
    const code = stripJsComments(source);
    assert.doesNotMatch(code, /dateOfBirth|date_of_birth|birthDate/i);
    assert.doesNotMatch(code, /documentNumber|document_number|selfie|biometric/i);
    assert.doesNotMatch(code, /ageYears|age_years|numericAge/i);
  }
  // The migration's table stores the same minimal shape.
  const migrationSql = stripSqlDoc(migration);
  assert.match(migrationSql, /minimum_age_confirmed\s+boolean not null default false/);
  assert.doesNotMatch(migrationSql, /date_of_birth|document_number|selfie|biometric/i);
  assert.match(migration, /grant select on public\.age_verifications to authenticated;/);
  assert.doesNotMatch(migration, /grant [^;]* to anon/);
});

test("a result is 'verified' only with the minimum-age fact AND an assertion time", () => {
  const base = {
    eventId: "evt-1",
    eventType: "verification.completed",
    providerRef: "ref-1",
  };
  assert.equal(
    ageVerificationStatusFor({ ...base, minimumAgeConfirmed: true, verifiedAt: "2026-10-12T00:00:00.000Z", expiresAt: null }),
    "verified",
  );
  // A claimed verification without the assertion time is a failure.
  assert.equal(
    ageVerificationStatusFor({ ...base, minimumAgeConfirmed: true, verifiedAt: null, expiresAt: null }),
    "failed",
  );
  // A subject that does NOT meet the minimum age is a failure, even when the
  // provider reports a timestamp.
  assert.equal(
    ageVerificationStatusFor({ ...base, minimumAgeConfirmed: false, verifiedAt: "2026-10-12T00:00:00.000Z", expiresAt: null }),
    "failed",
  );
});

// ---------------------------------------------------------------------------
// 2. Core decisions with an isolated mock (test-file only)
// ---------------------------------------------------------------------------

const mockProvider = (overrides: Partial<AgeVerificationProvider> = {}): AgeVerificationProvider => ({
  id: "mock-provider",
  createVerification: async () => ({ providerRef: "ref-mock-1", redirectUrl: "https://example.test/verify" }),
  handleCallback: async () => null,
  ...overrides,
});

test("start/callback decisions are fail-closed with a provider present", async () => {
  // provider cannot start → provider_unavailable (never a fake success).
  const unavailable = await requestAgeVerification(
    mockProvider({ createVerification: async () => null }),
    { userId: "u-1" },
  );
  assert.equal(unavailable.status, "provider_unavailable");

  const started = await requestAgeVerification(mockProvider(), { userId: "u-1" });
  assert.deepEqual(started, {
    status: "started",
    providerRef: "ref-mock-1",
    redirectUrl: "https://example.test/verify",
  });

  // An unauthenticated callback is a denial → nothing is applied.
  const badSignature = await verifyAgeVerificationCallback(mockProvider(), { rawBody: "{}", headers: {} });
  assert.equal(badSignature.status, "invalid_signature");

  const authentic = await verifyAgeVerificationCallback(
    mockProvider({
      handleCallback: async () => ({
        eventId: "evt-9",
        eventType: "verification.completed",
        providerRef: "ref-mock-1",
        minimumAgeConfirmed: true,
        verifiedAt: "2026-10-12T00:00:00.000Z",
        expiresAt: null,
      }),
    }),
    { rawBody: "{}", headers: { "x-signature": "valid" } },
  );
  assert.equal(authentic.status, "authentic");
  if (authentic.status === "authentic") {
    assert.equal(ageVerificationStatusFor(authentic.callback), "verified");
  }
});

// ---------------------------------------------------------------------------
// 3. Storage: clients cannot write, cannot escalate, cannot see others
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
  "0055_age_verification_foundation.sql",
];

const ADULT = "eeeeeee1-0000-4000-8000-000000000001";
const OTHER = "eeeeeee1-0000-4000-8000-000000000002";
const SESSION = "live-age-1";

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
    -- Supabase's service_role has BYPASSRLS: server infrastructure is not
    -- subject to row policies (it is still bound by column/table privileges).
    alter role service_role bypassrls;
    grant usage on schema auth to authenticated;

    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
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

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${ADULT}', 'dewasa@example.com', now()),
      ('${OTHER}', 'lain@example.com', now())
    on conflict (id) do nothing;
    insert into public.users (id) values ('${ADULT}'), ('${OTHER}') on conflict (id) do nothing;
    insert into public.producers (id, display_name) values ('prod-age', 'Pengelola Age') on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('stage-age', 'rumah-teh-lokal', 'Tahap Age', 'x', 0, 'published') on conflict (id) do nothing;
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
    values ('${SESSION}', 'rumah-teh-lokal', 'prod-age', 'stage-age', 'live', 'age-key-1')
    on conflict (id) do nothing;
  `);
}

async function actAs(db: PGlite, userId: string | null): Promise<void> {
  await db.exec("set role authenticated;");
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    userId ? JSON.stringify({ sub: userId, role: "authenticated" }) : "",
  ]);
}

test("0055 applies cleanly, is idempotent, and exposes only the self-read policy", async () => {
  const db = await createDb();
  await db.exec(stripPgcrypto(readMigration("0055_age_verification_foundation.sql")));

  const columns = await rows(
    db,
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'age_verifications' order by column_name`,
  );
  assert.deepEqual(
    columns.map((row) => row.column_name),
    [
      "created_at",
      "expires_at",
      "minimum_age_confirmed",
      "provider_ref",
      "status",
      "updated_at",
      "user_id",
      "verified_at",
    ],
    "the verification row stores the minimal result shape only",
  );

  for (const [table, expected] of [
    ["age_verifications", 1],
    ["age_verification_events", 0],
  ] as Array<[string, number]>) {
    assert.equal(
      (await rows(db, `select relrowsecurity as on from pg_class where oid = 'public.${table}'::regclass`))[0].on,
      true,
      `${table} must have RLS enabled`,
    );
    const policies = await rows(
      db,
      `select policyname, cmd from pg_policies where schemaname = 'public' and tablename = '${table}'`,
    );
    assert.equal(policies.length, expected, `${table} policy count`);
  }
  const policy = await rows(
    db,
    `select qual::text as qual from pg_policies
      where schemaname = 'public' and tablename = 'age_verifications' and policyname = 'age_verifications_self_read'`,
  );
  assert.match(String(policy[0].qual), /user_id = auth\.uid\(\)/);

  await db.close();
});

test("clients cannot write or escalate age verification, and see only their own row", async () => {
  const db = await createDb();
  await seed(db);
  // A valid row for OTHER exists server-side.
  await db.exec(`
    insert into public.age_verifications (user_id, status, provider_ref, minimum_age_confirmed, verified_at)
    values ('${OTHER}', 'verified', 'ref-other', true, now())
  `);

  await actAs(db, ADULT);

  // No INSERT / UPDATE / DELETE for a signed-in account — a client can never
  // create a verification nor promote its own status.
  await assert.rejects(
    () =>
      db.query(
        `insert into public.age_verifications (user_id, status, provider_ref, minimum_age_confirmed, verified_at)
         values ('${ADULT}', 'verified', 'ref-forged', true, now())`,
      ),
    /permission denied|row-level security/i,
  );
  await assert.rejects(
    () => db.query(`update public.age_verifications set status = 'verified', minimum_age_confirmed = true where user_id = '${ADULT}'`),
    /permission denied|row-level security/i,
  );
  await assert.rejects(
    () => db.query(`delete from public.age_verifications`),
    /permission denied|row-level security/i,
  );
  // The event ledger is unreachable for clients entirely.
  await assert.rejects(
    () => db.query(`select * from public.age_verification_events`),
    /permission denied|row-level security/i,
  );
  await assert.rejects(
    () => db.query(`insert into public.age_verification_events (event_id, provider, event_type) values ('e1', 'p', 't')`),
    /permission denied|row-level security/i,
  );

  // Self-read only: the caller's own row (none yet) and never another account's.
  const visible = await rows(db, `select user_id from public.age_verifications`);
  assert.deepEqual(visible, [], "no other account's verification is readable");
  await db.exec("reset role;");
  await db.exec(`
    insert into public.age_verifications (user_id, status, provider_ref, minimum_age_confirmed, verified_at)
    values ('${ADULT}', 'pending', 'ref-self', false, null)
  `);
  await actAs(db, ADULT);
  const self = await rows(db, `select user_id, status from public.age_verifications`);
  assert.deepEqual(self, [{ user_id: ADULT, status: "pending" }]);
  await db.exec("reset role;");

  // Anonymous callers hold nothing at all.
  await db.exec("set role anon;");
  await assert.rejects(
    () => db.query(`select * from public.age_verifications`),
    /permission denied|row-level security/i,
  );
  await db.exec("reset role;");

  await db.close();
});

test("only the service role can record events and apply results", async () => {
  const db = await createDb();
  await seed(db);

  const functions: Array<[string, string]> = [
    ["public.age_verification_satisfied(uuid)", "satisfied"],
    ["public.record_age_verification_event(text,text,text)", "record"],
    ["public.apply_age_verification_result(text,uuid,text,text,boolean,timestamptz,timestamptz)", "apply"],
  ];
  for (const [signature, label] of functions) {
    for (const role of ["public", "anon", "authenticated"]) {
      assert.equal(
        Boolean((await rows(db, `select has_function_privilege('${role}', '${signature}', 'EXECUTE') as ok`))[0].ok),
        false,
        `${label}: ${role} must not hold EXECUTE`,
      );
    }
    assert.equal(
      Boolean((await rows(db, `select has_function_privilege('service_role', '${signature}', 'EXECUTE') as ok`))[0].ok),
      true,
      `${label}: service_role must hold EXECUTE`,
    );
  }

  await db.close();
});

test("the webhook event ledger rejects replays and cannot be forged twice", async () => {
  const db = await createDb();
  await seed(db);

  await db.exec("set role service_role;");
  const first = await rows(
    db,
    `select public.record_age_verification_event('evt-100', 'vendor-x', 'verification.completed') as ok`,
  );
  const replay = await rows(
    db,
    `select public.record_age_verification_event('evt-100', 'vendor-x', 'verification.completed') as ok`,
  );
  await db.exec("reset role;");
  assert.equal(first[0].ok, true, "the first delivery is recorded");
  assert.equal(replay[0].ok, false, "a replayed event id is refused");

  // Applying a result marks the event processed exactly once.
  await db.exec("set role service_role;");
  await db.query(
    `select public.apply_age_verification_result('evt-100', '${ADULT}', 'verified', 'ref-100', true, now(), null)`,
  );
  await db.exec("reset role;");
  const processed = await rows(
    db,
    `select processed_at is not null as done from public.age_verification_events where event_id = 'evt-100'`,
  );
  assert.equal(processed[0].done, true);

  // Invalid events are refused outright.
  await db.exec("set role service_role;");
  await assert.rejects(
    () => db.query(`select public.record_age_verification_event('', 'vendor-x', 'verification.completed')`),
    /age_verification_event_invalid/,
  );
  await db.exec("reset role;");

  await db.close();
});

test("apply_age_verification_result enforces the proof invariants", async () => {
  const db = await createDb();
  await seed(db);
  await db.exec("set role service_role;");

  // 'verified' without the minimum-age fact or without an assertion time.
  await assert.rejects(
    () => db.query(`select public.apply_age_verification_result(null, '${ADULT}', 'verified', 'ref-1', false, now(), null)`),
    /age_verification_proof_incomplete/,
  );
  await assert.rejects(
    () => db.query(`select public.apply_age_verification_result(null, '${ADULT}', 'verified', 'ref-1', true, null, null)`),
    /age_verification_proof_incomplete/,
  );
  // The minimum-age fact cannot ride along with a non-verified status.
  await assert.rejects(
    () => db.query(`select public.apply_age_verification_result(null, '${ADULT}', 'failed', 'ref-1', true, now(), null)`),
    /age_verification_fact_without_verified_status/,
  );
  // A non-pending status needs the opaque provider reference.
  await assert.rejects(
    () => db.query(`select public.apply_age_verification_result(null, '${ADULT}', 'failed', null, false, null, null)`),
    /age_verification_provider_ref_required/,
  );
  // An unknown status is refused.
  await assert.rejects(
    () => db.query(`select public.apply_age_verification_result(null, '${ADULT}', 'approved', 'ref-1', false, null, null)`),
    /age_verification_status_invalid/,
  );
  // A valid result is accepted.
  await db.query(
    `select public.apply_age_verification_result(null, '${ADULT}', 'verified', 'ref-ok', true, now(), now() + interval '1 year')`,
  );
  const stored = await rows(db, `select status, minimum_age_confirmed from public.age_verifications where user_id = '${ADULT}'`);
  assert.deepEqual(stored, [{ status: "verified", minimum_age_confirmed: true }]);

  await db.exec("reset role;");
  await db.close();
});

test("age_verification_satisfied is exact: verified + confirmed + not expired + not revoked", async () => {
  const db = await createDb();
  await seed(db);

  const satisfied = async (userId: string): Promise<boolean> => {
    await db.exec("set role service_role;");
    const result = await rows(db, `select public.age_verification_satisfied('${userId}') as ok`);
    await db.exec("reset role;");
    return Boolean(result[0].ok);
  };

  // No row at all.
  assert.equal(await satisfied(ADULT), false);

  await db.query(
    `select public.apply_age_verification_result(null, '${ADULT}', 'pending', 'ref-p', false, null, null)`,
  );
  assert.equal(await satisfied(ADULT), false, "pending is not satisfied");

  await db.exec("set role service_role;");
  await db.query(
    `select public.apply_age_verification_result(null, '${ADULT}', 'verified', 'ref-v', true, now(), null)`,
  );
  await db.exec("reset role;");
  assert.equal(await satisfied(ADULT), true, "verified without expiry is satisfied");

  // Expired.
  await db.exec("set role service_role;");
  await db.query(
    `select public.apply_age_verification_result(null, '${ADULT}', 'verified', 'ref-v', true, now() - interval '2 years', now() - interval '1 day')`,
  );
  await db.exec("reset role;");
  assert.equal(await satisfied(ADULT), false, "an expired verification is not satisfied");

  // Revoked.
  await db.exec("set role service_role;");
  await db.query(
    `select public.apply_age_verification_result(null, '${ADULT}', 'revoked', 'ref-v', false, null, null)`,
  );
  await db.exec("reset role;");
  assert.equal(await satisfied(ADULT), false, "a revoked verification is not satisfied");

  // Failed.
  await db.exec("set role service_role;");
  await db.query(`select public.apply_age_verification_result(null, '${ADULT}', 'failed', 'ref-f', false, null, null)`);
  await db.exec("reset role;");
  assert.equal(await satisfied(ADULT), false, "a failed verification is not satisfied");

  await db.close();
});

// ---------------------------------------------------------------------------
// 4. THE POINT OF THE STAGE: the Live gate is untouched and still denies all
// ---------------------------------------------------------------------------

test("a fully valid verified age result still does NOT open the Live viewer gate", async () => {
  const db = await createDb();
  await seed(db);

  // Best case for the viewer: confirmed email (fixture) + a currently valid
  // verified minimum-age result + a live session on a published Place.
  await db.exec("set role service_role;");
  await db.query(
    `select public.apply_age_verification_result(null, '${ADULT}', 'verified', 'ref-valid', true, now(), now() + interval '1 year')`,
  );
  await db.exec("reset role;");
  assert.equal(
    (
      await rows(
        db,
        `select public.age_verification_satisfied('${ADULT}') as ok`,
      )
    )[0].ok,
    true,
    "the foundation row itself is valid (so the next assertions are meaningful)",
  );

  await actAs(db, ADULT);
  await assert.rejects(
    () => db.query(`select public.admit_live_viewer('${SESSION}')`),
    /live_viewer_denied/,
    "admission must still be denied — nothing is wired to the age foundation",
  );
  await assert.rejects(
    () => db.query(`select public.post_live_comment('${SESSION}', 'halo')`),
    /live_viewer_denied/,
    "comments use the same untouched gate",
  );
  await assert.rejects(
    () => db.query(`select public.submit_live_report('${SESSION}', 'other', null, null)`),
    /live_viewer_denied/,
    "reports use the same untouched gate",
  );
  await db.exec("reset role;");
  const viewers = await rows(db, `select count(*)::int as n from public.live_viewers`);
  assert.equal(Number(viewers[0].n), 0, "a denied viewer leaves no ledger row");

  // Structural proof of the seam: the gate body never mentions the age
  // foundation, in the migration or in the resulting function.
  const gateBody = String((await rows(db, `select prosrc from pg_proc where proname = 'assert_viewer_eligible'`))[0].prosrc);
  assert.doesNotMatch(gateBody, /age_verification/);
  assert.match(gateBody, /raise exception 'live_viewer_denied' using errcode = 'P0001';/);
  assert.doesNotMatch(stripSqlDoc(migration), /assert_viewer_eligible/);
  assert.doesNotMatch(stripSqlDoc(migration), /admit_live_viewer/);
  // And nothing in the application code calls the internal check yet.
  for (const path of [
    "../lib/live/session-service.ts",
    "../lib/live/session-service-cap.ts",
    "../lib/age-verification/service.ts",
  ]) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /age_verification_satisfied/);
  }

  await db.close();
});

// ---------------------------------------------------------------------------
// 5. The runnable DEV script (result set of check_name / passed / detail)
// ---------------------------------------------------------------------------

test("db-regression/age-verification-access.sql passes every check and rolls back", async () => {
  const db = await createDb();
  const script = readFileSync(
    new URL("./db-regression/age-verification-access.sql", import.meta.url),
    "utf8",
  );

  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Array<Record<string, unknown>>;
  assert.ok(checkRows.length >= 15, `expected >= 15 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );

  const leftover = await rows(db, `select 1 as one from public.age_verifications where provider_ref = 'ref-age-dev'`);
  assert.equal(leftover.length, 0, "the script must roll back its fixtures");

  await db.close();
});
