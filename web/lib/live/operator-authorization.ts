import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
} from "@/lib/auth/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
 * The outcome of the ONE authority decision, as a value instead of a boolean,
 * so every caller answers an unverified-email operator with the SAME precise,
 * actionable code (audit A-06/A-07) instead of a generic refusal.
 */
export type LiveOperateDecision =
  | { allowed: true; authority: "owner_manager" | "live_operator" }
  | {
      allowed: false;
      code: "producer_authorization_required" | "email_verification_required";
    };

/**
 * Producer owner/manager OR a delegated, non-revoked operator of this Place.
 *
 * A-06 (POLICY DECISION, operator-delegate scope only): the OPERATOR branch
 * additionally requires the account email to be confirmed
 * (auth.users.email_confirmed_at). The owner/manager branch is unchanged —
 * no master requires a verified email for a Pengelola Tempat.
 */
export async function decideLiveOperateAuthority(
  supabase: SupabaseClient,
  userId: string,
  placeId: string,
): Promise<LiveOperateDecision> {
  if (!userId || !placeId) {
    return { allowed: false, code: "producer_authorization_required" };
  }
  if (await isPlaceOwnerOrManager(supabase, userId, placeId)) {
    return { allowed: true, authority: "owner_manager" };
  }
  if (!(await hasActiveLiveOperatorAssignment(supabase, userId, placeId))) {
    return { allowed: false, code: "producer_authorization_required" };
  }
  if (!(await hasVerifiedAccountEmail(supabase, userId))) {
    return { allowed: false, code: "email_verification_required" };
  }
  return { allowed: true, authority: "live_operator" };
}

/** Boolean form of the same decision (Live end, management, discovery). */
export async function canOperateLiveForPlace(
  supabase: SupabaseClient,
  userId: string,
  placeId: string,
): Promise<boolean> {
  return (await decideLiveOperateAuthority(supabase, userId, placeId)).allowed;
}

/**
 * THE single START-LIVE authority gate.
 *
 * Audit A-07: the two Live-start endpoints applied DIFFERENT rules to the same
 * request — `POST /api/live/start` accepted a delegated operator while
 * `POST /api/producer/live/sessions` re-implemented a Producer-only check — so
 * the same caller could start Live on one endpoint and be refused on the other.
 * Both now call THIS function and nothing else: one authentication path
 * (requireAuthenticatedActor, so the server auth provider seam is shared), one
 * authority decision (canOperateLiveForPlace's rules), and one error identity
 * per outcome. An endpoint cannot drift: to change who may start Live, this
 * function is the only thing that changes.
 *
 * Resolves the caller itself; the Place always comes from the caller's own
 * request and is never taken from a session or another user's record.
 */
/**
 * How the start gate obtains its Supabase client. A module-level seam for the
 * test suite only — it mirrors `setServerAuthProvider` in lib/auth/server.ts,
 * is never set by production code, and cannot widen access: it only supplies
 * the client the same queries already run through.
 */
let liveAuthorityClientProvider: (() => Promise<SupabaseClient>) | null = null;

export function setLiveAuthorityClientProvider(
  provider: (() => Promise<SupabaseClient>) | null,
): void {
  liveAuthorityClientProvider = provider;
}

export async function requireLiveStartAuthority(
  request: Request,
  placeId: string,
): Promise<{ userId: string }> {
  const actor = await requireAuthenticatedActor(request);
  if (!placeId) throw new ProducerAuthorizationRequiredError();

  const supabase = liveAuthorityClientProvider
    ? await liveAuthorityClientProvider()
    : await createSupabaseServerClient();
  const decision = await decideLiveOperateAuthority(supabase, actor.userId, placeId);
  if (decision.allowed) {
    return { userId: actor.userId };
  }
  if (decision.code === "email_verification_required") {
    throw new LiveEmailVerificationRequiredError();
  }
  throw new ProducerAuthorizationRequiredError();
}

/**
 * The same outcome for the SAME failure, in every Live-start endpoint: audit
 * A-07 requires the two endpoints to answer a given input identically, so the
 * status/body mapping is shared too and neither route keeps its own copy.
 * Returns null for an error the caller must handle itself.
 */
export function liveStartAuthorityErrorResponse(
  error: unknown,
): { status: number; body: { error: string } } | null {
  if (error instanceof AuthenticationRequiredError) {
    return { status: 401, body: { error: "authentication_required" } };
  }
  if (error instanceof LiveEmailVerificationRequiredError) {
    return { status: 403, body: { error: "email_verification_required" } };
  }
  if (error instanceof ProducerAuthorizationRequiredError) {
    return { status: 403, body: { error: "producer_authorization_required" } };
  }
  return null;
}
