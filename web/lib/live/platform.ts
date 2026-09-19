import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Platform Admin/Moderator authorization (B2; policy §12.2 #3).
 * Platform moderators are identified by `public.users.platform_role`.
 * Fail closed: unknown user, missing row, or missing role => denied.
 */

export type PlatformActor = {
  userId: string;
  platformRole: "platform_moderator";
};

export class PlatformModeratorRequiredError extends Error {
  constructor() {
    super("Platform moderator authorization is required");
  }
}

export async function requirePlatformModerator(): Promise<PlatformActor> {
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    throw new PlatformModeratorRequiredError();
  }

  const { data: row } = await supabase
    .from("users")
    .select("platform_role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (row?.platform_role !== "platform_moderator") {
    throw new PlatformModeratorRequiredError();
  }

  return { userId: userData.user.id, platformRole: "platform_moderator" };
}
