import { sanitizeReturnTo } from "@/lib/auth/return-to";

/**
 * Pure helpers for the OAuth flows (Google + Apple) through the project's
 * existing Supabase Auth. No framework imports so both the route handlers and
 * the unit tests can use them.
 *
 * Design rules baked in here:
 * - The post-login destination is ALWAYS re-sanitized with sanitizeReturnTo,
 *   so neither the initiation route nor the callback route can be turned into
 *   an open redirect (a tampered `next` collapses to Home "/").
 * - The redirect origin comes from the deployment's own request URL (or an
 *   explicitly configured canonical site URL) and never from a client-supplied
 *   host header, so a spoofed `x-forwarded-host` cannot steer the redirect.
 */

/** Canonical OAuth callback path inside this app. */
export const OAUTH_CALLBACK_PATH = "/auth/callback";

/** OAuth providers this app initiates. */
export type OAuthProvider = "google" | "apple";

const PROVIDER_LABELS: Record<OAuthProvider, string> = {
  apple: "Apple",
  google: "Google",
};

/**
 * Absolute URL Supabase should return the browser to after provider consent.
 * `returnTo` is validated first and then carried as the `next` query param.
 * The initiating `provider` is carried too so the callback can name the right
 * provider in its error copy (the callback itself is provider-agnostic).
 */
export function buildOAuthCallbackUrl(
  origin: string,
  returnTo: string,
  provider: OAuthProvider = "google",
): string {
  const url = new URL(OAUTH_CALLBACK_PATH, origin);
  url.searchParams.set("next", sanitizeReturnTo(returnTo));
  url.searchParams.set("provider", provider);
  return url.toString();
}

/**
 * Resolve the app origin used for OAuth redirects.
 *
 * Prefers the explicitly configured `NEXT_PUBLIC_SITE_URL` (recommended for
 * preview/production so the redirect URL is deterministic and can be
 * allow-listed in Supabase exactly); otherwise uses the request's own origin.
 * A client-supplied forwarded host is deliberately NOT trusted.
 */
export function resolveAppOrigin(requestUrl: string, siteUrl?: string | null): string {
  const configured = siteUrl?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Malformed configuration must never break login — fall through.
    }
  }
  return new URL(requestUrl).origin;
}

/** User-facing Indonesian copy for OAuth failures (cancel, provider, callback). */
export function oauthErrorMessages(provider: OAuthProvider = "google"): Record<string, string> {
  const label = PROVIDER_LABELS[provider];
  return {
    access_denied: `Masuk dengan ${label} dibatalkan. Kamu bisa mencoba lagi kapan saja.`,
    missing_code: `Masuk dengan ${label} tidak selesai. Silakan coba lagi.`,
    oauth_exchange_failed: `Sesi ${label} tidak dapat dibuat. Silakan coba lagi.`,
    oauth_unavailable: `Layanan masuk dengan ${label} sedang tidak tersedia. Coba lagi nanti.`,
    server_error: `Layanan masuk dengan ${label} sedang bermasalah. Coba lagi nanti.`,
    temporarily_unavailable: `Layanan masuk dengan ${label} sedang tidak tersedia. Coba lagi nanti.`,
  };
}

/** Google error copy (kept for existing call sites/tests). */
export const OAUTH_ERROR_MESSAGES: Record<string, string> = oauthErrorMessages("google");

export function oauthErrorFallback(provider: OAuthProvider = "google"): string {
  return `Masuk dengan ${PROVIDER_LABELS[provider]} gagal. Silakan coba lagi atau gunakan email dan password.`;
}

/** Google fallback copy (kept for existing call sites/tests). */
export const OAUTH_ERROR_FALLBACK = oauthErrorFallback("google");

export function describeOAuthError(
  code: string | null | undefined,
  provider: OAuthProvider = "google",
): string | null {
  if (!code) return null;
  return oauthErrorMessages(provider)[code] ?? oauthErrorFallback(provider);
}

/** Narrow an arbitrary query value to a known provider, defaulting to google. */
export function normalizeOAuthProvider(value: string | null | undefined): OAuthProvider {
  return value === "apple" ? "apple" : "google";
}
