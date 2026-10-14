import { NextResponse } from "next/server";
import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type CapabilityBody = {
  userId?: unknown;
  reason?: unknown;
};

function moderatorError(error: unknown) {
  if (error instanceof PlatformModeratorRequiredError) {
    return NextResponse.json({ error: "platform_moderator_required" }, { status: 403 });
  }
  return NextResponse.json({ error: "live_capability_unavailable" }, { status: 500 });
}

/**
 * A-10: account-level Live-capability suspension (foundation only).
 *
 * Platform Admin/Moderator only (MASTER_AUTHORITY §5/§6, MASTER_LIVE_POLICY
 * §5.1) — re-verified here AND inside the `suspend_live_capability` /
 * `restore_live_capability` RPCs. Suspending disables the account's ability to
 * broadcast/operate ANY Live (enforced by the shared `can_operate_live_for_place`
 * predicate used by start and end). It is NOT a platform-account suspension and
 * there is no permanent terminate: those remain POLICY DECISION NEEDED (P5).
 * Every decision appends an audit row with actor, target, reason and time; a
 * repeated suspend/restore is idempotent and records nothing new.
 */
export async function POST(request: Request) {
  try {
    const actor = await requirePlatformModerator();
    const body = (await request.json()) as CapabilityBody;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";

    if (!userId) {
      return NextResponse.json({ error: "live_capability_input_invalid" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("suspend_live_capability", {
      p_user_id: userId,
      p_reason: typeof body.reason === "string" ? body.reason : null,
    });

    if (error) {
      if (String(error.message).includes("live_suspension_target_invalid")) {
        return NextResponse.json({ error: "live_suspension_target_invalid" }, { status: 400 });
      }
      return NextResponse.json({ error: "live_capability_suspend_failed" }, { status: 400 });
    }

    return NextResponse.json({ suspended: true, actorId: actor.userId, userId });
  } catch (error) {
    return moderatorError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requirePlatformModerator();
    const body = (await request.json()) as CapabilityBody;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";

    if (!userId) {
      return NextResponse.json({ error: "live_capability_input_invalid" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("restore_live_capability", {
      p_user_id: userId,
      p_reason: typeof body.reason === "string" ? body.reason : null,
    });

    if (error) {
      return NextResponse.json({ error: "live_capability_restore_failed" }, { status: 400 });
    }

    return NextResponse.json({ restored: true, actorId: actor.userId, userId });
  } catch (error) {
    return moderatorError(error);
  }
}
