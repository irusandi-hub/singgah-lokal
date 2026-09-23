import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * CREATOR SINGLE ACTIVE SESSION — atomic lease (Authority Master §2).
 *
 * Only one Creator account may hold the active Creator slot at a time. The
 * slot is a database lease bound to the Creator's own user id with a server
 * TTL, so:
 *  - a second Creator is refused BEFORE any CAPTCHA / secret question step;
 *  - the first Creator is never logged out or disturbed;
 *  - a crashed/closed browser cannot lock the slot forever (expiry);
 *  - concurrent logins are serialized by the database (unique partial index),
 *    so exactly one acquire wins a race.
 *
 * No password, secret answer, or token is used as the lock mechanism — the
 * lock is a server-owned database row keyed by user id. Regular users,
 * Producers, and Platform Admins never touch this module. Fail-closed: if
 * the service-role connection is unavailable, acquisition fails and the
 * Creator gate refuses to start (nothing is bypassed).
 */

const LEASE_TTL_MS = 60 * 60 * 1000; // 1 hour of inactivity releases the slot

/** Status types are intentionally coarse — never leak the other Creator's id/email in full. */
export type CreatorLeaseStatus =
  | { state: "free" }
  | { state: "mine" }
  | { state: "held-by-other"; sinceIso: string; expiresIso: string; maskedId: string };

/** Limited identifier of the active holder — safe to show to a refused Creator. */
function maskUserId(userId: string): string {
  return userId.length <= 8 ? "••••" : `${userId.slice(0, 4)}…${userId.slice(-4)}`;
}

type LeaseRow = {
  user_id: string;
  active_since: string;
  expires_at: string;
};

function serviceUnavailable(error: unknown): never {
  console.error("[creator/session-lease] service client unavailable:", error);
  throw new Error("creator_session_lease_unavailable");
}

async function readLease(): Promise<LeaseRow | null> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("creator_session_lease")
    .select("user_id, active_since, expires_at")
    .limit(1)
    .maybeSingle<LeaseRow>();
  if (error) serviceUnavailable(error);
  // Expired rows do not count: the partial index already ignores them for
  // acquisition, so reading must apply the same predicate.
  if (!data) return null;
  return new Date(data.expires_at).getTime() > Date.now() ? data : null;
}

/** Current holder of the slot, from the Creator's own limited viewpoint. */
export async function getCreatorLeaseStatus(userId: string): Promise<CreatorLeaseStatus> {
  const lease = await readLease();
  if (!lease) return { state: "free" };
  if (lease.user_id === userId) return { state: "mine" };
  return {
    state: "held-by-other",
    sinceIso: lease.active_since,
    expiresIso: lease.expires_at,
    maskedId: maskUserId(lease.user_id),
  };
}

/**
 * Atomically acquire or extend the lease for this Creator. Returns the
 * authoritative verdict: only the user whose row actually persisted owns the
 * slot. Upsert with on-conflict update + explicit user filter, then re-read:
 * if a concurrent acquire replaced our row between write and read, the
 * returned owner reflects the true winner.
 */
export async function acquireCreatorLease(userId: string): Promise<CreatorLeaseStatus> {
  const now = Date.now();
  const expiresIso = new Date(now + LEASE_TTL_MS).toISOString();
  const supabase = createSupabaseServiceClient();

  const { error: upsertError } = await supabase.from("creator_session_lease").upsert(
    { user_id: userId, expires_at: expiresIso, updated_at: new Date(now).toISOString() },
    { onConflict: "user_id" },
  );
  if (upsertError) serviceUnavailable(upsertError);

  // Authoritative re-read decides ownership (race-safe).
  return getCreatorLeaseStatus(userId);
}

/** Refresh the TTL of an existing lease. Returns false when not the holder. */
export async function heartbeatCreatorLease(userId: string): Promise<boolean> {
  const status = await getCreatorLeaseStatus(userId);
  if (status.state !== "mine") return false;
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase
    .from("creator_session_lease")
    .update({ expires_at: new Date(Date.now() + LEASE_TTL_MS).toISOString(), updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) serviceUnavailable(error);
  return true;
}

/**
 * Release the slot via the advisory-lock-guarded RPC. Called on Creator
 * sign-out; safe to call when the slot is already free or expired.
 */
export async function releaseCreatorLease(userId: string): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.rpc("release_creator_session_lease", { p_user_id: userId });
    if (error) throw error;
  } catch (error) {
    // Never blocks sign-out; worst case the lease simply expires.
    console.error("[creator/session-lease] release failed:", error);
  }
}

/** Lease TTL in ms (exported for tests/documentation purposes only). */
export const CREATOR_LEASE_TTL_MS = LEASE_TTL_MS;
