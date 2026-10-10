import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { mapInvitationRpcError } from "@/lib/live/operator-invitation-core";

/**
 * INVITEE surface — the caller's OWN Live Operator invitations (pending and
 * historical), with the Place name and the inviting manager's name. The RPC is
 * scoped to auth.uid(), so no invitation of another account can appear here.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const { data, error } = await supabase.rpc("list_my_live_operator_invitations");
    if (error) {
      const mapped = mapInvitationRpcError(error.message);
      return NextResponse.json({ error: mapped.code }, { status: mapped.status });
    }

    const rows = Array.isArray(data) ? data : [];
    return NextResponse.json({
      invitations: rows.map((row) => ({
        id: String(row.id),
        placeId: String(row.place_id),
        placeName: String(row.place_name),
        invitedEmail: String(row.invited_email),
        invitedByProducerId: String(row.invited_by_producer_id),
        invitedByName: row.invited_by_name ? String(row.invited_by_name) : null,
        status: String(row.status),
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
        resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "live_operator_invitation_unavailable" },
      { status: 503 },
    );
  }
}
