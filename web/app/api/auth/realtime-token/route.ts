import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Hands the signed-in caller their OWN access token so the browser Supabase
 * Realtime client can present the user JWT that the private-channel RLS
 * (migration 0009) requires for `live_session:{id}` subscriptions.
 *
 * Boundary: the token already resides in the caller's own cookies — this
 * endpoint only returns it to its owner (no service key, no other user's
 * session, no roles/memberships). Unauthenticated callers get 401. The
 * response is uncacheable.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token ?? null;
    if (!accessToken) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json(
      { accessToken },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  } catch {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }
}
