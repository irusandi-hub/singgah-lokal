import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isCreatorEmail } from "@/lib/auth/creator";
import { releaseCreatorLease } from "@/lib/creator/session-lease";

/**
 * Sign-out. For the Creator it also releases the single-active-session slot
 * so another Creator can sign in afterwards. The lease is released only when
 * the signed-out account actually holds it — regular users, Producers, and
 * Platform Admins are unaffected.
 */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email;
    const userId = data.user?.id;

    await supabase.auth.signOut();

    // Release after auth teardown; the release itself never throws.
    if (userId && email && isCreatorEmail(email)) {
      await releaseCreatorLease(userId);
    }

    return NextResponse.json({ authenticated: false });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "authentication_unavailable" }, { status: 503 });
  }
}
