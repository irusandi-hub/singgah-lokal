import "server-only";

import { requireCreator } from "@/lib/auth/creator";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * Developer Center data layer — Platform Admin management (Authority Master
 * §2: the Creator manages Platform Admin accounts/roles; §8: "Admin grant /
 * revoke — Creator creates and revokes Platform Admin").
 *
 * Every function first passes through requireCreator (server-side, fail
 * closed). The service-role client is used ONLY to resolve a target account
 * by email and to write `public.users.platform_role`; it is never exposed to
 * any client surface and no secret ever appears in an API response.
 *
 * The Creator can never be granted platform_moderator here: that would fuse
 * tiers (Authority Master §4). Revoke also refuses to strip any account in
 * the Creator allowlist.
 */

export type PlatformAdminRow = {
  userId: string;
  email: string | null;
  platformRole: string | null;
  createdAt: string;
  source: "role";
};

export class DeveloperActionError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Developer action failed: ${code}`);
    this.code = code;
  }
}

const PLATFORM_ROLE = "platform_moderator";

export async function listPlatformAdmins(): Promise<PlatformAdminRow[]> {
  await requireCreator();

  const admin = createSupabaseServiceClient();
  const { data, error } = await admin
    .from("users")
    .select("id, platform_role, created_at")
    .eq("platform_role", PLATFORM_ROLE)
    .order("created_at", { ascending: false });

  if (error) throw new DeveloperActionError("list_failed");

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: authData, error: authError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (authError) throw new DeveloperActionError("list_failed");

  const emailById = new Map((authData.users ?? []).map((user) => [user.id, user.email ?? null]));

  return rows.map((row: { id: string; platform_role: string | null; created_at: string }) => ({
    userId: row.id,
    email: emailById.get(row.id) ?? null,
    platformRole: row.platform_role,
    createdAt: row.created_at,
    source: "role",
  }));
}

export async function grantPlatformAdmin(email: string): Promise<PlatformAdminRow> {
  // Authorization gate first: only the Creator may grant Platform Admin.
  await requireCreator();

  const target = email.trim().toLowerCase();
  if (!target.includes("@")) throw new DeveloperActionError("email_invalid");
  // Tier separation: the Creator identity itself can never become
  // platform_moderator (Authority Master §4).
  if (requireCreatorAllowlistIncludes(target)) throw new DeveloperActionError("creator_account");

  const admin = createSupabaseServiceClient();
  const { data: userData, error: userError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (userError) throw new DeveloperActionError("lookup_failed");

  const match = (userData.users ?? []).find(
    (user) => (user.email ?? "").trim().toLowerCase() === target,
  );
  if (!match) throw new DeveloperActionError("account_not_found");

  const { error: upsertError } = await admin
    .from("users")
    .upsert({ id: match.id, platform_role: PLATFORM_ROLE }, { onConflict: "id" });
  if (upsertError) throw new DeveloperActionError("grant_failed");

  return {
    userId: match.id,
    email: match.email ?? null,
    platformRole: PLATFORM_ROLE,
    createdAt: match.created_at ?? new Date().toISOString(),
    source: "role",
  };
}

export async function revokePlatformAdmin(email: string): Promise<void> {
  await requireCreator();

  const target = email.trim().toLowerCase();
  if (!target.includes("@")) throw new DeveloperActionError("email_invalid");
  if (requireCreatorAllowlistIncludes(target)) throw new DeveloperActionError("creator_account");

  const admin = createSupabaseServiceClient();
  const { data: userData, error: userError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (userError) throw new DeveloperActionError("lookup_failed");

  const match = (userData.users ?? []).find(
    (user) => (user.email ?? "").trim().toLowerCase() === target,
  );
  if (!match) throw new DeveloperActionError("account_not_found");

  const { error: updateError } = await admin
    .from("users")
    .update({ platform_role: null })
    .eq("id", match.id);
  if (updateError) throw new DeveloperActionError("revoke_failed");
}

function requireCreatorAllowlistIncludes(email: string): boolean {
  const raw = process.env.SINGGAH_CREATOR_EMAILS ?? "";
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(email);
}
