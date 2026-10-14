/**
 * Age-verification provider boundary (Phase 2.1 foundation, migration 0055).
 *
 * NEUTRAL BY DESIGN: this module defines the interface every future vendor must
 * implement and an EMPTY registry. No vendor is chosen, named, configured, or
 * called here — MASTER_LIVE_TECH §2.1 marks the mechanism BLOCKED/TUNABLE, and
 * the audit (docs/audits/LIVE_AUTH_AUDIT_v1.md §6, P1–P3) requires the product
 * owner to pick the vendor and the data-retention rules first.
 *
 * The interface deliberately exposes ONE age fact — "the subject meets the
 * minimum age" (18, inclusive) — never an age number, a date of birth, a
 * document, or biometric data. A self-declared date of birth is NOT
 * verification (MASTER_LIVE_POLICY §12.1 item 3), so no such input exists in
 * this contract.
 *
 * Adding a vendor later is a small, reviewable change: implement
 * `AgeVerificationProvider` in its own module, add one entry to PROVIDERS, and
 * set the selection variable below. Until then `getAgeVerificationProvider()`
 * returns null and every entry point answers `provider_not_configured` (503)
 * without writing a verification.
 *
 * This module MUST NOT import a mock, a test double, or test-only code: the only
 * way a provider becomes reachable is a real registration in this file. Tests
 * inject their own provider object straight into `lib/age-verification/core.ts`.
 */

/** Which registered provider to use. Unset → no provider configured (fail closed). */
export const AGE_VERIFICATION_PROVIDER_ENV = "AGE_VERIFICATION_PROVIDER";

export type AgeVerificationStartInput = {
  /** The account the verification is requested for (server-derived). */
  userId: string;
};

export type AgeVerificationStartOutput = {
  /** Opaque provider correlation handle; never an identity/document reference. */
  providerRef: string;
  /** Where the account is sent to complete the check (provider-hosted). */
  redirectUrl: string;
};

export type AgeVerificationCallbackInput = {
  /** Raw request body, exactly as received — signature verification needs it. */
  rawBody: string;
  /** Request headers (signature, timestamp, delivery id…). */
  headers: Record<string, string>;
};

export type AgeVerificationCallbackOutput = {
  /** Provider event id — the anti-replay key. */
  eventId: string;
  eventType: string;
  /** The opaque reference created at start, used to resolve the account. */
  providerRef: string;
  /** The ONLY age fact a provider may assert: does the subject meet the minimum age? */
  minimumAgeConfirmed: boolean;
  /** Provider assertion time (ISO 8601), required for a "verified" result. */
  verifiedAt: string | null;
  /** Optional validity deadline (ISO 8601); null = no expiry asserted. */
  expiresAt: string | null;
};

export interface AgeVerificationProvider {
  /** Registered provider id (matches the selection value). */
  readonly id: string;
  /** Begin a verification for an account. */
  createVerification(input: AgeVerificationStartInput): Promise<AgeVerificationStartOutput | null>;
  /**
   * Verify the webhook signature AND parse the event. Implementations MUST
   * return null when the request is not authentic — the caller then ignores the
   * callback and writes nothing.
   */
  handleCallback(input: AgeVerificationCallbackInput): Promise<AgeVerificationCallbackOutput | null>;
}

/**
 * Registered providers. Intentionally EMPTY: no vendor has been approved. A new
 * entry is the single point where a real provider becomes reachable, and it must
 * only be added together with the product-owner decision (vendor, data sent,
 * data retained) — never a test double.
 */
const PROVIDERS: Readonly<Record<string, AgeVerificationProvider>> = Object.freeze({});

/** Ids that are currently registered (used by the tests and by review). */
export function registeredAgeVerificationProviders(): readonly string[] {
  return Object.keys(PROVIDERS);
}

/**
 * Resolve the configured provider, or null when none is configured.
 *
 * Fail closed: an unset selection, or a selection naming an unregistered
 * provider, returns null — callers then answer `provider_not_configured` (503)
 * and write no verification. There is no fallback, no default vendor, and no
 * test/mock resolution here.
 */
export function getAgeVerificationProvider(): AgeVerificationProvider | null {
  const selected = process.env[AGE_VERIFICATION_PROVIDER_ENV]?.trim();
  if (!selected) return null;
  return PROVIDERS[selected] ?? null;
}
