import "server-only";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { requireCreator } from "@/lib/auth/creator";
import {
  CREATOR_GATE_COOKIE,
  CREATOR_GATE_MAX_AGE_SECONDS,
  signGatePayload,
  verifyGatePayload,
} from "@/lib/creator/gate-crypto";
import { acquireCreatorLease } from "@/lib/creator/session-lease";

/**
 * Creator gate server layer.
 *
 * An authenticated Creator first acquires/renews the single Creator session
 * lease, then verifies the existing secret question. Only a successful
 * verification issues the signed HTTP-only gate cookie.
 */

export class GateConfigError extends Error {
  readonly missingVars: string[];

  constructor(missingVars: string[]) {
    super(`Creator gate configuration is missing: ${missingVars.join(", ")}`);
    this.missingVars = missingVars;
  }
}

function resolveGateSecret(): string {
  return process.env.CREATOR_GATE_SECRET ?? "";
}

export function isCreatorGateConfigured(): boolean {
  return Boolean(resolveGateSecret());
}

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

export type GateStepResult =
  | { ok: true }
  | {
      ok: false;
      code: "creator_session_active" | "invalid_secret_answer" | "config_error";
    };

/**
 * Verify the existing secret question and issue/refresh gate authorization.
 * The lease is acquired again here so every gate POST is re-authorized and
 * cannot rely on stale client state.
 */
export async function passSecretQuestionStep(
  answer: string,
  checkAnswer: (userId: string, answer: string) => Promise<boolean>,
): Promise<GateStepResult> {
  const creator = await requireCreator();
  const secret = resolveGateSecret();
  if (!secret) throw new GateConfigError(["CREATOR_GATE_SECRET"]);

  const acquired = await acquireCreatorLease(creator.userId);
  if (!acquired) {
    return { ok: false, code: "creator_session_active" };
  }

  const verified = await checkAnswer(creator.userId, answer.trim());
  if (!verified) {
    addGateJitter();
    return { ok: false, code: "invalid_secret_answer" };
  }

  const store = await cookies();
  store.set(CREATOR_GATE_COOKIE, signGatePayload("gate", creator.userId, Date.now(), secret), {
    ...COOKIE_BASE,
    maxAge: CREATOR_GATE_MAX_AGE_SECONDS,
  });
  return { ok: true };
}

/**
 * Server-side gate check. The signed cookie is valid only for the currently
 * authenticated Creator, so another account cannot reuse a copied cookie.
 */
export async function hasValidGate(): Promise<boolean> {
  const creator = await requireCreator();
  const secret = resolveGateSecret();
  if (!secret) return false;
  const store = await cookies();
  const gate = store.get(CREATOR_GATE_COOKIE)?.value;
  const result = verifyGatePayload(gate, secret, "gate", CREATOR_GATE_MAX_AGE_SECONDS * 1000);
  return result.ok && result.userId === creator.userId;
}

/** Adds a small bounded delay so wrong-answer probes are less distinguishable. */
export function addGateJitter(): void {
  const jitterMs = Number(randomBytes(1)[0]) % 40;
  const start = Date.now();
  while (Date.now() - start < jitterMs) {
    // Intentional bounded delay; no success or authentication state changes.
  }
}

export { CREATOR_GATE_COOKIE };
