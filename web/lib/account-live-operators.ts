import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AccountLiveOperatorAssignment = {
  /** The exact Place the assignment is for. */
  placeId: string;
  /** The Place's canonical display name. Never a raw place id. */
  placeName: string;
  grantedAt: string;
};

/**
 * Delegated Live Operator assignments held by the signed-in account.
 *
 * Derived ONLY from public.live_operators rows that are ACTIVE
 * (`user_id = auth.uid()` and `revoked_at is null`). A Producer owner/manager
 * membership is NOT an operator assignment and never contributes a row here —
 * Producer authority and delegated operator access are separate grants.
 *
 * Each assignment carries the exact canonical Place name so the Account Center
 * shows the Place, never a raw id. An assignment whose Place name cannot be
 * read yields no card: showing a place id as a label would misreport the Place.
 */
export async function resolveLiveOperatorAssignments(): Promise<
  AccountLiveOperatorAssignment[]
> {
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: authError } = await supabase.auth.getUser();
  if (authError || !userData?.user) return [];

  const { data: assignments, error: assignmentsError } = await supabase
    .from("live_operators")
    .select("place_id, granted_at")
    .eq("user_id", userData.user.id)
    .is("revoked_at", null)
    .order("granted_at", { ascending: true });

  if (assignmentsError || !assignments?.length) return [];

  const placeIds = [
    ...new Set(assignments.map((row) => String(row.place_id))),
  ];
  const { data: places } = await supabase
    .from("places")
    .select("id, name")
    .in("id", placeIds);

  const nameById = new Map(
    (places ?? []).map((place) => [String(place.id), String(place.name)]),
  );

  const resolved: AccountLiveOperatorAssignment[] = [];
  for (const row of assignments) {
    const placeName = nameById.get(String(row.place_id));
    if (!placeName) continue;
    resolved.push({
      placeId: String(row.place_id),
      placeName,
      grantedAt: String(row.granted_at),
    });
  }
  return resolved;
}
