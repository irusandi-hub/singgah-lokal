import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Session probe for the main app header (Masuk/Daftar vs account controls).
// Exposes only the signed-in user's own session state and their own email —
// the email is shown next to the account controls in the header. No roles,
// memberships, or credentials are included here; area visibility is decided
// server-side by /account and each dashboard's own guard.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    return NextResponse.json({
      authenticated: Boolean(data?.user),
      email: data?.user?.email ?? null,
    });
  } catch {
    return NextResponse.json({ authenticated: false, email: null });
  }
}
