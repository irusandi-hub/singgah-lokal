import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import {
  InvalidNotificationPreferencesError,
  readUserNotificationPreferences,
  updateUserNotificationPreferences,
} from "@/lib/notification-service";

/**
 * GET/PATCH /api/notification-preferences — the caller's own communication
 * preferences (MASTER 10 §10, §16).
 *
 * Server-side only, stored in the canonical notification_preferences table.
 * Only the five optional categories are accepted; `safety_account` is
 * mandatory and always returned/stored as ON, so no API call can disable a
 * security-critical category.
 */
export async function GET(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const preferences = await readUserNotificationPreferences(actor.userId);
    return NextResponse.json(
      { preferences },
      { headers: { "Cache-Control": "no-store, must-revalidate" } },
    );
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Notification preferences could not be loaded" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "notification_preferences_invalid" }, { status: 400 });
    }
    const preferences = await updateUserNotificationPreferences(actor.userId, body);
    return NextResponse.json({ preferences });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof InvalidNotificationPreferencesError) {
      return NextResponse.json({ error: "notification_preferences_invalid" }, { status: 400 });
    }
    return NextResponse.json({ error: "Notification preferences could not be saved" }, { status: 500 });
  }
}
