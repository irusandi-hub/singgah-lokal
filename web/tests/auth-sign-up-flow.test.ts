import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { POST as signUpPost } from "../app/api/auth/sign-up/route";
import { GET as callbackGet } from "../app/auth/callback/route";

/**
 * SIGN-UP FLOW — A-01 fix + S-01/S-02 coverage that runs WITHOUT the DEV
 * project (docs/audits/LIVE_AUTH_AUDIT_v1.md, LIVE-B stage).
 *
 * What is executable here:
 *  - the sign-up route handler itself (POST) for every input-validation path,
 *    which returns BEFORE any Supabase client is constructed, so it runs with
 *    no credentials at all;
 *  - the confirmation-link destination contract (A-01): the email redirect
 *    target must be the ONLY code-exchange handler, with a sanitized `next`;
 *  - the callback route's open-redirect guard (GET) on paths that never
 *    reach the network (provider error / missing code).
 *
 * What stays NOT-RUN (needs the DEV project + its email template):
 *  - a real `auth.signUp` -> auth.users -> trigger -> public.users round trip,
 *  - the real confirmation email click exchanging a live code into a session,
 *  - the DEV template actually using {{ .ConfirmationURL }}.
 * The manual steps are written down in docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md.
 * The DB half of S-01 (trigger sync, retry, partial-failure atomicity) IS
 * covered here on a real Postgres engine in tests/auth-sign-up-db.test.ts.
 */

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const signUpRoute = read("../app/api/auth/sign-up/route.ts");
const callbackRoute = read("../app/auth/callback/route.ts");

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/auth/sign-up", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- Route execution: input validation (no Supabase client needed) ---------

test("the sign-up route rejects invalid input before touching any client", async () => {
  // Missing confirmation.
  const missing = await signUpPost(post({ name: "Budi", email: "budi@example.com", password: "rahasia-ku" }));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "fields_required" });

  // Malformed email.
  const badEmail = await signUpPost(post({ name: "Budi", email: "budi(at)example.com", password: "rahasia-ku", passwordConfirmation: "rahasia-ku" }));
  assert.equal(badEmail.status, 400);
  assert.deepEqual(await badEmail.json(), { error: "email_invalid" });

  // Mismatched confirmation.
  const mismatch = await signUpPost(post({ name: "Budi", email: "budi@example.com", password: "rahasia-ku", passwordConfirmation: "rahasia-kuda" }));
  assert.equal(mismatch.status, 400);
  assert.deepEqual(await mismatch.json(), { error: "password_mismatch" });

  // Password under the 8-character floor.
  const short = await signUpPost(post({ name: "Budi", email: "budi@example.com", password: "pendek", passwordConfirmation: "pendek" }));
  assert.equal(short.status, 400);
  assert.deepEqual(await short.json(), { error: "password_too_short" });

  // Unparseable body.
  const garbage = await signUpPost(post("{not json"));
  assert.equal(garbage.status, 400);
  assert.deepEqual(await garbage.json(), { error: "fields_required" });
});

test("role/producer_id from the client are never read or forwarded by the route", () => {
  // The route builds its input from exactly four whitelisted fields.
  assert.match(
    signUpRoute,
    /const input = \{\s*name: typeof body\.name[\s\S]*?email: typeof body\.email[\s\S]*?password: typeof body\.password[\s\S]*?passwordConfirmation: typeof body\.passwordConfirmation[\s\S]*?\};/,
  );
  assert.doesNotMatch(signUpRoute, /body\.(role|producer_id|producerId|platform_role)/);
  assert.doesNotMatch(signUpRoute, /input\.(role|producer_id|producerId|platform_role)/);
  // The only metadata passed to Supabase Auth is the display name.
  assert.match(signUpRoute, /data: \{ display_name: input\.name \}/);
});

// --- A-01: the confirmation destination -------------------------------------

test("A-01: the email confirmation destination is the existing code-exchange handler", () => {
  assert.match(
    signUpRoute,
    /emailRedirectTo: `\$\{new URL\(request\.url\)\.origin\}\/auth\/callback\?next=\/auth`/,
    "confirmation must land on /auth/callback (A-01)",
  );
  // The destination path is a real route in this app.
  assert.ok(readFileSync(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8"));
  // The handler exchanges the code and re-sanitizes `next` (internal paths
  // only) — so the fixed destination cannot open a redirect hole.
  assert.match(callbackRoute, /exchangeCodeForSession\(code\)/);
  assert.match(callbackRoute, /sanitizeReturnTo\(searchParams\.get\("next"\)\)/);
  // /auth itself is NOT a second handler (no duplicate exchange logic).
  const authForm = read("../app/auth/auth-form.tsx");
  assert.doesNotMatch(authForm, /exchangeCodeForSession/);
  assert.doesNotMatch(authForm, /searchParams\.get\("code"\)/);
});

test("A-01: a tampered external `next` never leaves the app origin", async () => {
  // Provider-error path: handled BEFORE any code exchange (no network).
  const evil = await callbackGet(
    new Request(
      "http://localhost:3000/auth/callback?error=access_denied&next=https%3A%2F%2Fevil.example%2Fsteal&provider=google",
    ),
  );
  assert.ok(evil.status >= 300 && evil.status < 400, "callback must answer with a redirect");
  const location = evil.headers.get("location");
  assert.ok(location, "callback must always redirect");
  const url = new URL(location, "http://localhost:3000");
  assert.equal(url.origin, "http://localhost:3000", "external redirect leaked");
  assert.equal(url.pathname, "/auth");
  assert.equal(url.searchParams.get("error"), "access_denied");

  // Missing-code path with a protocol-relative `next`: same guarantee.
  const missing = await callbackGet(
    new Request("http://localhost:3000/auth/callback?next=%2F%2Fevil.example"),
  );
  const missingUrl = new URL(missing.headers.get("location") ?? "", "http://localhost:3000");
  assert.equal(missingUrl.origin, "http://localhost:3000");
  assert.equal(missingUrl.pathname, "/auth");
  assert.equal(missingUrl.searchParams.get("error"), "missing_code");
});

// --- Response contract for the success path (source-locked; the live round
// --- trip is a DEV manual step) ---------------------------------------------

test("the sign-up response contract distinguishes both valid outcomes", () => {
  assert.match(signUpRoute, /created: true/);
  assert.match(signUpRoute, /authenticated: Boolean\(data\.session\)/);
  assert.match(signUpRoute, /needsEmailConfirmation: !data\.session/);
  // Server-side validation runs before any client is built (S-01 ordering).
  const validateOffset = signUpRoute.indexOf("validateSignUpInput(input)");
  const clientOffset = signUpRoute.indexOf("createSupabaseServerClient()");
  assert.ok(validateOffset > -1 && clientOffset > -1 && validateOffset < clientOffset);
});
