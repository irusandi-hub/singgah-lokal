import { sanitizeReturnTo } from "@/lib/auth/return-to";

/**
 * Pure helpers for the Google OAuth flow through the project's existing
 * Supabase Auth. No framework imports so both the route handlers and the
 * unit tests can use them.
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

/**
 * Absolute URL Supabase should return the browser to after Google consent.
 * `returnTo` is validated first and then carried as the `next` query param.
 */
export function buildOAuthCallbackUrl(origin: string, returnTo: string): string {
  const url = new URL(OAUTH_CALLBACK_PATH, origin);
  url.searchParams.set("next", sanitizeReturnTo(returnTo));
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
export const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Masuk dengan Google dibatalkan. Kamu bisa mencoba lagi kapan saja.",
  missing_code: "Masuk dengan Google tidak selesai. Silakan coba lagi.",
  oauth_exchange_failed: "Sesi Google tidak dapat dibuat. Silakan coba lagi.",
  oauth_unavailable: "Layanan masuk dengan Google sedang tidak tersedia. Coba lagi nanti.",
  server_error: "Layanan masuk dengan Google sedang bermasalah. Coba lagi nanti.",
  temporarily_unavailable: "Layanan masuk dengan Google sedang tidak tersedia. Coba lagi nanti.",
};

export const OAUTH_ERROR_FALLBACK =
  "Masuk dengan Google gagal. Silakan coba lagi atau gunakan email dan password.";

export function describeOAuthError(code: string | null | undefined): string | null {
  if (!code) return null;
  return OAUTH_ERROR_MESSAGES[code] ?? OAUTH_ERROR_FALLBACK;
}
