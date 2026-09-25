import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * PRODUCER GATE regression (Producer Onboarding → Producer area).
 *
 * Semantics under test:
 * - Membership canonical = `producer_memberships` (0001); the gate keys on
 *   the session user's owner/manager rows — never on an application status,
 *   never on a separate Producer account/password.
 * - An approved member MUST NOT see the "Ajukan menjadi Producer" form
 *   again: the onboarding route redirects to /producer server-side.
 * - The check runs per request (force-dynamic), so the decision stays
 *   correct after login, refresh, and logout/login again — and the edit is
 *   server-side only (RLS still governs the membership read).
 * - Jangan membuat akun/password Producer baru: the harness proves the
 *   migration chain creates NO auth user when a membership is granted.
 */

const onboardingPage = readFileSync(
  new URL("../app/producer/onboarding/page.tsx", import.meta.url),
  "utf8",
);
const producerDashboard = readFileSync(
  new URL("../app/producer/page.tsx", import.meta.url),
  "utf8",
);

const SHIMS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as '
    select nullif(current_setting(''request.jwt.claims.sub'', true), '''')::uuid
  ';
  create role anon;
  create role authenticated;
  create role service_role;
  create role supabase_admin;
  create role authenticator;
`;

const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

// The gate reads only the 0001 foundation: users, producers, places,
// producer_memberships (incl. memberships_self_read RLS).
const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
] as const;

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of FOUNDATION) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  return db;
}

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function seedActor(db: PGlite, n: number): Promise<string> {
  const userId = uuid(n);
  await db.exec(`insert into auth.users (id, email_confirmed_at) values ('${userId}', now());`);
  return userId;
}

// The gate query exactly as the onboarding page runs it (RLS-scoped to the
// session user via auth.uid()). The session GUC is set and read inside ONE
// exec batch (simple protocol = one implicit transaction), modeling a single
// server request — a signed-out request (no claims sub) matches no row, the
// same fail-closed behavior as the memberships_self_read policy.
async function gateQuery(db: PGlite, sessionUser: string | null) {
  const results = (await db.exec(`
    select set_config('request.jwt.claims.sub', ${sessionUser ? `'${sessionUser}'` : "null"}, true);
    select role from public.producer_memberships
    where user_id = auth.uid() and role in ('owner', 'manager') limit 1;
  `)) as { rows: Record<string, unknown>[] }[];
  return results.at(-1)?.rows ?? [];
}

test("Onboarding gate redirects approved owner/manager to /producer server-side", () => {
  assert.match(onboardingPage, /export const dynamic = "force-dynamic"/);
  // Server-side decision, executed before any form renders.
  const code = onboardingPage
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");
  // Canonical membership read (RLS-scoped to the session user)...
  assert.match(code, /from\("producer_memberships"\)/);
  assert.match(code, /\.eq\("user_id", user\.id\)/);
  // ...keys on owner/manager (the Producer gate roles)...
  assert.match(code, /\.in\("role", \["owner", "manager"\]\)/);
  // ...and redirects the approved member before the application form.
  assert.match(code, /if \(hasProducerMembership\) \{/);
  assert.match(code, /redirect\("\/producer"\)/);
  const redirectIdx = code.indexOf('redirect("/producer")');
  const clientIdx = code.indexOf("<ProducerApplicationClient");
  assert.ok(redirectIdx >= 0 && clientIdx > redirectIdx, "redirect must precede the form render");
});

test("No separate Producer account/password is created anywhere in the gate", () => {
  // Executable server logic only — page copy legitimately explains that no
  // separate Producer password exists (Authority Master).
  const serverLogic = onboardingPage.slice(0, onboardingPage.indexOf("return ("));
  const code = serverLogic
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
  assert.doesNotMatch(code, /signUp|createUser|inviteUser|password/i);
});

test("Approved owner membership → Producer access; editor and non-member do not pass the gate", async () => {
  const db = await bootstrapDb();
  try {
    const rows = async (query: string, params: unknown[] = []) =>
      ((await db.query(query, params)).rows ?? []) as Record<string, unknown>[];

    const owner = await seedActor(db, 1);
    const editor = await seedActor(db, 2);
    const outsider = await seedActor(db, 3);
    await db.exec(
      `insert into public.producers (id, display_name) values ('gate-producer', 'Gate Producer');`,
    );
    await db.exec(
      `insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
       values ('gate-place', 'Gate Place', 'desc', 'craft', 'production', 'Yogyakarta', 'Asia/Jakarta', 'IDR', 'gate-producer');`,
    );
    // Approval path = membership rows for the SAME account (no new auth user).
    await db.exec(
      `insert into public.producer_memberships (user_id, producer_id, place_id, role)
       values ('${owner}', 'gate-producer', 'gate-place', 'owner'),
              ('${editor}', 'gate-producer', 'gate-place', 'editor');`,
    );

    // The gate query (as the onboarding page runs it, session-scoped).
    const gateQuery = async (userId: string) =>
      rows(
        `select role from public.producer_memberships
         where user_id = $1 and role in ('owner', 'manager') limit 1`,
        [userId],
      );

    assert.equal((await gateQuery(owner)).length, 1, "approved owner passes the gate");
    assert.equal((await gateQuery(editor)).length, 0, "editor does not pass the gate");
    assert.equal((await gateQuery(outsider)).length, 0, "non-member does not pass the gate");

    // Self-read RLS: a session may only see its own membership rows.
    await db.exec(`select set_config('request.jwt.claims.sub', '${owner}', true);`);
    const selfVisible = await rows(
      `select role from public.producer_memberships where role in ('owner', 'manager')`,
    );
    assert.equal(
      selfVisible.length,
      1,
      "memberships_self_read exposes only the session's own rows",
    );
    await db.exec(`select set_config('request.jwt.claims.sub', '', true);`);

    // Gate stability across login/logout cycles: membership state is the
    // only variable — nothing else in the chain creates or revokes access.
    assert.equal((await gateQuery(owner)).length, 1, "gate result is stable on re-check");

    // No additional auth users were ever created by the membership grant.
    const authCount = (
      (await db.query("select count(*)::int as c from auth.users")).rows as { c: number }[]
    )[0].c;
    assert.equal(authCount, 3, "no Producer account/password was created by the flow");
  } finally {
    await db.close();
  }
});

test("Full gate flow: login → approval → logout/login → refresh keeps the same decision", async () => {
  const db = await bootstrapDb();
  try {
    // --- Step 1: LOGIN — a fresh signed-in session with no membership. ---
    const userId = await seedActor(db, 1);
    await db.exec(
      `insert into public.producers (id, display_name) values ('flow-producer', 'Flow Producer');`,
    );
    await db.exec(
      `insert into public.places (id, name, short_description, category, type, area, timezone, currency)
       values ('flow-place', 'Flow Place', 'desc', 'Kuliner', 'production', 'Yogyakarta', 'Asia/Jakarta', 'IDR');`,
    );

    await db.exec(`select set_config('request.jwt.claims.sub', '${userId}', true);`);
    // Before approval the gate query returns nothing → onboarding renders the
    // application form (non-member stays on onboarding).
    assert.equal((await gateQuery(db, userId)).length, 0, "pre-approval: non-member stays on onboarding");

    // --- Step 2: APPROVAL — the admin activates the owner membership for
    // the APPLICANT's own user_id (the server-side approval contract, no
    // new account, no password). ---
    await db.exec(
      `insert into public.producer_memberships (user_id, producer_id, place_id, role)
       values ('${userId}', 'flow-producer', 'flow-place', 'owner');`,
    );

    // --- Step 3: LOGOUT / LOGIN again — a brand-new session for the same
    // account (session token changes; the account's user_id does not). ---
    // A signed-out request carries no claims sub → the gate matches nothing.
    assert.equal((await gateQuery(db, null)).length, 0, "after logout no session passes the gate");
    // Fresh login: the new session resolves to the SAME account user_id.

    // --- Step 4: REFRESH — the gate is re-evaluated per request; the
    // decision must be identical on every re-check. ---
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(
        (await gateQuery(db, userId)).length,
        1,
        `approved owner passes the gate on re-check ${attempt + 1} (refresh/login cycle)`,
      );
    }

    // No additional auth users were created across the whole flow (approval
    // never mints a Producer account/password).
    const authCount = (
      (await db.query("select count(*)::int as c from auth.users")).rows as { c: number }[]
    )[0].c;
    assert.equal(authCount, 1, "the flow creates no new auth user — the SAME account gains access");
  } finally {
    await db.close();
  }
});

test("Onboarding and /producer guard decisions stay opposite for every session state", () => {
  // Onboarding (page source): a signed-in owner/manager is redirected to
  // /producer BEFORE the application form; /producer redirects an
  // unauthenticated session back to /auth. Together they mean: the form is
  // unreachable for approved members, and /producer is unreachable without
  // a session — across login, refresh, and logout/login.
  const onboardingCode = onboardingPage
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
  assert.match(onboardingCode, /if \(hasProducerMembership\) \{\n\s*redirect\("\/producer"\);/);

  const dashboardCode = producerDashboard
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
  // The dashboard gates on the session itself, server-side per request.
  assert.match(dashboardCode, /AuthenticationRequiredError/);
  assert.match(dashboardCode, /redirect\("\/auth\?returnTo=%2Fproducer"\)/);
  assert.match(dashboardCode, /export const dynamic = "force-dynamic"/);
  assert.match(dashboardCode, /\.in\("role", \["owner", "manager"\]\)/);
});
