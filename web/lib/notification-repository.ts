import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationCategory,
  type NotificationItem,
  type NotificationPreferences,
} from "@/lib/notifications-model";

/**
 * Notification data access (server side only).
 *
 * Every read and write is scoped to the authenticated actor's own rows:
 * the query filters on `user_id` and the caller's session client also carries
 * RLS (migration 0025/0024) as the database authority. There is deliberately
 * NO create or delete method here — notifications are written server-side by
 * the platform (migration 0026) and never by a client (MASTER 10 §14, §15).
 */

export type NotificationPreferencesPatch = Partial<
  Pick<NotificationPreferences, "live_place" | "visit_experience" | "help_support" | "system" | "promotional">
>;

export type NotificationRepository = {
  listForUser(userId: string, limit: number): Promise<NotificationItem[]>;
  countUnreadForUser(userId: string): Promise<number>;
  markReadForUser(userId: string, notificationId: string, readAt: string): Promise<boolean>;
  readPreferences(userId: string): Promise<NotificationPreferences>;
  writePreferences(userId: string, patch: NotificationPreferencesPatch): Promise<NotificationPreferences>;
};

const MAX_INBOX_SIZE = 50;

function mapNotification(row: Record<string, unknown>): NotificationItem {
  return {
    id: String(row.id),
    category: String(row.category) as NotificationCategory,
    eventType: String(row.event_type),
    title: String(row.title),
    body: String(row.body),
    placeId: row.place_id === null || row.place_id === undefined ? null : String(row.place_id),
    createdAt: String(row.created_at),
    readAt: row.read_at === null || row.read_at === undefined ? null : String(row.read_at),
  };
}

function mapPreferences(row: Record<string, unknown> | null | undefined): NotificationPreferences {
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    live_place: row.live_place !== false,
    visit_experience: row.visit_experience !== false,
    help_support: row.help_support !== false,
    system: row.system !== false,
    // Mandatory: never read as OFF, whatever a row may contain (MASTER 10 §10).
    safety_account: true,
    promotional: row.promotional === true,
  };
}

export class SupabaseNotificationRepository implements NotificationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listForUser(userId: string, limit = MAX_INBOX_SIZE): Promise<NotificationItem[]> {
    const { data, error } = await this.client
      .from("notifications")
      .select("id, category, event_type, title, body, place_id, created_at, read_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map(mapNotification);
  }

  async countUnreadForUser(userId: string): Promise<number> {
    const { count, error } = await this.client
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null);
    if (error) throw error;
    return count ?? 0;
  }

  /** Marks ONE of the caller's own notifications read. The only client-writable
   *  column (migration 0025 grants UPDATE (read_at) only). */
  async markReadForUser(userId: string, notificationId: string, readAt: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("notifications")
      .update({ read_at: readAt })
      .eq("id", notificationId)
      .eq("user_id", userId)
      .select("id");
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  async readPreferences(userId: string): Promise<NotificationPreferences> {
    const { data, error } = await this.client
      .from("notification_preferences")
      .select("live_place, visit_experience, help_support, system, safety_account, promotional")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return mapPreferences(data);
  }

  /** Preferences are stored in the canonical table (MASTER 10 §10, server-side).
   *  Two steps on purpose: migration 0024 grants INSERT (user_id) only, so a
   *  new row is created with the server defaults first and the requested
   *  values are then applied with an UPDATE (granted on the category columns). */
  async writePreferences(userId: string, patch: NotificationPreferencesPatch): Promise<NotificationPreferences> {
    const requested: Record<string, boolean> = {};
    if (typeof patch.live_place === "boolean") requested.live_place = patch.live_place;
    if (typeof patch.visit_experience === "boolean") requested.visit_experience = patch.visit_experience;
    if (typeof patch.help_support === "boolean") requested.help_support = patch.help_support;
    if (typeof patch.system === "boolean") requested.system = patch.system;
    if (typeof patch.promotional === "boolean") requested.promotional = patch.promotional;
    // Mandatory category is always written back ON: it is not a user choice.
    requested.safety_account = true;

    const applyUpdate = async (): Promise<boolean> => {
      const { data, error } = await this.client
        .from("notification_preferences")
        .update(requested)
        .eq("user_id", userId)
        .select("user_id");
      if (error) throw error;
      return (data ?? []).length > 0;
    };

    if (!(await applyUpdate())) {
      const { error: insertError } = await this.client
        .from("notification_preferences")
        .insert({ user_id: userId });
      if (insertError && insertError.code !== "23505") throw insertError;
      // Concurrent first-save: the row now exists, so the update applies.
      await applyUpdate();
    }

    return this.readPreferences(userId);
  }
}

export async function getServerNotificationRepository(): Promise<NotificationRepository> {
  return new SupabaseNotificationRepository(await createSupabaseServerClient());
}
