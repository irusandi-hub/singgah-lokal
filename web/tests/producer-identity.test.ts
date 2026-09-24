import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Producer identity regression (Authority Master: 1 akun = 1 identitas
 * Producer). Producer identity is the Supabase Auth user id of the account
 * that files the application — there is no separate Producer email,
 * password, login, or credential anywhere in the flow.
 */

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");
}

const migration = readFileSync(
  new URL("../supabase/migrations/0016_producer_applications.sql", import.meta.url),
  "utf8",
);
const applicationLib = readFileSync(new URL("../lib/producer/application.ts", import.meta.url), "utf8");
const applicationApi = readFileSync(new URL("../app/api/producer/application/route.ts", import.meta.url), "utf8");
const adminApi = readFileSync(new URL("../app/api/admin/producer-applications/route.ts", import.meta.url), "utf8");
const onboardingPage = readFileSync(new URL("../app/producer/onboarding/page.tsx", import.meta.url), "utf8");
const onboardingClient = readFileSync(
  new URL("../app/producer/onboarding/producer-application-client.tsx", import.meta.url),
  "utf8",
);
const producerSession = readFileSync(new URL("../app/api/auth/producer-session/route.ts", import.meta.url), "utf8");
const signOutRoute = readFileSync(new URL("../app/api/auth/sign-out/route.ts", import.meta.url), "utf8");

test("Producer application is keyed by user_id, unique per account, no password column", () => {
  const code = stripComments(migration);
  assert.match(code, /create table if not exists public\.producer_applications/);
  assert.match(code, /user_id uuid not null unique references public\.users \(id\)/);
  assert.match(code, /status text not null default 'pending' check \(status in \('pending', 'approved', 'rejected'\)\)/);
  // Email is an optional snapshot only — never a key, never a credential.
  assert.match(code, /contact_email text/);
  assert.doesNotMatch(code, /password/i);
  // No separate Producer auth surface: no table stores credentials.
  assert.doesNotMatch(code, /credential|secret/i);
});

test("Application RLS is fail-closed; writes happen through server-side RPCs", () => {
  const code = stripComments(migration);
  assert.match(code, /enable row level security/);
  assert.match(code, /revoke all on public\.producer_applications from anon, authenticated/);
  assert.match(code, /create or replace function public\.submit_producer_application/);
  assert.match(code, /create or replace function public\.approve_producer_application/);
  // RPCs are not callable by clients directly.
  assert.match(code, /revoke all on function public\.submit_producer_application/);
  assert.match(code, /revoke all on function public\.approve_producer_application/);
});

test("Duplicate active applications are refused by the database function", () => {
  const code = stripComments(migration);
  assert.match(code, /application_already_active/);
  assert.match(code, /status in \('pending', 'approved'\)/);
});

test("Approval activates membership for the APPLICANT user_id — no auth user creation", () => {
  const code = stripComments(migration);
  // Membership insert is keyed by the applicant resolved from the application.
  assert.match(code, /select user_id into applicant from public\.producer_applications/);
  assert.match(code, /insert into public\.producer_memberships \(user_id, producer_id, place_id, role\)/);
  assert.match(code, /on conflict \(user_id, place_id\) do update/);
  // Nothing in the approval flow touches auth users, emails, or passwords.
  assert.doesNotMatch(code, /insert into auth\.users|create user|inviteUserByEmail/i);
  assert.doesNotMatch(code, /password/i);
});

test("API derives identity from the session; client email input is ignored", () => {
  const code = stripComments(applicationApi);
  assert.match(code, /supabase\.auth\.getUser\(\)/);
  assert.match(code, /fileProducerApplication\(userData\.user\.id, userData\.user\.email/);
  // Only "note" is ever read from the request body — no email/user fields.
  assert.doesNotMatch(code, /body\.email|body\.user/);
  assert.match(code, /authentication_required/);
});

test("Application status is scoped to the caller's own account", () => {
  const code = stripComments(applicationLib);
  assert.match(code, /\.eq\("user_id", userId\)/);
  // The admin listing is a separate function used only by the admin API.
  const adminCode = stripComments(adminApi);
  assert.match(adminCode, /requirePlatformModerator\(\)/);
});

test("Onboarding binds the application to the signed-in session", () => {
  const code = stripComments(onboardingPage);
  assert.match(code, /supabase\.auth\.getUser\(\)/);
  assert.match(code, /\/auth\?returnTo=%2Fproducer%2Fonboarding/);
  // Shows the applying account's email from the session.
  assert.match(code, /user\.email \?\? "Akun SINGGAH LOKAL"/);
  // No free-form Producer email input exists on the page.
  assert.doesNotMatch(code, /type="email"/);
  assert.doesNotMatch(onboardingClient, /type="email"/);
});

test("Application submit shows success feedback only after server confirmation", () => {
  const code = stripComments(onboardingClient);
  assert.match(code, /Berhasil dikirim/);
  const okIdx = code.indexOf('"Berhasil dikirim');
  const okCheck = code.indexOf("if (!response.ok)");
  assert.ok(okCheck >= 0 && okIdx > okCheck, "success message must follow the !response.ok guard");
});

test("Producer authorization stays membership/user_id based end to end", () => {
  const code = stripComments(producerSession);
  assert.match(code, /\.eq\("user_id", userData\.user\.id\)/);
  // Logout keeps working through the single existing mechanism.
  const signOut = stripComments(signOutRoute);
  assert.match(signOut, /supabase\.auth\.signOut\(\)/);
});

test("Membership table remains the single Producer grant (existing schema unchanged)", () => {
  const base = readFileSync(new URL("../supabase/migrations/0001_visit_intent_foundation.sql", import.meta.url), "utf8");
  assert.match(base, /create table public\.producer_memberships \(/);
  assert.match(base, /user_id uuid not null references public\.users\(id\)/);
  assert.match(base, /role text not null check \(role in \('owner', 'manager', 'editor'\)\)/);
  assert.doesNotMatch(base, /password/);
});

const membershipAdminPage = readFileSync(
  new URL("../app/admin/producer-membership/page.tsx", import.meta.url),
  "utf8",
);
const applicationsManager = readFileSync(
  new URL("../app/admin/producer-membership/applications-manager.tsx", import.meta.url),
  "utf8",
);

test("Admin Center surfaces pending applications with an approve action", () => {
  const pageCode = stripComments(membershipAdminPage);
  assert.match(pageCode, /ProducerApplicationsManager/);
  assert.match(pageCode, /listAdminPlaces\(\)/);
  const managerCode = stripComments(applicationsManager);
  // The admin API (which enforces requirePlatformModerator) is the only channel.
  assert.match(managerCode, /api\/admin\/producer-applications/);
  assert.match(managerCode, /Setujui/);
  // Success feedback only after the server confirms; list refreshed after.
  assert.match(managerCode, /Berhasil menyetujui/);
  const okIdx = managerCode.indexOf("Berhasil menyetujui");
  const guardIdx = managerCode.indexOf("if (!response.ok)");
  assert.ok(guardIdx >= 0 && okIdx > guardIdx, "approval success must follow server confirmation");
});

test("Approval sends only application/place/role — never identity fields", () => {
  const managerCode = stripComments(applicationsManager);
  assert.match(managerCode, /applicationId/);
  assert.match(managerCode, /placeId/);
  // Only the POST body matters: inspect its exact construction.
  const bodyStart = managerCode.indexOf("JSON.stringify({");
  const bodyEnd = managerCode.indexOf("})", bodyStart);
  const postBody = managerCode.slice(bodyStart, bodyEnd);
  assert.match(postBody, /applicationId/);
  assert.match(postBody, /producerId/);
  assert.match(postBody, /placeId/);
  assert.match(postBody, /role/);
  assert.doesNotMatch(postBody, /email|user_id|password/i);
});
