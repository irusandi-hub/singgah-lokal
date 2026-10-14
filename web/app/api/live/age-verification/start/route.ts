import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { startAgeVerification } from "@/lib/age-verification/service";

/**
 * Start an age verification for the signed-in account.
 *
 * Phase 2.1 foundation (migration 0055): no provider is configured yet, so this
 * endpoint answers `provider_not_configured` (503) and creates NO verification —
 * fail closed, never a "pending" row and never a verified one. The Live viewer
 * gate is untouched by this route: `assert_viewer_eligible` keeps denying every
 * viewer until a provider is chosen, implemented, tested and approved.
 *
 * The account is always taken from the session cookie — no user id is accepted
 * from the client.
 */
export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const result = await startAgeVerification({ userId: userData.user.id });

    if (result.status === "provider_not_configured") {
      return NextResponse.json({ error: "provider_not_configured" }, { status: 503 });
    }
    if (result.status === "provider_unavailable") {
      return NextResponse.json({ error: "age_verification_unavailable" }, { status: 503 });
    }

    return NextResponse.json({
      status: "pending",
      redirectUrl: result.redirectUrl,
    });
  } catch {
    return NextResponse.json({ error: "age_verification_unavailable" }, { status: 503 });
  }
}
