import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * User → Place Follow (task foundation for MASTER 10 notifications).
 *
 * Scope lock: this module implements ONLY the authoritative follow
 * relationship (one follow state per user + Place — row presence in
 * `place_follows`, PK (user_id, place_id)) and its server-side
 * authorization. No notification records, no push system, no polling — the
 * future notification path reads Follow rows from Supabase directly
 * (place_follows_place_idx exists for that fan-out).
 *
 * Server-side only by usage: every function requires the caller's session
 * client (identity = Supabase Auth user via auth.uid(), the existing auth
 * foundation) and enforces "own follows only" explicitly; RLS
 * (migration 0023) is the database-side backstop. Client components import
 * lib/place-follows-client instead — guarded by place-follows.test.ts.
 */

export type PlaceFollow = {
  userId: string;
  placeId: string;
  createdAt: string;
};

export class PlaceFollowPersistenceError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "PlaceFollowPersistenceError";
    this.code = code;
  }
}

export type FollowDecision =
  | { outcome: "created" }
  | { outcome: "exists" }
  | { outcome: "unfollowed" }
  | { outcome: "not_followed" };

function requireUserId(userId: string): string {
  if (!userId.trim()) {
    // Same contract as requireAuthenticatedActor — an empty identity is
    // never a follow. The API route maps this to 401.
    throw new Error("Authenticated user is required");
  }
  return userId;
}

function requirePlaceId(placeId: string): string {
  if (!placeId.trim()) {
    throw new Error("Place is required");
  }
  return placeId;
}

/** List the authenticated user's own followed Place ids. */
export async function listFollowedPlaceIds(client: SupabaseClient, userId: string): Promise<string[]> {
  const actorId = requireUserId(userId);
  const { data, error } = await client
    .from("place_follows")
    .select("place_id")
    .eq("user_id", actorId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => String(row.place_id));
}

/**
 * Follow a Place. Idempotent: PK (user_id, place_id) keeps exactly one
 * follow state per Place; a duplicate insert replays "exists".
 */
export async function followPlace(client: SupabaseClient, userId: string, placeId: string): Promise<FollowDecision> {
  const actorId = requireUserId(userId);
  const targetPlaceId = requirePlaceId(placeId);

  const { error } = await client
    .from("place_follows")
    .insert({ user_id: actorId, place_id: targetPlaceId });
  if (!error) return { outcome: "created" };

  // Unique violation → the follow already exists: not an error, the desired
  // state (followed) holds (idempotency pattern of visit_intents).
  if (error.code === "23505") return { outcome: "exists" };
  throw new PlaceFollowPersistenceError(error.message, error.code);
}

/** Unfollow a Place. Returns "not_followed" when nothing was deleted. */
export async function unfollowPlace(client: SupabaseClient, userId: string, placeId: string): Promise<FollowDecision> {
  const actorId = requireUserId(userId);
  const targetPlaceId = requirePlaceId(placeId);

  const { data, error } = await client
    .from("place_follows")
    .delete()
    .eq("user_id", actorId)
    .eq("place_id", targetPlaceId)
    .select("place_id");
  if (error) throw new PlaceFollowPersistenceError(error.message, error.code);
  return (data ?? []).length > 0 ? { outcome: "unfollowed" } : { outcome: "not_followed" };
}
