import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    return NextResponse.json({ authenticated: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "authentication_unavailable" }, { status: 503 });
  }
}
