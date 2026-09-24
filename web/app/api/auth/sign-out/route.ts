import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CreatorRequiredError, isCreatorEmail } from "@/lib/auth/creator";
import { CREATOR_GATE_COOKIE } from "@/lib/creator/gate-crypto";
import { releaseCreatorLease } from "@/lib/creator/session-lease";

/** Sign-out releases the Creator lease before invalidating the auth session. */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    const email = data.user?.email;
    const userId = data.user?.id;

    if (userId && email && isCreatorEmail(email)) {
      try {
        await releaseCreatorLease(userId);
      } catch (error) {
        if (!(error instanceof CreatorRequiredError)) {
          console.error("[auth/sign-out] Creator lease release failed:", error);
        }
      }
    }

    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
    }
    const store = await cookies();
    store.delete(CREATOR_GATE_COOKIE);
    return NextResponse.json({ authenticated: false });
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
}
