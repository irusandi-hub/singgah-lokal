import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

import {
  CREATOR_GATE_COOKIE,
  CREATOR_GATE_MAX_AGE_SECONDS,
  signGatePayload,
  verifyGatePayload,
} from "../lib/creator/gate-crypto";

const gateLib = readFileSync(new URL("../lib/creator/gate.ts", import.meta.url), "utf8");
const gateApi = readFileSync(new URL("../app/api/creator/gate/route.ts", import.meta.url), "utf8");
const gatePage = readFileSync(new URL("../app/developer-gate/page.tsx", import.meta.url), "utf8");
const gateClient = readFileSync(
  new URL("../app/developer-gate/creator-gate-client.tsx", import.meta.url),
  "utf8",
);
const developerLayout = readFileSync(new URL("../app/developer/layout.tsx", import.meta.url), "utf8");
const heartbeat = readFileSync(
  new URL("../app/developer/creator-lease-heartbeat.tsx", import.meta.url),
  "utf8",
);
const signOutRoute = readFileSync(new URL("../app/api/auth/sign-out/route.ts", import.meta.url), "utf8");
const leaseMigration = readFileSync(
  new URL("../supabase/migrations/0015_creator_session_lease.sql", import.meta.url),
  "utf8",
);
const secretQuestionMigration = readFileSync(
  new URL("../supabase/migrations/0014_creator_secret_question.sql", import.meta.url),
  "utf8",
);
const leaseLib = readFileSync(new URL("../lib/creator/session-lease.ts", import.meta.url), "utf8");

test("Gate cookie round-trip: valid signature and binding pass", () => {
  const secret = "test-secret";
  const value = signGatePayload("gate", "user-1", Date.now(), secret);
  const result = verifyGatePayload(value, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.userId, "user-1");
});

test("Gate cookie rejects tampering, wrong secret, expiry, and missing values", () => {
  const secret = "test-secret";
  const now = 1_700_000_000_000;
  const gate = signGatePayload("gate", "user-1", now, secret);

  assert.equal(verifyGatePayload(gate, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000, now + 1000).ok, true);
  assert.equal(verifyGatePayload(`${gate}x`, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000).ok, false);
  assert.equal(verifyGatePayload(gate, "other-secret", "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000).ok, false);
  assert.equal(
    verifyGatePayload(gate, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000, now + (CREATOR_GATE_MAX_AGE_SECONDS + 60) * 1000).ok,
    false,
  );
  assert.equal(verifyGatePayload(undefined, secret, "gate", 1000).ok, false);
  assert.equal(verifyGatePayload("", secret, "gate", 1000).ok, false);
});

test("Creator gate uses one signed gate cookie and no obsolete step cookie", () => {
  assert.equal(CREATOR_GATE_COOKIE, "singgah_creator_gate");
  assert.equal(CREATOR_GATE_MAX_AGE_SECONDS, 8 * 60 * 60);
  assert.doesNotMatch(gateLib, /CREATOR_GATE_STEP|passCaptchaStep|TURNSTILE|turnstile|captcha/i);
});

test("Creator gate flow is lease-first, secret-question-only, and server-authorized", () => {
  assert.match(gateLib, /export async function passSecretQuestionStep/);
  assert.match(gateLib, /await requireCreator\(\)/);
  assert.match(gateLib, /await acquireCreatorLease\(creator\.userId\)/);
  assert.match(gateLib, /await checkAnswer\(creator\.userId, answer\.trim\(\)\)/);
  assert.match(gateLib, /store\.set\(CREATOR_GATE_COOKIE/);
  assert.match(gateLib, /result\.userId === creator\.userId/);
  assert.doesNotMatch(gateLib, /CLOUDFLARE_TURNSTILE_SECRET_KEY|NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY|cf-turnstile-response/i);

  assert.match(gateApi, /export async function GET/);
  assert.match(gateApi, /export async function POST/);
  assert.match(gateApi, /acquireCreatorLease/);
  assert.match(gateApi, /getCreatorSecretQuestion/);
  assert.match(gateApi, /checkCreatorSecretAnswer/);
  assert.match(gateApi, /creator_session_active/);
  assert.match(gateApi, /secret_question_missing/);
  assert.match(gateApi, /service_unavailable/);
  assert.match(gateApi, /step === "heartbeat"/);
  assert.doesNotMatch(gateApi, /captcha|turnstile|siteverify|NEXT_PUBLIC_CLOUDFLARE/i);
});

test("Gate UI reaches the secret question directly and always has a terminal error state", () => {
  assert.match(gatePage, /export const dynamic = "force-dynamic"/);
  assert.match(gatePage, /await requireCreator\(\)/);
  assert.match(gatePage, /await acquireCreatorLease\(\)/);
  assert.match(gatePage, /getCreatorSecretQuestion\(creatorUserId\)/);
  assert.match(gatePage, /hasValidGate/);
  assert.match(gatePage, /returnTo === "\/" \? "\/developer"/);
  assert.doesNotMatch(gatePage, /turnstile|captcha|NEXT_PUBLIC_CLOUDFLARE/i);

  assert.match(gateClient, /fetch\("\/api\/creator\/gate"/);
  assert.match(gateClient, /step: "secret-question"/);
  assert.match(gateClient, /AbortController/);
  assert.match(gateClient, /creator_session_active/);
  assert.match(gateClient, /secret_question_missing/);
  assert.match(gateClient, /state === "error"/);
  assert.doesNotMatch(gateClient, /<Script|turnstile|captcha|cf-turnstile-response|NEXT_PUBLIC_CLOUDFLARE/i);
  assert.doesNotMatch(gateClient, /answer_hash|answer_salt|SUPABASE_SERVICE_ROLE_KEY/);
});

test("Developer requests renew the lease and the browser sends heartbeats", () => {
  assert.match(developerLayout, /await acquireCreatorLease\(guard\.userId\)/);
  assert.match(developerLayout, /redirect\("\/developer-gate/);
  assert.match(developerLayout, /CreatorLeaseHeartbeat/);
  assert.match(heartbeat, /setInterval/);
  assert.match(heartbeat, /step: "heartbeat"/);
  assert.match(heartbeat, /api\/creator\/gate/);
  assert.match(heartbeat, /router\.push\("\/developer-gate"\)/);
  assert.doesNotMatch(heartbeat, /turnstile|captcha/i);
});

test("Creator sign-out releases the lease before invalidating auth", () => {
  assert.match(signOutRoute, /releaseCreatorLease\(userId\)/);
  assert.match(signOutRoute, /auth\.signOut\(\)/);
  assert.match(signOutRoute, /CREATOR_GATE_COOKIE/);
  assert.match(signOutRoute, /CreatorRequiredError/);
});

test("Developer Center keeps Creator, regular User, Producer, and Platform Admin separated", () => {
  assert.match(developerLayout, /await requireCreator\(\)/);
  assert.match(developerLayout, /Akses ditolak/);
  const executableLayout = developerLayout
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(executableLayout, /producer_memberships|platform_moderator/);
  assert.doesNotMatch(gateApi, /producer|platform_moderator/i);
});

test("Secret-question source remains the existing server-side Creator table", () => {
  assert.match(secretQuestionMigration, /create table if not exists public\.creator_secret_question/);
  assert.match(gateApi, /getCreatorSecretQuestion/);
  assert.match(gateApi, /checkCreatorSecretAnswer/);
  assert.doesNotMatch(leaseMigration, /insert\s+into\s+(auth\.users|public\.users)|create\s+(user|account)|password/i);
});

test("Creator lease schema is a singleton with one advisory-lock contract", () => {
  assert.match(leaseMigration, /slot_id\s+boolean\s+primary\s+key/);
  assert.match(leaseMigration, /creator_session_lease_single_slot\s+check\s*\(slot_id\s*=\s*true\)/);
  assert.match(
    leaseMigration,
    /create or replace function public\.acquire_creator_session_lease\([\s\S]*p_user_id uuid[\s\S]*p_expires_at timestamptz/,
  );
  assert.match(
    leaseMigration,
    /create or replace function public\.release_creator_session_lease\([\s\S]*p_user_id uuid/,
  );
  assert.equal(
    [...leaseMigration.matchAll(/pg_advisory_xact_lock\(hashtext\('creator_session_lease'\)\)/g)].length,
    2,
    "acquire and release must use the same advisory lock",
  );
  assert.doesNotMatch(leaseMigration, /create\s+(unique\s+)?index[\s\S]*where\s+expires_at\s*>\s*now\(\)/i);
  assert.doesNotMatch(leaseMigration, /where\s+expires_at\s*>\s*now\(\)/i);
  assert.match(leaseLib, /rpc\("acquire_creator_session_lease"/);
  assert.match(leaseLib, /p_user_id: userId/);
  assert.match(leaseLib, /p_expires_at: expiresAt/);
  assert.doesNotMatch(leaseLib, /\.upsert\(/);
});

test("Creator lease atomically denies an active second Creator, takes expiry, and releases safely", async () => {
  const db = new PGlite();
  const creatorA = "11111111-1111-4111-8111-111111111111";
  const creatorB = "22222222-2222-4222-8222-222222222222";
  const future = new Date(Date.now() + 60_000).toISOString();

  try {
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key);
      create table public.users (id uuid primary key references auth.users(id) on delete cascade);
      create role anon;
      create role authenticated;
      create role service_role;
    `);
    await db.exec(leaseMigration);
    await db.exec(`
      insert into auth.users (id) values
        ('${creatorA}'),
        ('${creatorB}');
      insert into public.users (id) values
        ('${creatorA}'),
        ('${creatorB}');
    `);

    const acquire = async (userId: string, expiresAt: string) => {
      const result = await db.query(
        "select public.acquire_creator_session_lease($1::uuid, $2::timestamptz) as acquired",
        [userId, expiresAt],
      );
      const rows = result.rows as Array<{ acquired: boolean }>;
      return rows[0]?.acquired === true;
    };
    const release = async (userId: string) => {
      const result = await db.query(
        "select public.release_creator_session_lease($1::uuid) as released",
        [userId],
      );
      const rows = result.rows as Array<{ released: boolean }>;
      return rows[0]?.released === true;
    };

    assert.equal(await acquire(creatorA, future), true);
    assert.equal(await acquire(creatorA, future), true, "the active Creator remains unaffected");
    assert.equal(await acquire(creatorB, future), false, "an active Creator cannot be displaced");

    const activeRow = await db.query(
      "select user_id, expires_at from public.creator_session_lease where slot_id = true",
    );
    const activeRows = activeRow.rows as Array<{ user_id: string; expires_at: string | null }>;
    assert.equal(activeRows.length, 1, "the table must remain a singleton");
    assert.equal(activeRows[0]?.user_id, creatorA);

    await db.exec(`
      update public.creator_session_lease
         set expires_at = clock_timestamp() - interval '1 second',
             updated_at = clock_timestamp()
       where slot_id = true;
    `);
    assert.equal(await acquire(creatorB, future), true, "an expired lease may be claimed");

    assert.equal(await release(creatorA), false, "the old owner cannot release the new owner's lease");
    assert.equal(await release(creatorB), true);
    assert.equal(await release(creatorB), false, "repeated release is a safe no-op");

    const releasedRow = await db.query(
      "select user_id, expires_at from public.creator_session_lease where slot_id = true",
    );
    const releasedRows = releasedRow.rows as Array<{ user_id: string | null; expires_at: string | null }>;
    assert.equal(releasedRows.length, 1);
    assert.equal(releasedRows[0]?.user_id, null);
    assert.equal(releasedRows[0]?.expires_at, null);
  } finally {
    await db.close();
  }
});
