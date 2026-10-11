/**
 * PHONE OTP PROVIDER — a neutral delivery seam, no provider invented.
 *
 * No SMS/OTP provider is configured in this project: there is no vendor, no
 * credential, and no Master that names one. Rather than fabricating a provider
 * (or a "log the code" fallback, which would write OTP codes into logs), the
 * delivery side is an explicit seam:
 *
 *  - with NO provider registered, `getPhoneOtpProvider()` throws
 *    `PhoneOtpProviderNotConfiguredError` and the request endpoint answers
 *    `phone_otp_provider_not_configured` WITHOUT creating a challenge — the flow
 *    fails closed and is reported as a manual blocker;
 *  - wiring a real provider is a single `setPhoneOtpProvider(...)` call in a
 *    server-only bootstrap, which is the same injection pattern the project
 *    already uses for the server auth provider (`setServerAuthProvider`).
 *
 * The intended candidates (both require configuration the user owns, so neither
 * is implemented here) are the existing Supabase Auth phone channel
 * (`supabase.auth.signInWithOtp({ phone })` with an SMS provider registered in
 * the Supabase project) or an SMS vendor reached with a server-side API key.
 */

export type PhoneOtpDelivery = {
  /** E.164 number the code was generated for. */
  phoneE164: string;
  /** The one-time code. Never logged, never persisted in plaintext. */
  code: string;
  expiresAt: Date;
};

export interface PhoneOtpProvider {
  sendOtp(delivery: PhoneOtpDelivery): Promise<void>;
}

export class PhoneOtpProviderNotConfiguredError extends Error {
  constructor() {
    super("phone_otp_provider_not_configured");
  }
}

let provider: PhoneOtpProvider | null = null;

export function setPhoneOtpProvider(next: PhoneOtpProvider | null): void {
  provider = next;
}

export function isPhoneOtpProviderConfigured(): boolean {
  return provider !== null;
}

export function getPhoneOtpProvider(): PhoneOtpProvider {
  if (!provider) throw new PhoneOtpProviderNotConfiguredError();
  return provider;
}
