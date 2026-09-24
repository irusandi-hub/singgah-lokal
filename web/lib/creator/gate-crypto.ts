import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure crypto primitives for the Creator gate.
 *
 * The gate is a signed, HTTP-only cookie. The payload binds its purpose,
 * Creator user id, and issue time; the HMAC proves that this server issued
 * the value. The secret is never exposed to the browser.
 */

export const CREATOR_GATE_COOKIE = "singgah_creator_gate";
export const CREATOR_GATE_MAX_AGE_SECONDS = 8 * 60 * 60;
export type GatePurpose = "gate";

export function signGatePayload(
  purpose: GatePurpose,
  userId: string,
  issuedAtMs: number,
  secret: string,
): string {
  const payload = `${purpose}:${userId}:${issuedAtMs}`;
  const signature = createHmac("sha256", secret).update(payload).digest();
  return `${Buffer.from(payload).toString("base64url")}.${signature.toString("base64url")}`;
}

export type GateVerification = { ok: true; userId: string } | { ok: false };

export function verifyGatePayload(
  value: string | undefined | null,
  secret: string,
  purpose: GatePurpose,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): GateVerification {
  if (!value || !secret) return { ok: false };
  const parts = value.split(".");
  if (parts.length !== 2) return { ok: false };

  let payload: string;
  let signature: Buffer;
  try {
    payload = Buffer.from(parts[0], "base64url").toString("utf8");
    signature = Buffer.from(parts[1], "base64url");
  } catch {
    return { ok: false };
  }

  const expected = createHmac("sha256", secret).update(payload).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    return { ok: false };
  }

  const segments = payload.split(":");
  if (segments.length !== 3 || segments[0] !== purpose) return { ok: false };

  const issuedAtMs = Number(segments[2]);
  if (!Number.isFinite(issuedAtMs)) return { ok: false };
  const age = nowMs - issuedAtMs;
  if (age < 0 || age > maxAgeMs) return { ok: false };

  const userId = segments[1];
  if (!userId) return { ok: false };
  return { ok: true, userId };
}
