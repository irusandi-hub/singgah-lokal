import {
  getServerNotificationRepository,
  type NotificationPreferencesPatch,
  type NotificationRepository,
} from "@/lib/notification-repository";
import { isOptionalNotificationCategory, type NotificationItem, type NotificationPreferences } from "@/lib/notifications-model";

/**
 * Notification service — the authorization boundary for the User surface
 * (AGENTS.md: authorization stays on the server).
 *
 * Rules enforced here, on top of RLS:
 * - the actor identity always comes from the session, never from input;
 * - a notification can only be read/marked read by its own recipient;
 * - `safety_account` is mandatory: it is not accepted as a user choice and is
 *   always stored ON (MASTER 10 §10);
 * - only the five optional categories are accepted — no new category can be
 *   introduced through the API.
 */

export class NotificationNotFoundError extends Error {
  constructor() {
    super("Notification was not found");
  }
}

export class InvalidNotificationPreferencesError extends Error {
  constructor() {
    super("Invalid notification preferences");
  }
}

async function getRepository(repository?: NotificationRepository): Promise<NotificationRepository> {
  return repository ?? getServerNotificationRepository();
}

function requireUserId(userId: string): string {
  if (!userId.trim()) {
    throw new Error("Authenticated user is required");
  }
  return userId;
}

export async function listUserNotifications(
  userId: string,
  repository?: NotificationRepository,
): Promise<NotificationItem[]> {
  const actorId = requireUserId(userId);
  return (await getRepository(repository)).listForUser(actorId, 50);
}

export async function countUnreadUserNotifications(
  userId: string,
  repository?: NotificationRepository,
): Promise<number> {
  const actorId = requireUserId(userId);
  return (await getRepository(repository)).countUnreadForUser(actorId);
}

/** Mark one of the caller's own notifications read (idempotent). */
export async function markUserNotificationRead(
  userId: string,
  notificationId: string,
  repository?: NotificationRepository,
  now = new Date(),
): Promise<NotificationItem["id"]> {
  const actorId = requireUserId(userId);
  if (!notificationId.trim()) {
    throw new NotificationNotFoundError();
  }
  const updated = await (await getRepository(repository)).markReadForUser(actorId, notificationId, now.toISOString());
  if (!updated) {
    // Either the notification does not exist or it belongs to someone else —
    // identical, indistinguishable answer for the client (no cross-user leak).
    throw new NotificationNotFoundError();
  }
  return notificationId;
}

export async function readUserNotificationPreferences(
  userId: string,
  repository?: NotificationRepository,
): Promise<NotificationPreferences> {
  const actorId = requireUserId(userId);
  return (await getRepository(repository)).readPreferences(actorId);
}

export async function updateUserNotificationPreferences(
  userId: string,
  input: Record<string, unknown>,
  repository?: NotificationRepository,
): Promise<NotificationPreferences> {
  const actorId = requireUserId(userId);

  const patch: NotificationPreferencesPatch = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "safety_account") {
      // Mandatory category: accepted in the payload but never honoured as an
      // opt-out — it is always stored ON.
      continue;
    }
    if (!isOptionalNotificationCategory(key)) {
      // Unknown key → no new category may be created through the API.
      throw new InvalidNotificationPreferencesError();
    }
    if (typeof value !== "boolean") {
      throw new InvalidNotificationPreferencesError();
    }
    patch[key] = value;
  }

  if (Object.keys(patch).length === 0) {
    throw new InvalidNotificationPreferencesError();
  }

  return (await getRepository(repository)).writePreferences(actorId, patch);
}
