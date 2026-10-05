import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildOAuthCallbackUrl, resolveAppOrigin } from "@/lib/auth/oauth";

/**
 * Starts the Google OAuth flow through the project's EXISTING Supabase Auth.
 *
 * No new auth system: this is Supabase's supported provider flow
 * (`signInWithOAuth`) on the same SSR server client used by /api/auth/sign-in.
 * The PKCE code verifier is stored by that client in an httpOnly cookie and
 * the browser is sent to the provider URL returned here.
 *
 * `skipBrowserRedirect: true` keeps the redirect choice on the client so the
 * page can show a loading/disabled state and handle failures gracefully.
 * No provider secret ever touches the client or this repository — the Google
 * client id/secret live only in the Supabase project's Auth provider settings.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const returnTo = typeof body.returnTo === "string" ? body.returnTo : "/";
  const origin = resolveAppOrigin(request.url, process.env.NEXT_PUBLIC_SITE_URL);
  const noStore = { "Cache-Control": "no-store, must-revalidate" };

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: buildOAuthCallbackUrl(origin, returnTo),
        skipBrowserRedirect: true,
        // Always let the user pick the Google account (new or already linked).
        queryParams: { prompt: "select_account" },
      },
    });

    if (error || !data?.url) {
      return NextResponse.json({ error: "oauth_unavailable" }, { status: 503, headers: noStore });
    }

    return NextResponse.json({ url: data.url }, { headers: noStore });
  } catch {
    return NextResponse.json({ error: "oauth_unavailable" }, { status: 503, headers: noStore });
  }
}
