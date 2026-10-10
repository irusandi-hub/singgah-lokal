import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mapInvitationRpcError } from "@/lib/live/operator-invitation-core";

/**
 * INVITEE surface — accept a PENDING invitation addressed to the caller.
 * Accepting grants the delegated Operator Live access for that EXACT Place and,
 * if the Place already had another active operator, that operator is revoked in
 * the same transaction (replacement). Only the invitee can accept; anyone else
 * gets the same answer as a non-existent invitation.
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

    const { error } = await supabase.rpc("accept_live_operator_invitation", {
      p_invitation_id: invitationId,
    });
    if (error) {
      const mapped = mapInvitationRpcError(error.message);
      return NextResponse.json({ error: mapped.code }, { status: mapped.status });
    }

    return NextResponse.json({ accepted: true });
  } catch {
    return NextResponse.json(
      { error: "live_operator_invitation_unavailable" },
      { status: 503 },
    );
  }
}
