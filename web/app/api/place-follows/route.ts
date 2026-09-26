import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { followPlace, listFollowedPlaceIds, unfollowPlace } from "@/lib/place-follows";

/**
 * User → Place Follow API (task foundation for MASTER 10 notifications).
 *
 * Authorization stays server-side (AGENTS.md): the actor comes from the
 * session (requireAuthenticatedActor), the follow target user_id is ALWAYS
 * the authenticated actor's id — never a client-supplied value — and RLS
 * (migration 0023) is the database backstop. Signed-out callers get 401 and
 * can never create or read a follow.
 */

export async function GET(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const supabase = await createSupabaseServerClient();
    const followedPlaceIds = await listFollowedPlaceIds(supabase, actor.userId);
    return NextResponse.json({ followedPlaceIds });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Follow state could not be loaded" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const body = (await request.json().catch(() => null)) as { placeId?: unknown } | null;
    const placeId = typeof body?.placeId === "string" ? body.placeId : "";

    if (!placeId.trim()) {
      return NextResponse.json({ error: "place_follow_invalid" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const result = await followPlace(supabase, actor.userId, placeId);
    return NextResponse.json({ followed: true, outcome: result.outcome });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "place_follow_unavailable" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const body = (await request.json().catch(() => null)) as { placeId?: unknown } | null;
    const placeId = typeof body?.placeId === "string" ? body.placeId : "";

    if (!placeId.trim()) {
      return NextResponse.json({ error: "place_follow_invalid" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const result = await unfollowPlace(supabase, actor.userId, placeId);
    return NextResponse.json({ followed: false, outcome: result.outcome });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "place_follow_unavailable" }, { status: 500 });
  }
}
