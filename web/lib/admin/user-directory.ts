import "server-only";

import { requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * ADMIN USER DIRECTORY — the ONLY place in the Admin tier that resolves a
 * User's email address.
 *
 * Email is PRIVATE DATA (new rule):
 * - Visible to: Platform Admin (operational user management) and
 *   Creator/Developer (who already resolves accounts by email in
 *   lib/developer/platform-admins).
 * - Never visible to: a Producer, another User, or the public. `public.users`
 *   deliberately stores no email, and nothing in app/api/places, app/api/experiences,
 *   app/producer, or any public page imports this module.
 *
 * The email is read from Supabase Auth, never from a public table, and is
 * returned ONLY behind a fresh server-side `requirePlatformModerator()` check.
 * No credential, token, or infrastructure secret is ever selected or returned
 * (Authority Master §3) — the row is projected to id + email + role + created
 * time and nothing else.
 */

export type AdminDirectoryUserRow = {
  id: string;
  email: string | null;
  platformRole: string | null;
  createdAt: string;
};

export class AdminDirectoryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Platform Admin user list WITH the account email, for user management. */
export async function listAdminDirectoryUsers(limit = 100): Promise<AdminDirectoryUserRow[]> {
  await requirePlatformModerator();

  const admin = createSupabaseServiceClient();
  const { data, error } = await admin
    .from("users")
    .select("id, platform_role, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new AdminDirectoryError("directory_unavailable");

  const rows = data ?? [];
  if (rows.length === 0) return [];

  // Emails live in Supabase Auth; join them by user id only. A missing email
  // is reported as null — it is never fabricated or inferred.
  const { data: authData, error: authError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (authError) throw new AdminDirectoryError("directory_unavailable");
  const emailById = new Map((authData.users ?? []).map((user) => [user.id, user.email ?? null]));

  return rows.map((row) => ({
    id: String(row.id),
    email: emailById.get(String(row.id)) ?? null,
    platformRole: row.platform_role === null ? null : String(row.platform_role),
    createdAt: String(row.created_at),
  }));
}
