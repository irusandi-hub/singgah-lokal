import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  CREATOR_GATE_COOKIE,
  CREATOR_GATE_MAX_AGE_SECONDS,
  CREATOR_GATE_STEP_COOKIE,
  CREATOR_GATE_STEP_MAX_AGE_SECONDS,
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

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

test("Gate cookie round-trip: valid signature and binding pass", () => {
  const secret = "test-secret";
  const value = signGatePayload("gate", "user-1", Date.now(), secret);
  const result = verifyGatePayload(value, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.userId, "user-1");
});

test("Gate cookie rejects tampering, wrong secret, wrong purpose, and expiry", () => {
  const secret = "test-secret";
  const now = 1_700_000_000_000;
  const gate = signGatePayload("gate", "user-1", now, secret);
  const step = signGatePayload("step", "user-1", now, secret);

  assert.equal(verifyGatePayload(gate, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000, now + 1000).ok, true);
  // Tampered payload
  assert.equal(verifyGatePayload(`${gate}x`, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000).ok, false);
  // Wrong secret
  assert.equal(verifyGatePayload(gate, "other-secret", "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000).ok, false);
  // Step cookie must never satisfy the gate purpose
  assert.equal(verifyGatePayload(step, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000, now + 1000).ok, false);
  // Expired
  assert.equal(
    verifyGatePayload(gate, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000, now + (CREATOR_GATE_MAX_AGE_SECONDS + 60) * 1000).ok,
    false,
  );
  // Missing/empty
  assert.equal(verifyGatePayload(undefined, secret, "gate", 1000).ok, false);
  assert.equal(verifyGatePayload("", secret, "gate", 1000).ok, false);
});

test("Gate constants: cookie names and TTLs are server-defined", () => {
  assert.equal(CREATOR_GATE_COOKIE, "singgah_creator_gate");
  assert.equal(CREATOR_GATE_STEP_COOKIE, "singh_creator_gate_step".replace("singh", "singgah"));
  assert.equal(CREATOR_GATE_MAX_AGE_SECONDS, 8 * 60 * 60);
  assert.equal(CREATOR_GATE_STEP_MAX_AGE_SECONDS, 5 * 60);
});

test("CAPTCHA is verified server-side and fails closed without configuration", () => {
  const code = stripComments(gateLib);
  assert.match(code, /CLOUDFLARE_TURNSTILE_SECRET_KEY/);
  assert.match(code, /siteverify/);
  assert.match(code, /success === true/);
  // Fail-closed: missing secret => false, regardless of token.
  assert.match(code, /if \(!secret \|\| !token\) return false;/);
  assert.match(code, /catch \{\s*return false;/);
  // Turnstile secret is never NEXT_PUBLIC and never serialized into a response.
  assert.doesNotMatch(code, /NEXT_PUBLIC[^\\n]*TURNSTILE_SECRET/);
});

test("Both gate steps re-verify requireCreator before anything else", () => {
  for (const name of ["passCaptchaStep", "passSecretQuestionStep"]) {
    const fn = gateLib.slice(gateLib.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /await requireCreator\(\)/, `${name} must verify Creator first`);
  }
});

test("Secret question step reuses the existing hash verification", () => {
  const code = stripComments(gateLib);
  assert.match(code, /checkAnswer: \(userId: string, answer: string\) => Promise<boolean>/);
  assert.match(code, /await checkAnswer\(creator\.userId, answer\)/);
  // Step cookie is required and consumed after success (no replay).
  assert.match(code, /CREATOR_GATE_STEP_MAX_AGE_SECONDS \* 1000/);
  assert.match(code, /store\.delete\(CREATOR_GATE_STEP_COOKIE\)/);
});

test("Gate API never exposes hash, salt, or answer material", () => {
  const apiCode = stripComments(gateApi);
  assert.doesNotMatch(apiCode, /answer_hash|answer_salt/);
  // Wrong answer and unset question are indistinguishable failures.
  assert.match(apiCode, /Verifikasi gagal\. Coba lagi\./);
  assert.match(apiCode, /requireCreator\(\)/);
  assert.match(apiCode, /creator_required/);
});

test("Gate page is Creator-only, returnTo-sanitized, and session-verified", () => {
  assert.match(gatePage, /export const dynamic = "force-dynamic"/);
  assert.match(gatePage, /await requireCreator\(\)/);
  assert.match(gatePage, /sanitizeReturnTo/);
  assert.match(gatePage, /hasValidGate/);
  assert.match(gatePage, /redirect\("\/auth\?returnTo=%2Fdeveloper-gate"\)/);
});

test("Developer Center enforces the gate server-side on every request", () => {
  assert.match(developerLayout, /hasValidGate/);
  assert.match(developerLayout, /redirect\(`\/developer-gate\?returnTo=/);
  // The check sits behind Creator authorization, never instead of it.
  const layoutCode = stripComments(developerLayout);
  assert.match(layoutCode, /guard\.kind === "authorized" && !guard\.gateValid/);
});

test("Gate check is bound to the signed-in Creator's user id, not signature alone", () => {
  const gateLibCode = stripComments(gateLib);
  // hasValidGate takes the current Creator's id and compares it with the
  // cookie payload's bound userId after signature/expiry/purpose checks.
  assert.match(gateLibCode, /hasValidGate\(userId: string\)/);
  assert.match(gateLibCode, /if \(!userId\) return false;/);
  assert.match(gateLibCode, /verification\.ok && verification\.userId === userId/);
  // Layout and gate page pass the requireCreator()-resolved id.
  const layoutCode = stripComments(developerLayout);
  assert.match(layoutCode, /hasValidGate\(creator\.userId\)/);
  const pageCode = stripComments(gatePage);
  assert.match(pageCode, /hasValidGate\(creatorId\)/);
  // The gate route lives OUTSIDE the developer layout directory (no loop):
  // the old nested route must not exist anymore.
  assert.equal(existsSync(new URL("../app/developer/gate/page.tsx", import.meta.url)), false);
});

test("Turnstile token comes from the official widget form data, not a hand-made input", () => {
  const clientCode = stripComments(gateClient);
  // Token is read from the submitted form data of the official widget input.
  assert.match(clientCode, /FormData\(event\.currentTarget\)/);
  assert.match(clientCode, /formData\.get\("cf-turnstile-response"\)/);
  // No synthetic hidden input pretending to hold the token.
  assert.doesNotMatch(clientCode, /type="hidden"/);
  assert.doesNotMatch(clientCode, /getElementById/);
});

test("Gate client holds no verification logic or secret material", () => {
  const clientCode = stripComments(gateClient);
  // Only the public site key is read client-side; naming the missing secret
  // variable in the fail-closed help text is allowed (never its value).
  assert.match(clientCode, /NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY/);
  assert.doesNotMatch(clientCode, /process\.env\.(?!NEXT_PUBLIC_)/);
  assert.doesNotMatch(clientCode, /answer_hash|answer_salt/);
  // The client posts the token/answer and lets the server decide.
  assert.match(clientCode, /api\/creator\/gate/);
  assert.doesNotMatch(clientCode, /timingSafeEqual|createHmac/);
});

// ---------------------------------------------------------------------------
// PAKET 5 — Single Active Creator Session + step-cookie user binding
// ---------------------------------------------------------------------------

const leaseLib = readFileSync(new URL("../lib/creator/session-lease.ts", import.meta.url), "utf8");
const signOutRoute = readFileSync(new URL("../app/api/auth/sign-out/route.ts", import.meta.url), "utf8");
const leaseMigration = readFileSync(
  new URL("../supabase/migrations/0015_creator_session_lease.sql", import.meta.url),
  "utf8",
);

test("Gate steps run the single-active-session check BEFORE any verification", () => {
  const code = stripComments(gateLib);
  // Order: lease check → acquire → only then Turnstile siteverify.
  const captchaFn = gateLib.slice(gateLib.indexOf("export async function passCaptchaStep"));
  const captchaBody = captchaFn.slice(0, captchaFn.indexOf("\n}"));
  const checkIdx = captchaBody.indexOf("checkLeaseBeforeGateSteps(creator.userId)");
  const acquireIdx = captchaBody.indexOf("acquireCreatorLease(creator.userId)");
  const siteverifyIdx = captchaBody.indexOf("verifyTurnstileToken");
  assert.ok(checkIdx >= 0, "captcha step must check the lease first");
  assert.ok(acquireIdx > checkIdx, "acquire must follow the lease check");
  assert.ok(siteverifyIdx > acquireIdx, "siteverify must run only after the slot is acquired");
  // A concurrent race loser must never get the step cookie.
  assert.match(captchaBody, /acquired\.state !== "mine"/);
});

test("Captcha and secret steps re-check the lease and refuse when held by another Creator", () => {
  const code = stripComments(gateLib);
  assert.match(code, /creator_session_active/);
  const secretFn = gateLib.slice(gateLib.indexOf("export async function passSecretQuestionStep"));
  const secretBody = secretFn.slice(0, secretFn.indexOf("\n}"));
  assert.match(secretBody, /checkLeaseBeforeGateSteps\(creator\.userId\)/);
});

test("Secret question step is bound to the step cookie's Creator (A's step cannot serve B)", () => {
  const secretFn = gateLib.slice(gateLib.indexOf("export async function passSecretQuestionStep"));
  const secretBody = secretFn.slice(0, secretFn.indexOf("\n}"));
  assert.match(
    secretBody,
    /!stepVerification\.ok \|\| stepVerification\.userId !== creator\.userId/,
    "step cookie minted for Creator A must be rejected for Creator B",
  );
  // checkAnswer runs only after the binding check.
  const bindingIdx = secretBody.indexOf("stepVerification.userId !== creator.userId");
  const checkAnswerIdx = secretBody.indexOf("await checkAnswer(");
  assert.ok(bindingIdx >= 0 && checkAnswerIdx > bindingIdx, "checkAnswer must run after the binding check");
});

test("Lease status reveals only a masked identifier of the active holder", () => {
  const code = stripComments(leaseLib);
  assert.match(code, /maskedId/);
  assert.match(code, /function maskUserId/);
  assert.match(code, /userId\.slice\(0, 4\)/);
  assert.match(code, /userId\.slice\(-4\)/);
  // Never the raw id/email in the shared status shape.
  assert.doesNotMatch(code, /state: "held-by-other";[^}]*email/);
});

test("Lease is atomic: database unique index is the point of serialization", () => {
  // Partial unique index: only one live (unexpired) row can exist; concurrent
  // acquires race on it and Postgres picks exactly one winner per instant.
  assert.match(leaseMigration, /create unique index/i);
  assert.match(leaseMigration, /where expires_at > now\(\)/);
  // Acquisition is a single upsert; ownership is decided by an authoritative re-read.
  const code = stripComments(leaseLib);
  assert.match(code, /\.upsert\(/);
  assert.match(code, /onConflict: "user_id"/);
  assert.match(code, /getCreatorLeaseStatus\(userId\)/);
});

test("Lease expiry frees the slot; release uses the advisory-lock RPC on sign-out", () => {
  assert.match(leaseMigration, /release_creator_session_lease/);
  assert.match(leaseMigration, /pg_advisory_xact_lock/);
  const code = stripComments(leaseLib);
  assert.match(code, /releaseCreatorLease/);
  assert.match(code, /rpc\("release_creator_session_lease"/);
  // Expiry is enforced on read too (expired rows never count as active).
  assert.match(code, /new Date\(data\.expires_at\)\.getTime\(\) > Date\.now\(\)/);
});

test("Sign-out releases the lease only for the Creator account", () => {
  const code = stripComments(signOutRoute);
  // Read the account BEFORE auth teardown, release AFTER signOut.
  assert.match(code, /isCreatorEmail\(email\)/);
  assert.match(code, /releaseCreatorLease\(userId\)/);
  const signOutIdx = code.indexOf("await supabase.auth.signOut()");
  const releaseIdx = code.indexOf("releaseCreatorLease(userId)");
  assert.ok(signOutIdx >= 0 && releaseIdx > signOutIdx, "lease release must follow auth sign-out");
});

test("Lease failures are fail-closed and never bypass the gate", () => {
  const code = stripComments(gateLib);
  assert.match(code, /lease_unavailable/);
  assert.match(code, /catch \{[\s\S]*?lease_unavailable/);
});

test("Non-Creator accounts never touch the lease (requireCreator runs first everywhere)", () => {
  for (const fn of ["passCaptchaStep", "passSecretQuestionStep"]) {
    const body = gateLib.slice(gateLib.indexOf(`export async function ${fn}`));
    const fnBody = body.slice(0, body.indexOf("\n}"));
    const creatorIdx = fnBody.indexOf("await requireCreator()");
    const leaseIdx = fnBody.indexOf("checkLeaseBeforeGateSteps");
    assert.ok(creatorIdx >= 0 && leaseIdx > creatorIdx, `${fn}: requireCreator must precede lease logic`);
  }
});
