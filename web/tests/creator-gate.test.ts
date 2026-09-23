import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

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
const gatePage = readFileSync(new URL("../app/developer/gate/page.tsx", import.meta.url), "utf8");
const gateClient = readFileSync(
  new URL("../app/developer/gate/creator-gate-client.tsx", import.meta.url),
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
  assert.match(gatePage, /redirect\("\/auth\?returnTo=%2Fdeveloper%2Fgate"\)/);
});

test("Developer Center enforces the gate server-side on every request", () => {
  assert.match(developerLayout, /hasValidGate/);
  assert.match(developerLayout, /redirect\(`\/developer\/gate\?returnTo=/);
  // The check sits behind Creator authorization, never instead of it.
  const layoutCode = stripComments(developerLayout);
  assert.match(layoutCode, /guard\.kind === "authorized" && !\(await hasValidGate\(\)\)/);
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
