import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function lookupCurrentUsername(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData?.user) return null;

  const { data: userRow } = await supabase
    .from("users")
    .select("username")
    .eq("id", userData.user.id)
    .maybeSingle();

  return userRow?.username ?? null;
}
