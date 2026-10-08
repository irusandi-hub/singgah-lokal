import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body =
      await request.json().catch(() => ({})) as { placeId?: unknown };
    const placeId =
      typeof body.placeId === "string"
        ? body.placeId
        : new URL(request.url).searchParams.get("placeId") ?? "";

    if (!placeId) {
      return NextResponse.json({ error: "placeId_required" }, { status: 400 });
    }

    const { data: membership } = await supabase
      .from("producer_memberships")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("place_id", placeId)
      .in("role", ["owner", "manager"])
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }

    const { data: rows } = await supabase
      .from("live_operators")
      .select("user_id, place_id, granted_by, granted_at, revoked_at")
      .eq("place_id", placeId)
      .order("granted_at", { ascending: true });

    return NextResponse.json({
      operators: (rows ?? []).map((row) => ({
        userId: String(row.user_id),
        placeId: String(row.place_id),
        grantedBy: String(row.granted_by),
        grantedAt: String(row.granted_at),
        revokedAt: row.revoked_at ? String(row.revoked_at) : null,
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "live_operator_list_unavailable" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = await request.json();
    const userId =
      typeof body.userId === "string" ? body.userId : "";
    const placeId =
      typeof body.placeId === "string" ? body.placeId : "";
    const producerId =
      typeof body.producerId === "string"
        ? body.producerId
        : userData.user.id;

    if (!userId || !placeId) {
      return NextResponse.json(
        { error: "userId_placeId_required" },
        { status: 400 },
      );
    }

    const { data: membership } = await supabase
      .from("producer_memberships")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("place_id", placeId)
      .in("role", ["owner", "manager"])
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }

    const { error } = await supabase.rpc("grant_live_operator_access", {
      p_user_id: userId,
      p_place_id: placeId,
      p_producer_id: producerId,
    });

    if (error) {
      return NextResponse.json(
        { error: "live_operator_grant_failed" },
        { status: 400 },
      );
    }

    return NextResponse.json({ granted: true }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "live_operator_grant_unavailable" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = await request.json();
    const userId =
      typeof body.userId === "string" ? body.userId : "";
    const placeId =
      typeof body.placeId === "string" ? body.placeId : "";

    if (!userId || !placeId) {
      return NextResponse.json(
        { error: "userId_placeId_required" },
        { status: 400 },
      );
    }

    const { data: membership } = await supabase
      .from("producer_memberships")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("place_id", placeId)
      .in("role", ["owner", "manager"])
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }

    const { data, error } = await supabase.rpc("revoke_live_operator_access", {
      p_user_id: userId,
      p_place_id: placeId,
    });

    if (error) {
      return NextResponse.json(
        { error: "live_operator_revoke_failed" },
        { status: 400 },
      );
    }

    return NextResponse.json({ revoked: data });
  } catch {
    return NextResponse.json(
      { error: "live_operator_revoke_unavailable" },
      { status: 500 },
    );
  }
}
