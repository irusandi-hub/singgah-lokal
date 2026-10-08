import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const { data: rows, error: rowsError } = await supabase
      .from("live_operators")
      .select("place_id, granted_at, revoked_at")
      .eq("user_id", userData.user.id)
      .order("granted_at", { ascending: true });

    if (rowsError) {
      return NextResponse.json({ error: "live_access_unavailable" }, { status: 500 });
    }

    const assigned = (rows ?? []).map((row) => ({
      placeId: String(row.place_id),
      grantedAt: String(row.granted_at),
      revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    }));

    return NextResponse.json({ assigned });
  } catch {
    return NextResponse.json({ error: "live_access_unavailable" }, { status: 500 });
  }
}
