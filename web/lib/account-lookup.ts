import type { SupabaseClient } from "@supabase/supabase-js";

export type LookoutAccount = {
  userId: string;
  email: string;
  username: string | null;
};

export async function lookupUserByEmail(
  supabase: SupabaseClient,
  email: string,
): Promise<LookoutAccount | null> {
  const { data, error } = await supabase.rpc("lookup_rakyat_account_by_email", {
    p_email: email,
  });
  if (error || !data) return null;
  return {
    userId: String(data.user_id),
    email: String(data.email),
    username: data.username ?? null,
  };
}
