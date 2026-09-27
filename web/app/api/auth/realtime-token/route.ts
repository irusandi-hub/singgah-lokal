import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Hands the signed-in caller their OWN access token (and their own user id)
 * so the browser Supabase Realtime client can present the user JWT that the
 * private-channel RLS requires — `live_session:{id}` (migration 0009) and
 * `notifications:{userId}` (migration 0029). The user id is returned only so
 * the client can address its OWN topic; it identifies nobody else.
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
    const userId = data.session?.user?.id ?? null;
    if (!accessToken || !userId) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json(
      { accessToken, userId },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  } catch {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }
}
