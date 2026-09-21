/**
 * returnTo sanitization for the auth page (open-redirect guard).
 *
 * Only same-origin, single-hop, absolute-path destinations are accepted.
 * Everything else — empty, too long, protocol-relative (`//host`),
 * scheme-bearing (`https://`, `javascript:`), backslash or newline tricks —
 * falls back to Home ("/"). The redirect target is validated before
 * navigation, so `/auth` cannot be used as an open redirect.
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/";
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) return "/";
  // Must be a relative absolute-path: starts with exactly one "/", no scheme,
  // no protocol-relative host, no backslash escapes.
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.includes("\\") || value.includes("\r") || value.includes("\n")) return "/";
  if (/:/.test(value.split("?")[0].split("#")[0])) return "/";
  return value;
}
