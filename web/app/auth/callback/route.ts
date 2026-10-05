import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sanitizeReturnTo } from "@/lib/auth/return-to";

/**
 * OAuth callback for the existing Supabase Auth (Google provider).
 *
 * Reuses the same SSR server client as every other auth route, so the session
 * is written with the project's secure cookie handling — no parallel session
 * mechanism. Failures (user cancelled, provider error, missing/expired code)
 * redirect back to /auth with a short error code that the page turns into
 * Indonesian copy; the destination path is always re-sanitized, so a tampered
 * `next` cannot become an open redirect.
 */
function authErrorRedirect(origin: string, code: string): NextResponse {
  const url = new URL("/auth", origin);
  url.searchParams.set("error", code);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const providerError = searchParams.get("error");
  const code = searchParams.get("code");
  const next = sanitizeReturnTo(searchParams.get("next"));

  // Google/Supabase can come back with an explicit error (e.g. access_denied
  // when the user cancels consent) before any code is issued.
  if (providerError) {
    return authErrorRedirect(origin, providerError);
  }
  if (!code) {
    return authErrorRedirect(origin, "missing_code");
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return authErrorRedirect(origin, "oauth_exchange_failed");
    }
  } catch {
    return authErrorRedirect(origin, "oauth_exchange_failed");
  }

  // Same-origin only: `next` is a validated absolute path.
  return NextResponse.redirect(new URL(next, origin));
}
