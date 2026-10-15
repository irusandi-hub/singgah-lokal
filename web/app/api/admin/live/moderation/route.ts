import { NextResponse } from "next/server";
import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";
import { moderateLiveSession } from "@/lib/live/session-service";

type ModerationBody = {
  sessionId?: unknown;
  action?: unknown;
  note?: unknown;
};

const actions = ["warn", "end", "suspend", "flag_review", "resolve_review", "block_content"] as const;
type ModerationAction = (typeof actions)[number];

function asAction(value: unknown): ModerationAction | "" {
  return typeof value === "string" && (actions as readonly string[]).includes(value)
    ? (value as ModerationAction)
    : "";
}

/**
 * Platform moderation actions (MASTER_LIVE_POLICY §5.1 / §12.1 item 5).
 *
 * Authorization is Platform Admin/Moderator only — re-verified server-side
 * (`requirePlatformModerator`) AND again inside the `moderate_live` RPC, which is
 * the authoritative check. Every action is audited by the RPC with actor, target
 * session and note. END-family actions additionally trigger provider playback
 * revocation (A-08) through the real provider capability the code has (Cloudflare
 * live-input delete), so an ended/suspended Live stops being playable without
 * waiting for the next status-route sweep.
 */
export async function POST(request: Request) {
  try {
    const actor = await requirePlatformModerator();

    const body = (await request.json()) as ModerationBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const action = asAction(body.action);

    if (!sessionId || !action) {
      return NextResponse.json({ error: "live_moderation_input_invalid" }, { status: 400 });
    }

    const { revoked } = await moderateLiveSession({
      sessionId,
      action,
      note: typeof body.note === "string" ? body.note : undefined,
    });

    return NextResponse.json({ moderated: true, action, actorId: actor.userId, revoked });
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) {
      return NextResponse.json({ error: "platform_moderator_required" }, { status: 403 });
    }
    if (error instanceof Error && error.message.includes("live_session_not_found")) {
      return NextResponse.json({ error: "live_session_not_found" }, { status: 404 });
    }
    if (error instanceof Error && error.message.includes("live_moderation_action_invalid")) {
      return NextResponse.json({ error: "live_moderation_action_invalid" }, { status: 400 });
    }
    return NextResponse.json({ error: "live_moderation_unavailable" }, { status: 500 });
  }
}
