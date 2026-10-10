import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  enforceOperatorInviteRateLimit,
  mapInvitationRpcError,
  OperatorInviteRateLimitedError,
  resetOperatorInviteRateLimit,
} from "@/lib/live/operator-invitation-core";
import { LIVE_OPERATOR_INVITE_MIN_INTERVAL_MS } from "@/lib/live/operator-invitations-model";

/**
 * LIVE OPERATOR INVITATIONS — endpoint contracts + pure core.
 *
 * The DB lifecycle is exercised in live-operator-invitations-migration.test.ts
 * on a real Postgres engine. These lock the HTTP layer: authority comes from the
 * single Live authorization helper, the invite endpoint has a uniform
 * (non-enumerating) response and a rate limit, and no endpoint exposes a user
 * directory or email lookup.
 */

const read = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const inviteRoute = read("app/api/account/live-operators/invitations/route.ts");
const cancelRoute = read(
  "app/api/account/live-operators/invitations/[invitationId]/cancel/route.ts",
);
const revokeRoute = read(
  "app/api/account/live-operators/invitations/[invitationId]/revoke/route.ts",
);
const inviteeListRoute = read("app/api/live-operator-invitations/route.ts");
const acceptRoute = read(
  "app/api/live-operator-invitations/[invitationId]/accept/route.ts",
);
const rejectRoute = read(
  "app/api/live-operator-invitations/[invitationId]/reject/route.ts",
);
const startRoute = read("app/api/live/start/route.ts");
const endRoute = read("app/api/live/end/route.ts");
const authorizationLib = read("lib/live/operator-authorization.ts");

// ---------------------------------------------------------------------------
// Pure core: rate limiter + error mapping
// ---------------------------------------------------------------------------

test("the invite rate limiter rejects a burst and never extends on a denial", () => {
  resetOperatorInviteRateLimit();
  const t0 = 1_000_000;
  enforceOperatorInviteRateLimit("manager-1", t0);
  assert.throws(
    () => enforceOperatorInviteRateLimit("manager-1", t0 + 10),
    (error: unknown) => error instanceof OperatorInviteRateLimitedError,
  );
  // The denied attempt did not move the window: still denied just before it
  // would have elapsed from the ACCEPTED attempt...
  assert.throws(() => enforceOperatorInviteRateLimit("manager-1", t0 + LIVE_OPERATOR_INVITE_MIN_INTERVAL_MS - 1));
  // ...and allowed once the accepted attempt's window elapses.
  enforceOperatorInviteRateLimit("manager-1", t0 + LIVE_OPERATOR_INVITE_MIN_INTERVAL_MS);
  // A different inviter is unaffected.
  enforceOperatorInviteRateLimit("manager-2", t0 + 1);
  resetOperatorInviteRateLimit();
});

test("RPC errors map to fail-closed HTTP statuses and stable codes", () => {
  assert.deepEqual(mapInvitationRpcError("error: producer_authorization_required"), {
    status: 403,
    code: "producer_authorization_required",
  });
  assert.deepEqual(mapInvitationRpcError("live_operator_invite_self_not_allowed"), {
    status: 400,
    code: "live_operator_invite_self_not_allowed",
  });
  assert.deepEqual(mapInvitationRpcError("live_operator_invite_rate_limited"), {
    status: 429,
    code: "live_operator_invite_rate_limited",
  });
  assert.deepEqual(mapInvitationRpcError("live_operator_invitation_not_found"), {
    status: 404,
    code: "live_operator_invitation_not_found",
  });
  assert.deepEqual(mapInvitationRpcError("live_operator_invitation_invalid"), {
    status: 409,
    code: "live_operator_invitation_invalid",
  });
  // Anything unrecognised is a hard failure, never a silent success.
  assert.deepEqual(mapInvitationRpcError("connection reset"), {
    status: 503,
    code: "live_operator_invitation_unavailable",
  });
});

// ---------------------------------------------------------------------------
// Manager endpoints
// ---------------------------------------------------------------------------

test("the invite endpoint is authenticated, manager-gated through the helper, and rate limited", () => {
  assert.match(inviteRoute, /authentication_required/);
  assert.match(inviteRoute, /isPlaceOwnerOrManager\(supabase, userData\.user\.id, placeId\)/);
  assert.match(inviteRoute, /producer_authorization_required/);
  assert.match(inviteRoute, /enforceOperatorInviteRateLimit\(userData\.user\.id\)/);
  assert.match(inviteRoute, /live_operator_invite_rate_limited/);
  assert.match(inviteRoute, /rpc\("invite_live_operator", \{/);
});

test("the invite endpoint answers uniformly and exposes no directory or email lookup", () => {
  const code = stripComments(inviteRoute);
  // One success shape for email-found and email-unknown alike.
  assert.match(code, /invited: true/);
  // No direct account read, no username lookup, no auto-create.
  assert.doesNotMatch(code, /\.from\("users"\)/);
  assert.doesNotMatch(code, /resolve_account_by_username|auth\.admin|signUp/);
  // The email is passed to the RPC only; it is never resolved in the route.
  assert.match(code, /p_email: email/);
});

test("the manager list endpoint is helper-gated and scoped to the exact Place", () => {
  assert.match(inviteRoute, /list_place_live_operator_invitations/);
  assert.match(inviteRoute, /new URL\(request\.url\)\.searchParams\.get\("placeId"\)/);
  assert.match(inviteRoute, /isPlaceOwnerOrManager/);
});

test("cancel and revoke act by invitation id only (no client Place), via the state-machine RPCs", () => {
  for (const [name, route, rpc] of [
    ["cancel", cancelRoute, "cancel_live_operator_invitation"],
    ["revoke", revokeRoute, "revoke_live_operator_invitation"],
  ] as const) {
    assert.match(route, /authentication_required/, `${name} requires a session`);
    assert.match(route, new RegExp(`rpc\\("${rpc}"`), `${name} calls the state-machine RPC`);
    assert.match(route, /p_invitation_id: invitationId/);
    assert.doesNotMatch(stripComments(route), /body\.placeId|p_place_id/, `${name} cannot name a Place`);
  }
});

// ---------------------------------------------------------------------------
// Invitee endpoints
// ---------------------------------------------------------------------------

test("the invitee list is the caller's own invitations, from the invitee RPC", () => {
  assert.match(inviteeListRoute, /authentication_required/);
  assert.match(inviteeListRoute, /rpc\("list_my_live_operator_invitations"\)/);
  assert.match(inviteeListRoute, /invitedByName/);
});

test("accept and reject call the invitee-only RPCs by invitation id", () => {
  assert.match(acceptRoute, /rpc\("accept_live_operator_invitation"/);
  assert.match(acceptRoute, /p_invitation_id: invitationId/);
  assert.match(rejectRoute, /rpc\("reject_live_operator_invitation"/);
  assert.match(rejectRoute, /p_invitation_id: invitationId/);
  for (const route of [acceptRoute, rejectRoute]) {
    assert.match(route, /authentication_required/);
  }
});

// ---------------------------------------------------------------------------
// Single authorization helper across Live start / stop / management
// ---------------------------------------------------------------------------

test("start and stop resolve authority through the single Live helper on every call", () => {
  assert.match(startRoute, /canOperateLiveForPlace\(supabase, userData\.user\.id, placeId\)/);
  assert.match(endRoute, /canOperateLiveForPlace\(/);
  assert.match(endRoute, /session\.place_id/);
  // The helper itself has no authorization cache: each predicate is a fresh
  // query that requires an ACTIVE assignment (revoked_at is null).
  assert.match(authorizationLib, /\.is\("revoked_at", null\)/);
  assert.match(authorizationLib, /\.eq\("user_id", userId\)/);
  assert.match(authorizationLib, /\.eq\("place_id", placeId\)/);
  assert.doesNotMatch(
    authorizationLib,
    /let\s+\w*(cache|cached|memo)/i,
    "authorization must not be cached",
  );
});
