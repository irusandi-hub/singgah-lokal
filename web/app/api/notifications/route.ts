import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { countUnreadUserNotifications, listUserNotifications } from "@/lib/notification-service";

/**
 * GET /api/notifications — the signed-in user's own inbox (newest first) plus
 * the unread count that drives the header badge.
 *
 * Identity always comes from the session (requireAuthenticatedActor) and the
 * queries are owner-scoped + RLS-backed; a signed-out caller gets 401 and can
 * never read anyone else's notification. Uncacheable: the answer is
 * identity-specific, the same contract as /api/auth/session.
 */
export async function GET(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const [notifications, unreadCount] = await Promise.all([
      listUserNotifications(actor.userId),
      countUnreadUserNotifications(actor.userId),
    ]);
    return NextResponse.json(
      { notifications, unreadCount },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Notifications could not be loaded" }, { status: 500 });
  }
}
