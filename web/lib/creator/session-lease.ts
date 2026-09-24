import "server-only";

import { requireCreator, type CreatorActor } from "@/lib/auth/creator";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/** Keep a Creator gate session short-lived; callers may renew with acquire. */
export const CREATOR_SESSION_LEASE_TTL_SECONDS = 15 * 60;

export class CreatorLeaseError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Creator session lease failed: ${code}`);
    this.code = code;
  }
}

function defaultExpiry(): Date {
  return new Date(Date.now() + CREATOR_SESSION_LEASE_TTL_SECONDS * 1000);
}

function serializeExpiry(expiresAt: Date | string | undefined): string {
  const value = expiresAt === undefined ? defaultExpiry() : new Date(expiresAt);
  if (!Number.isFinite(value.getTime()) || value.getTime() <= Date.now()) {
    throw new CreatorLeaseError("invalid_expiry");
  }
  return value.toISOString();
}

function ensureCurrentCreator(creator: CreatorActor, requestedUserId?: string): string {
  const userId = requestedUserId ?? creator.userId;
  if (userId !== creator.userId) {
    throw new CreatorLeaseError("creator_identity_mismatch");
  }
  return userId;
}

/**
 * Atomically acquire or renew the single Creator session slot.
 *
 * The database owns the singleton and the transaction-scoped advisory lock;
 * this server-only wrapper must never upsert the table directly.  requireCreator
 * is always checked first, and an explicit user id may only be the current
 * Creator.  A false result means another Creator currently owns the active
 * lease; database/RPC failures are surfaced and never treated as success.
 */
export async function acquireCreatorLease(
  requestedUserId?: string,
  requestedExpiresAt?: Date | string,
): Promise<boolean> {
  const creator = await requireCreator();
  const userId = ensureCurrentCreator(creator, requestedUserId);
  const expiresAt = serializeExpiry(requestedExpiresAt);
  const supabase = createSupabaseServiceClient();

  const { data, error } = await supabase.rpc("acquire_creator_session_lease", {
    p_user_id: userId,
    p_expires_at: expiresAt,
  });

  if (error) throw new CreatorLeaseError("acquire_failed");
  return data === true;
}

/**
 * Release the current Creator's lease.  A stale owner cannot clear a lease
 * that another Creator has already acquired; the RPC is idempotently safe and
 * returns false for a missing, expired-and-replaced, or foreign lease.
 */
export async function releaseCreatorLease(userId?: string): Promise<boolean> {
  const creator = await requireCreator();
  const targetUserId = ensureCurrentCreator(creator, userId);
  const supabase = createSupabaseServiceClient();

  const { data, error } = await supabase.rpc("release_creator_session_lease", {
    p_user_id: targetUserId,
  });

  if (error) throw new CreatorLeaseError("release_failed");
  return data === true;
}
