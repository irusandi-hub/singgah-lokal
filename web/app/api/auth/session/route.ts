import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Tiny session probe for client UI (Masuk vs Sign out). Exposes no PII —
// only whether the server session exists.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    return NextResponse.json({ authenticated: Boolean(data?.user) });
  } catch {
    return NextResponse.json({ authenticated: false });
  }
}
