import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * CREATOR / OWNER / DEVELOPER authorization (Authority Master §2).
 *
 * The Creator holds the highest authority over the program and all
 * infrastructure and is the only tier that may grant/revoke Platform Admin.
 * The Creator is NOT platform_moderator and must never be modeled as one
 * (Authority Master §4), so the Creator identity is pinned in the
 * Creator-controlled runtime environment instead of a database role.
 *
 * Fail closed: unauthenticated, unconfigured environment, or an email outside
 * the allowlist => denied. Allowlist matching is case-insensitive on the
 * authenticated account's own email, read server-side only.
 */

export type CreatorActor = {
  userId: string;
  email: string;
};

export class CreatorRequiredError extends Error {
  constructor() {
    super("Creator authorization is required");
  }
}

export function resolveCreatorAllowlist(): string[] {
  const raw = process.env.SINGGAH_CREATOR_EMAILS ?? "";
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.includes("@"));
}

export function isCreatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return resolveCreatorAllowlist().includes(email.trim().toLowerCase());
}

export async function requireCreator(): Promise<CreatorActor> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user?.email || !isCreatorEmail(data.user.email)) {
    throw new CreatorRequiredError();
  }

  return { userId: data.user.id, email: data.user.email };
}
