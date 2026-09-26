/**
 * Notification domain model (pure, client-safe — no server imports).
 *
 * MASTER 10 scope kept deliberately small: this module only describes the
 * six categories already locked by migration 0024/0025, the unread badge
 * rule for the header, and which EXISTING route a notification may open.
 * No new category, no delivery channel, no notification content wording.
 */

export const NOTIFICATION_CATEGORIES = [
  "live_place",
  "visit_experience",
  "help_support",
  "system",
  "safety_account",
  "promotional",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationPreferences = {
  live_place: boolean;
  visit_experience: boolean;
  help_support: boolean;
  system: boolean;
  safety_account: boolean;
  promotional: boolean;
};

/** The five user-controllable categories. safety_account is excluded on purpose:
 *  MASTER 10 §10 — security-critical messages cannot be disabled through
 *  ordinary notification preferences, so it is mandatory, not optional. */
export const OPTIONAL_NOTIFICATION_CATEGORIES = [
  "live_place",
  "visit_experience",
  "help_support",
  "system",
  "promotional",
] as const;

export type OptionalNotificationCategory = (typeof OPTIONAL_NOTIFICATION_CATEGORIES)[number];

export const MANDATORY_NOTIFICATION_CATEGORY: NotificationCategory = "safety_account";

/** Server defaults — identical to migration 0024 (mandatory ON, promotional OFF). */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  live_place: true,
  visit_experience: true,
  help_support: true,
  system: true,
  safety_account: true,
  promotional: false,
};

type CategoryDescriptor = {
  category: NotificationCategory;
  label: string;
  description: string;
  mandatory: boolean;
  editable: boolean;
};

export const NOTIFICATION_CATEGORY_CATALOG: readonly CategoryDescriptor[] = [
  {
    category: "live_place",
    label: "Live & Place",
    description: "Kabari ketika sebuah Place yang kamu ikuti sedang Live.",
    mandatory: false,
    editable: true,
  },
  {
    category: "visit_experience",
    label: "Visit & Experience",
    description: "Status Visit Intent dan Experience yang kamu ikuti.",
    mandatory: false,
    editable: true,
  },
  {
    category: "help_support",
    label: "Help & Support",
    description: "Informasi bantuan dan dukungan.",
    mandatory: false,
    editable: true,
  },
  {
    category: "system",
    label: "System",
    description: "Informasi operasional platform.",
    mandatory: false,
    editable: true,
  },
  {
    category: MANDATORY_NOTIFICATION_CATEGORY,
    label: "Safety & Account",
    description: "Notifikasi keamanan akun. Selalu aktif dan tidak dapat dimatikan.",
    mandatory: true,
    editable: false,
  },
  {
    category: "promotional",
    label: "Promotional",
    description: "Promosi dan rekomendasi. Nonaktif secara default.",
    mandatory: false,
    editable: true,
  },
];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export function isOptionalNotificationCategory(value: unknown): value is OptionalNotificationCategory {
  return typeof value === "string" && (OPTIONAL_NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export type NotificationItem = {
  id: string;
  category: NotificationCategory;
  eventType: string;
  title: string;
  body: string;
  placeId: string | null;
  createdAt: string;
  readAt: string | null;
};

/**
 * Header unread badge (MASTER 10 §9 unread count/badge).
 * 0 unread → no badge at all; 1–99 → the number; 100+ → "99+".
 * Returns null for anything that must not render a badge, so the bell itself
 * stays visible even with zero unread.
 */
export function formatUnreadBadge(unreadCount: number): string | null {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0) return null;
  if (unreadCount > 99) return "99+";
  return String(Math.floor(unreadCount));
}

/** aria-label for the header bell: mentions the unread count only when there is one. */
export function notificationBellLabel(unreadCount: number): string {
  if (unreadCount > 0) {
    return `Notifikasi (${formatUnreadBadge(unreadCount)} belum dibaca)`;
  }
  return "Notifikasi";
}

/**
 * Resolve the destination of a notification using EXISTING routes only.
 * - a Place-scoped notification opens that Place page (the Place page already
 *   shows the current Live status, MASTER_LIVE_TECH §9);
 * - anything without a known target renders as plain text — MASTER 10 §9
 *   requires expired/unknown targets to resolve gracefully, so no route is
 *   invented (and no new Live route is introduced here).
 */
export function resolveNotificationHref(notification: Pick<NotificationItem, "placeId">): string | null {
  const placeId = notification.placeId?.trim();
  return placeId ? `/places/${placeId}` : null;
}
