import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPlaceOwnerOrManager } from "@/lib/live/operator-authorization";
import {
  enforceOperatorInviteRateLimit,
  mapInvitationRpcError,
  OperatorInviteRateLimitedError,
} from "@/lib/live/operator-invitation-core";

/**
 * MANAGER surface — Live Operator invitations for the Places the caller
 * manages (owner/manager). Both handlers resolve authority through the single
 * Live authorization helper; the SQL RPC re-checks it again server-side.
 *
 * POST (invite): body { placeId, email }. The email is matched against the
 * REGISTERED account email inside the SECURITY DEFINER RPC, which returns the
 * SAME success whether or not the email exists, and never creates an account —
 * so this endpoint cannot be used to enumerate accounts. Rate limited per
 * inviter.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      placeId?: unknown;
      email?: unknown;
    };
    const placeId = typeof body.placeId === "string" ? body.placeId : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";

    if (!placeId) {
      return NextResponse.json({ error: "placeId_required" }, { status: 400 });
    }
    if (!email) {
      return NextResponse.json({ error: "email_required" }, { status: 400 });
    }

    const allowed = await isPlaceOwnerOrManager(supabase, userData.user.id, placeId);
    if (!allowed) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }

    enforceOperatorInviteRateLimit(userData.user.id);

    const { error } = await supabase.rpc("invite_live_operator", {
      p_place_id: placeId,
      p_email: email,
    });
    if (error) {
      const mapped = mapInvitationRpcError(error.message);
      return NextResponse.json({ error: mapped.code }, { status: mapped.status });
    }

    // Uniform success: the caller never learns whether the email resolved.
    return NextResponse.json({ invited: true }, { status: 201 });
  } catch (error) {
    if (error instanceof OperatorInviteRateLimitedError) {
      return NextResponse.json(
        { error: "live_operator_invite_rate_limited" },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "live_operator_invitation_unavailable" },
      { status: 503 },
    );
  }
}

/** GET (list): ?placeId=… — the invitations of ONE Place the caller manages. */
export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const placeId = new URL(request.url).searchParams.get("placeId") ?? "";
    if (!placeId) {
      return NextResponse.json({ error: "placeId_required" }, { status: 400 });
    }

    const allowed = await isPlaceOwnerOrManager(supabase, userData.user.id, placeId);
    if (!allowed) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }

    const { data, error } = await supabase.rpc("list_place_live_operator_invitations", {
      p_place_id: placeId,
    });
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
        invitedUserId: String(row.invited_user_id),
        invitedEmail: String(row.invited_email),
        invitedByProducerId: String(row.invited_by_producer_id),
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
