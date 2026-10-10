/**
 * LIVE OPERATOR INVITATIONS — pure server core (no client, no I/O).
 *
 * Holds the two pieces every invitation endpoint shares and that are worth
 * unit-testing without a database:
 *  - the per-inviter rate limiter (anti-enumeration control at the invite
 *    endpoint, mirroring the Live comment limiter's in-process mechanism);
 *  - the mapping from the state-machine error codes raised by the SQL RPCs to
 *    the HTTP status + stable error code the routes return.
 *
 * The authoritative business rules live in the database (migration 0048) and
 * the RPCs; this module never decides authorization.
 */

import {
  LIVE_OPERATOR_INVITE_MIN_INTERVAL_MS,
} from "@/lib/live/operator-invitations-model";

export class OperatorInviteRateLimitedError extends Error {
  constructor() {
    super("live_operator_invite_rate_limited");
  }
}

/** Last accepted invite timestamp per inviter (in-process, single runtime). */
const lastInviteByInviter = new Map<string, number>();

/**
 * Throws when the inviter is inside the configured window. A DENIED attempt
 * never advances the window (the timestamp is written only on success), so a
 * burst cannot lock an inviter out indefinitely.
 */
export function enforceOperatorInviteRateLimit(
  inviterKey: string,
  now: number = Date.now(),
): void {
  const last = lastInviteByInviter.get(inviterKey) ?? 0;
  if (last > 0 && now - last < LIVE_OPERATOR_INVITE_MIN_INTERVAL_MS) {
    throw new OperatorInviteRateLimitedError();
  }
  lastInviteByInviter.set(inviterKey, now);
  if (lastInviteByInviter.size > 10_000) {
    for (const [key, at] of lastInviteByInviter) {
      if (now - at >= LIVE_OPERATOR_INVITE_MIN_INTERVAL_MS) {
        lastInviteByInviter.delete(key);
      }
    }
  }
}

/** Test-only reset so limiter state never bleeds between cases. */
export function resetOperatorInviteRateLimit(): void {
  lastInviteByInviter.clear();
}

export type InvitationHttpError = {
  status: number;
  code: string;
};

/**
 * Maps a Postgres error message raised by the invitation RPCs to the HTTP
 * response the route returns. Unknown failures become a fail-closed 503, never
 * a silent success.
 */
export function mapInvitationRpcError(message: string | undefined): InvitationHttpError {
  const text = message ?? "";
  const code = (candidates: string[]): string | null =>
    candidates.find((candidate) => text.includes(candidate)) ?? null;

  const matched = code([
    "authentication_required",
    "producer_authorization_required",
    "live_operator_invite_self_not_allowed",
    "live_operator_invite_rate_limited",
    "email_required",
    "email_invalid",
    "live_operator_invitation_forbidden",
    "live_operator_invitation_not_found",
    "live_operator_invitation_expired",
    "live_operator_invitation_invalid",
  ]);
  if (!matched) {
    return { status: 503, code: "live_operator_invitation_unavailable" };
  }

  switch (matched) {
    case "authentication_required":
      return { status: 401, code: matched };
    case "producer_authorization_required":
    case "live_operator_invitation_forbidden":
      return { status: 403, code: matched };
    case "live_operator_invite_rate_limited":
      return { status: 429, code: matched };
    case "live_operator_invitation_not_found":
      return { status: 404, code: matched };
    case "live_operator_invitation_expired":
      return { status: 409, code: matched };
    case "live_operator_invitation_invalid":
      return { status: 409, code: matched };
    default:
      return { status: 400, code: matched };
  }
}
