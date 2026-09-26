import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { markUserNotificationRead, NotificationNotFoundError } from "@/lib/notification-service";

/**
 * POST /api/notifications/:id/read — mark ONE of the caller's own
 * notifications read (MASTER 10 §9 unread/read state; §16 conceptual API).
 *
 * The identity is always the session actor; the target is additionally
 * owner-scoped in the query and by RLS, so a notification owned by another
 * user answers exactly like a non-existent one (404) — no cross-user
 * existence leak. read_at is the only column a client may ever write
 * (migration 0025); there is no create or delete route.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const { id } = await params;
    await markUserNotificationRead(actor.userId, id);
    return NextResponse.json({ read: true, id });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof NotificationNotFoundError) {
      return NextResponse.json({ error: "notification_not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Notification could not be updated" }, { status: 500 });
  }
}
