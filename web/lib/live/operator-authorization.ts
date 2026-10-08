import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Live start/end authorization.
 *
 * Two SEPARATE authorities can operate Live for a Place, and neither implies
 * the other:
 * - Producer authority: an owner/manager row in producer_memberships.
 * - Delegated operator authority: an ACTIVE assignment in public.live_operators
 *   for that EXACT Place (revoked_at is null).
 *
 * Knowing a place id is never enough: every check is scoped to the exact Place
 * and evaluated server-side.
 */

export async function hasActiveLiveOperatorAssignment(
  supabase: SupabaseClient,
  userId: string,
  placeId: string,
): Promise<boolean> {
  if (!userId || !placeId) return false;
  const { data } = await supabase
    .from("live_operators")
    .select("user_id")
    .eq("user_id", userId)
    .eq("place_id", placeId)
    .is("revoked_at", null)
    .maybeSingle();
  return Boolean(data);
}

export async function isPlaceOwnerOrManager(
  supabase: SupabaseClient,
  userId: string,
  placeId: string,
): Promise<boolean> {
  if (!userId || !placeId) return false;
  const { data } = await supabase
    .from("producer_memberships")
    .select("role")
    .eq("user_id", userId)
    .eq("place_id", placeId)
    .in("role", ["owner", "manager"])
    .maybeSingle();
  return Boolean(data);
}

/** Producer owner/manager OR a delegated, non-revoked operator of this Place. */
export async function canOperateLiveForPlace(
  supabase: SupabaseClient,
  userId: string,
  placeId: string,
): Promise<boolean> {
  const [producer, operator] = await Promise.all([
    isPlaceOwnerOrManager(supabase, userId, placeId),
    hasActiveLiveOperatorAssignment(supabase, userId, placeId),
  ]);
  return producer || operator;
}
