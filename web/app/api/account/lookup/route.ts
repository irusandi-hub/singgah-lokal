import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Privacy-safe account lookup for delegated Live-operator management.
 *
 * There is NO user directory here. The endpoint resolves at most ONE existing
 * account from an EXACT username, and only for a caller who already manages at
 * least one Place (owner/manager). Concretely:
 * - authentication is required (401 otherwise);
 * - the caller must hold an owner/manager membership, checked server-side
 *   before the lookup (403 otherwise);
 * - the actual match is performed by the SECURITY DEFINER RPC
 *   `resolve_account_by_username`, which re-checks the same authorization and
 *   matches an exact, non-null username only — no pattern, no prefix/partial
 *   search, no listing, no email lookup;
 * - the response carries only `userId` and the account's public `username`.
 *
 * It creates no account and exposes no account the caller could not already
 * delegate to.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 },
      );
    }

    const username = (
      new URL(request.url).searchParams.get("username") ?? ""
    ).trim();
    if (!username) {
      return NextResponse.json(
        { error: "username_required" },
        { status: 400 },
      );
    }

    // Only an account that manages a Place may look another account up.
    const { data: membership } = await supabase
      .from("producer_memberships")
      .select("role")
      .eq("user_id", userData.user.id)
      .in("role", ["owner", "manager"])
      .limit(1)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }

    const { data, error } = await supabase.rpc("resolve_account_by_username", {
      p_username: username,
    });

    if (error) {
      return NextResponse.json(
        { error: "account_lookup_unavailable" },
        { status: 503 },
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return NextResponse.json({ account: null });
    }

    return NextResponse.json({
      account: {
        userId: String(row.user_id),
        username: row.username ? String(row.username) : null,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "account_lookup_unavailable" },
      { status: 500 },
    );
  }
}
