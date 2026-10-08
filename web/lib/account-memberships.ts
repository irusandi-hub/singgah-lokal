import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AccountPlaceMembership = {
  placeId: string;
  role: "owner" | "manager";
};

export async function resolvePlaceMemberships(): Promise<AccountPlaceMembership[]> {
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData?.user) return [];

  const { data: memberships, error: rowsError } = await supabase
    .from("producer_memberships")
    .select("place_id, role")
    .eq("user_id", userData.user.id)
    .in("role", ["owner", "manager"])
    .order("created_at", { ascending: true });

  if (rowsError) return [];

  return [...(memberships ?? [])].map((row) => ({
    placeId: String(row.place_id),
    role: (row.role as AccountPlaceMembership["role"]) ?? "manager",
  }));
}
