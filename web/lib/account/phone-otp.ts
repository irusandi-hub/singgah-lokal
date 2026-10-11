import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * PHONE OTP — the challenge model (pure, server-side).
 *
 * The OTP itself is never stored in plaintext: only an HMAC-SHA256 hex digest of
 * the code, keyed with a server-side secret, is persisted (`code_hash`), and the
 * submitted code is hashed the same way before it is compared. The delivered
 * code and the full phone number are NEVER logged.
 *
 * No Master defines OTP politics, so every number below is a single documented
 * constant mirrored by the migration default — see the Policy Gaps in
 * docs/HANDOFF_LIVE_MVP.md §30.2. No provider is implemented here; delivery goes
 * through the neutral `PhoneOtpProvider` seam (lib/account/phone-otp-provider.ts).
 */

export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_SECONDS = 600; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_REQUEST_WINDOW_SECONDS = 900; // 15 minutes
export const OTP_MAX_REQUESTS_PER_USER = 3;
export const OTP_MAX_REQUESTS_PER_PHONE = 3;

export const OTP_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const OTP_HASH_SECRET_ENV = "PHONE_OTP_HASH_SECRET";

/**
 * A uniformly random decimal code. `randomInt` (CSPRNG) is used — never
 * `Math.random()`, which is not a security source.
 */
export function generateOtpCode(length: number = OTP_CODE_LENGTH): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(0, 10));
  }
  return code;
}

/**
 * HMAC-SHA256 hex of the code, keyed by the server secret. The digest is a
 * 64-char lowercase hex string — exactly the shape the `code_hash` column
 * enforces — so a plaintext code can never be stored.
 */
export function hashOtpCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(String(code)).digest("hex");
}

/** Constant-time comparison of two hex digests (no early-exit leak). */
export function otpHashMatches(candidateHash: string, storedHash: string): boolean {
  if (!OTP_HASH_PATTERN.test(candidateHash) || !OTP_HASH_PATTERN.test(storedHash)) {
    return false;
  }
  const candidate = Buffer.from(candidateHash, "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function otpExpiresAt(createdAt: Date, ttlSeconds: number = OTP_TTL_SECONDS): Date {
  return new Date(createdAt.getTime() + ttlSeconds * 1000);
}

export function isOtpExpired(
  expiresAt: Date,
  at: Date = new Date(),
): boolean {
  return expiresAt.getTime() <= at.getTime();
}

/** Rate-limit predicate: `count` requests inside the window vs the limit. */
export function isOtpRequestRateLimited(count: number, limit: number): boolean {
  return count >= limit;
}

/**
 * Resolve the server-side OTP hash secret. Absent means the OTP flow fails
 * CLOSED (no challenge is created and no code is generated) — a missing secret
 * is never worked around with a weaker hash. The value itself is never logged or
 * returned to a client.
 */
export function resolveOtpHashSecret(): string | null {
  const secret = process.env[OTP_HASH_SECRET_ENV];
  return secret && secret.trim().length > 0 ? secret : null;
}
