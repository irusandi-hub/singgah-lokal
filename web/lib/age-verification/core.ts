/**
 * Pure age-verification decisions (no I/O, no framework, no Supabase).
 *
 * Everything provider-specific is behind `AgeVerificationProvider`; everything
 * that decides "may this become a verified result?" lives here so it is
 * unit-testable without any vendor and without a server runtime. The server
 * wrapper (`./service.ts`) only performs the storage calls.
 *
 * Fail-closed rules encoded here:
 *   * no configured provider → `provider_not_configured` (and nothing is written);
 *   * a provider that cannot start → `provider_unavailable` (never a fake success);
 *   * a callback whose signature cannot be verified → `invalid_signature`;
 *   * a result is "verified" ONLY when the provider asserted the minimum-age fact
 *     AND supplied an assertion time. The optional provider status field is never
 *     trusted on its own, and a self-declared age is never accepted.
 */

import type {
  AgeVerificationCallbackInput,
  AgeVerificationCallbackOutput,
  AgeVerificationProvider,
  AgeVerificationStartInput,
} from "./provider";

export type AgeVerificationStatus = "pending" | "verified" | "failed" | "expired" | "revoked";

export type AgeVerificationStartResult =
  | { status: "provider_not_configured" }
  | { status: "provider_unavailable" }
  | { status: "started"; providerRef: string; redirectUrl: string };

export type AgeVerificationCallbackDecision =
  | { status: "provider_not_configured" }
  | { status: "invalid_signature" }
  | { status: "authentic"; callback: AgeVerificationCallbackOutput };

export type AgeVerificationCallbackResult =
  | { status: "provider_not_configured" }
  | { status: "invalid_signature" }
  | { status: "store_unavailable" }
  | { status: "event_replay" }
  | { status: "unknown_reference" }
  | { status: "applied"; verificationStatus: "verified" | "failed" };

/** Start a verification, or fail closed when no provider is configured. */
export async function requestAgeVerification(
  provider: AgeVerificationProvider | null,
  input: AgeVerificationStartInput,
): Promise<AgeVerificationStartResult> {
  if (!provider) {
    return { status: "provider_not_configured" };
  }

  const output = await provider.createVerification(input);
  // A provider that cannot produce a reference/redirect never becomes a
  // half-started verification: the caller writes nothing.
  if (!output || !output.providerRef.trim() || !output.redirectUrl.trim()) {
    return { status: "provider_unavailable" };
  }

  return {
    status: "started",
    providerRef: output.providerRef.trim(),
    redirectUrl: output.redirectUrl,
  };
}

/**
 * Verify a callback's authenticity through the provider (which owns its own
 * signature scheme). Null, or an unset provider, is a denial — the caller must
 * then apply nothing.
 */
export async function verifyAgeVerificationCallback(
  provider: AgeVerificationProvider | null,
  input: AgeVerificationCallbackInput,
): Promise<AgeVerificationCallbackDecision> {
  if (!provider) {
    return { status: "provider_not_configured" };
  }

  const callback = await provider.handleCallback(input);
  if (!callback || !callback.eventId.trim() || !callback.providerRef.trim()) {
    return { status: "invalid_signature" };
  }

  return { status: "authentic", callback };
}

/**
 * The ONLY mapping from a provider result to a stored status.
 *
 * "verified" requires the minimum-age fact AND an assertion time; anything else
 * is a failure. Expiry and revocation are decided later, from the stored row
 * (`public.age_verification_satisfied` treats an expired row as not satisfied).
 */
export function ageVerificationStatusFor(
  callback: AgeVerificationCallbackOutput,
): "verified" | "failed" {
  if (callback.minimumAgeConfirmed === true && typeof callback.verifiedAt === "string" && callback.verifiedAt.trim() !== "") {
    return "verified";
  }
  return "failed";
}
