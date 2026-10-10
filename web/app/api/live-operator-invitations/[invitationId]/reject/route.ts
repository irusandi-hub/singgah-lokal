import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mapInvitationRpcError } from "@/lib/live/operator-invitation-core";

/**
 * INVITEE surface — reject a PENDING invitation addressed to the caller. Only
 * the invitee can reject; anyone else gets the same answer as a non-existent
 * invitation.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ invitationId: string }> },
) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const { invitationId } = await params;
    if (!invitationId) {
      return NextResponse.json({ error: "invitation_id_required" }, { status: 400 });
    }

    const { error } = await supabase.rpc("reject_live_operator_invitation", {
      p_invitation_id: invitationId,
    });
    if (error) {
      const mapped = mapInvitationRpcError(error.message);
      return NextResponse.json({ error: mapped.code }, { status: mapped.status });
    }

    return NextResponse.json({ rejected: true });
  } catch {
    return NextResponse.json(
      { error: "live_operator_invitation_unavailable" },
      { status: 503 },
    );
  }
}
