import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AccountPlaceMembership = {
  placeId: string;
  /** The exact canonical Place name — never a raw place id as a label. */
  placeName: string;
  role: "owner" | "manager";
};

/**
 * The Places this account manages (Pengelola authority).
 *
 * Derived ONLY from `producer_memberships` rows where the account is
 * owner/manager — the same predicate every Producer capability uses. The
 * canonical Place name is resolved from `places` (RLS already lets a member
 * read their own Place), so the Account Center can name the Place it is
 * delegating Live access for instead of showing a place id.
 *
 * Membership is NEVER Live-operator authority and never contributes an
 * Operator Live card; that is a separate `live_operators` grant.
 */
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

  if (rowsError || !memberships?.length) return [];

  const placeIds = [...new Set(memberships.map((row) => String(row.place_id)))];
  const { data: places } = await supabase
    .from("places")
    .select("id, name")
    .in("id", placeIds);

  const nameById = new Map(
    (places ?? []).map((place) => [String(place.id), String(place.name)]),
  );

  const resolved: AccountPlaceMembership[] = [];
  for (const row of memberships) {
    const placeName = nameById.get(String(row.place_id));
    // A membership whose Place cannot be read is not a usable management
    // surface: showing a raw place id as the label would misreport the Place.
    if (!placeName) continue;
    resolved.push({
      placeId: String(row.place_id),
      placeName,
      role: (row.role as AccountPlaceMembership["role"]) ?? "manager",
    });
  }
  return resolved;
}
