import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Live authorization — THE single server-side helper module for every Live
 * authority decision. Live start, Live end, Live management, and the Live
 * Operator invitation lifecycle all resolve authority through the functions
 * here; no endpoint re-implements its own membership or assignment query.
 *
 * Two SEPARATE authorities can operate Live for a Place, and neither implies
 * the other:
 * - Producer authority: an owner/manager row in producer_memberships.
 * - Delegated operator authority: an ACTIVE assignment in public.live_operators
 *   for that EXACT Place (revoked_at is null).
 *
 * Knowing a place id is never enough: every check is scoped to the exact Place
 * and evaluated server-side, on every call (no authorization cache — a
 * revocation takes effect on the very next Live action).
 */

export type PlaceManagerAuthority = {
  producerId: string;
  role: "owner" | "manager";
};

/**
 * Thrown when the caller holds an active delegated operator assignment but
 * their account email is not confirmed yet (audit A-06). Distinct from
 * ProducerAuthorizationRequiredError so the routes can answer with the
 * precise, actionable code `email_verification_required`.
 */
export class LiveEmailVerificationRequiredError extends Error {
  constructor() {
    super("email_verification_required");
  }
}

/**
 * The authoritative verified-email state, read from Supabase Auth on the
 * server (`auth.users.email_confirmed_at`) — never a client boolean or user
 * metadata. Fails closed: no resolvable user means NOT verified.
 */
export async function hasVerifiedAccountEmail(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  if (!userId) return false;
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user || user.id !== userId) return false;
  return Boolean(user.email_confirmed_at);
}

/**
 * The caller's Pengelola authority over ONE exact Place, or null.
 *
 * This is the predicate every management surface shares (Live operator
 * management, Live Operator invitations). `producerId` is the canonical
 * Producer identity used as `granted_by` / `invited_by_producer_id`; a client
 * never supplies it.
 */
export async function resolvePlaceManagerAuthority(
  supabase: SupabaseClient,
  userId: string,
  placeId: string,
): Promise<PlaceManagerAuthority | null> {
  if (!userId || !placeId) return null;
  const { data } = await supabase
    .from("producer_memberships")
    .select("producer_id, role")
    .eq("user_id", userId)
    .eq("place_id", placeId)
    .in("role", ["owner", "manager"])
    .maybeSingle();
  if (!data) return null;
  return {
    producerId: String(data.producer_id),
    role: data.role as PlaceManagerAuthority["role"],
  };
}

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
  return (await resolvePlaceManagerAuthority(supabase, userId, placeId)) !== null;
}

/**
 * Producer owner/manager OR a delegated, non-revoked operator of this Place.
 *
 * A-06 (POLICY DECISION, operator-delegate scope only): the OPERATOR branch
 * additionally requires the account email to be confirmed
 * (auth.users.email_confirmed_at). The owner/manager branch is unchanged —
 * no master requires a verified email for a Pengelola Tempat.
 */
export async function canOperateLiveForPlace(
  supabase: SupabaseClient,
  userId: string,
  placeId: string,
): Promise<boolean> {
  if (await isPlaceOwnerOrManager(supabase, userId, placeId)) return true;
  if (!(await hasActiveLiveOperatorAssignment(supabase, userId, placeId))) return false;
  return hasVerifiedAccountEmail(supabase, userId);
}
