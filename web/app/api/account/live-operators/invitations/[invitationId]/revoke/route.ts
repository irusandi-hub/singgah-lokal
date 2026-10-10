import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mapInvitationRpcError } from "@/lib/live/operator-invitation-core";

/**
 * MANAGER surface — revoke an ACCEPTED invitation, which withdraws the live
 * operator's access for that EXACT Place immediately (Live start/end re-read
 * the assignment on every call; there is no authorization cache). Authority is
 * re-checked inside the RPC against the invitation's own Place.
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

    const { error } = await supabase.rpc("revoke_live_operator_invitation", {
      p_invitation_id: invitationId,
    });
    if (error) {
      const mapped = mapInvitationRpcError(error.message);
      return NextResponse.json({ error: mapped.code }, { status: mapped.status });
    }

    return NextResponse.json({ revoked: true });
  } catch {
    return NextResponse.json(
      { error: "live_operator_invitation_unavailable" },
      { status: 503 },
    );
  }
}
