import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Session probe for the main app header (Masuk/Daftar vs account controls).
// Exposes only the signed-in user's own session state and their own email —
// the email is shown next to the account controls in the header. No roles,
// memberships, or credentials are included here; area visibility is decided
// server-side by /account and each dashboard's own guard.
//
// The response MUST be uncacheable: the header flips on exactly this probe
// (login → Daftar/Masuk replaced by the account menu; logout → back to
// Daftar/Masuk). Without explicit no-store a intermediary can cache a probe
// answer (e.g. authenticated:false taken while signed out) and replay it to
// a signed-in browser — the reported "logged-in account still sees Daftar
// after refresh" bug. The probe must always reach this handler, which always
// reads the live session cookies.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    return NextResponse.json(
      {
        authenticated: Boolean(data?.user),
        email: data?.user?.email ?? null,
      },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  } catch {
    return NextResponse.json(
      { authenticated: false, email: null },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  }
}
