import "server-only";

import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";

import {
  CREATOR_GATE_COOKIE,
  CREATOR_GATE_MAX_AGE_SECONDS,
  CREATOR_GATE_STEP_COOKIE,
  CREATOR_GATE_STEP_MAX_AGE_SECONDS,
  signGatePayload,
  verifyGatePayload,
} from "@/lib/creator/gate-crypto";
import { requireCreator } from "@/lib/auth/creator";

/**
 * CREATOR SECURITY GATE — server-side session layer (Authority Master §2).
 *
 * Flow: sign-in → requireCreator() detects the Creator → server-verified
 * CAPTCHA ("Bukan robot") → server-verified secret question → full access
 * to /developer for the cookie lifetime.
 *
 * Both verifications produce signed, HTTP-only cookies; nothing is stored
 * client-side, so refresh and direct URLs cannot bypass the gate. The gate
 * is an additional layer only: requireCreator() remains mandatory on every
 * Developer API and page, and a gate cookie can never substitute Creator
 * authorization (the cookie only ever proves a Creator already passed the
 * two steps for that exact user id).
 *
 * Fail-closed: if the CAPTCHA secret is not configured, verification fails
 * regardless of any token value. Required environment variables are
 * documented in README (Creator setup) and reported by the gate page.
 */

export class GateConfigError extends Error {
  readonly missingVars: string[];
  constructor(missingVars: string[]) {
    super(`Creator gate configuration is missing: ${missingVars.join(", ")}`);
    this.missingVars = missingVars;
  }
}

/** Server-only HMAC secret for gate cookies. Never exposed to the client. */
function resolveGateSecret(): string {
  return process.env.CREATOR_GATE_SECRET ?? "";
}

function hasCaptchaSecret(): boolean {
  return Boolean(process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY);
}

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

/**
 * Server-side CAPTCHA verification (Cloudflare Turnstile siteverify).
 * Fail-closed: missing config, network errors, or non-success responses all
 * count as "not verified". No secret ever leaves the server runtime.
 */
export async function verifyTurnstileToken(token: string, remoteIp?: string): Promise<boolean> {
  const secret = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  if (!secret || !token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

export type GateStepResult =
  | { ok: true }
  | { ok: false; code: "captcha_not_configured" | "captcha_failed" | "invalid_secret_answer" | "config_error" };

/** Step 1: verify the CAPTCHA server-side, then issue the step cookie. */
export async function passCaptchaStep(token: string, remoteIp?: string): Promise<GateStepResult> {
  const creator = await requireCreator();
  if (!hasCaptchaSecret()) return { ok: false, code: "captcha_not_configured" };
  const verified = await verifyTurnstileToken(token, remoteIp);
  if (!verified) return { ok: false, code: "captcha_failed" };

  const secret = resolveGateSecret();
  if (!secret) {
    throw new GateConfigError(["CREATOR_GATE_SECRET"]);
  }
  const store = await cookies();
  store.set(CREATOR_GATE_STEP_COOKIE, signGatePayload("step", creator.userId, Date.now(), secret), {
    ...COOKIE_BASE,
    maxAge: CREATOR_GATE_STEP_MAX_AGE_SECONDS,
  });
  return { ok: true };
}

/** Step 2: verify the secret answer against the stored hash, then issue the gate cookie. */
export async function passSecretQuestionStep(
  answer: string,
  checkAnswer: (userId: string, answer: string) => Promise<boolean>,
): Promise<GateStepResult> {
  const creator = await requireCreator();
  const secret = resolveGateSecret();
  if (!secret) throw new GateConfigError(["CREATOR_GATE_SECRET"]);

  const store = await cookies();
  const step = store.get(CREATOR_GATE_STEP_COOKIE)?.value;
  const stepValid =
    verifyGatePayload(step, secret, "step", CREATOR_GATE_STEP_MAX_AGE_SECONDS * 1000).ok;
  if (!stepValid) return { ok: false, code: "captcha_failed" };

  // Same hash path as the Account Security Manager — no new verification
  // mechanism. A wrong answer and an unset question are indistinguishable.
  const verified = await checkAnswer(creator.userId, answer);
  if (!verified) return { ok: false, code: "invalid_secret_answer" };

  store.set(CREATOR_GATE_COOKIE, signGatePayload("gate", creator.userId, Date.now(), secret), {
    ...COOKIE_BASE,
    maxAge: CREATOR_GATE_MAX_AGE_SECONDS,
  });
  // Consume the step cookie so it cannot be replayed for a second grant.
  store.delete(CREATOR_GATE_STEP_COOKIE);
  return { ok: true };
}

/**
 * Server-side gate check for /developer. Returns whether the signed gate
 * cookie is present, valid, bound to the current Creator, and unexpired.
 * Creator authorization itself is still enforced separately by requireCreator().
 */
export async function hasValidGate(): Promise<boolean> {
  const secret = resolveGateSecret();
  if (!secret) return false;
  const store = await cookies();
  const gate = store.get(CREATOR_GATE_COOKIE)?.value;
  return verifyGatePayload(gate, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000).ok;
}

/** Adds a random delay so wrong-answer probes are not timing-distinguishable. */
export function addGateJitter(): void {
  const jitterMs = Number(randomBytes(1)[0]) % 40;
  const start = Date.now();
  while (Date.now() - start < jitterMs) {
    // intentional busy-wait: tiny, bounded, no async scheduling involved
  }
}

export { CREATOR_GATE_COOKIE, CREATOR_GATE_STEP_COOKIE };
