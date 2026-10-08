import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * LIVE AUTHORIZATION — delegated operator access.
 *
 * Two SEPARATE authorities can operate Live for a Place, and neither implies
 * the other:
 * - Producer authority: owner/manager in producer_memberships.
 * - Delegated operator authority: an ACTIVE live_operators assignment for the
 *   EXACT Place (revoked_at is null).
 *
 * These lock the server-side checks: no client-supplied Place/identity may
 * widen access, revocation must be honoured, and the Producer path must stay
 * intact.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const operatorLib = read("../lib/live/operator-authorization.ts");
const startRoute = read("../app/api/live/start/route.ts");
const endRoute = read("../app/api/live/end/route.ts");
const accountLiveAccess = read("../app/api/account/live-access/route.ts");
const accountLiveOperators = read("../app/api/account/live-operators/route.ts");
const producerLiveRoute = read("../app/api/producer/live/sessions/route.ts");

test("operator authority is an ACTIVE assignment for the exact Place", () => {
  assert.ok(operatorLib.includes('import "server-only"'), "authorization stays server-side");
  assert.ok(operatorLib.includes('from("live_operators")'));
  assert.ok(operatorLib.includes('eq("user_id", userId)'));
  assert.ok(operatorLib.includes('eq("place_id", placeId)'), "an assignment is scoped to the exact Place");
  assert.ok(operatorLib.includes('is("revoked_at", null)'), "a revoked assignment is not access");
  assert.doesNotMatch(operatorLib, /select\("id"\)/, "live_operators has no id column; select a real column");
});

test("Producer and Operator authority are checked separately and never merged", () => {
  assert.ok(operatorLib.includes('from("producer_memberships")'));
  assert.ok(operatorLib.includes('in("role", ["owner", "manager"])'));
  assert.ok(operatorLib.includes("hasActiveLiveOperatorAssignment"));
  assert.ok(operatorLib.includes("isPlaceOwnerOrManager"));
  assert.ok(operatorLib.includes("canOperateLiveForPlace"));
  assert.ok(operatorLib.includes("producer || operator"), "either authority may operate, but each is established on its own");
});

test("Live start requires Producer owner/manager OR a delegated operator for the Place", () => {
  assert.ok(startRoute.includes("canOperateLiveForPlace"));
  assert.ok(startRoute.includes("authentication_required"));
  assert.ok(startRoute.includes("producer_authorization_required"));
  assert.doesNotMatch(startRoute, /select\("id"\)/);
  // The Producer-only entry point is unchanged: it still requires owner/manager.
  assert.ok(producerLiveRoute.includes('requireProducerAccess(request, placeId, ["owner", "manager"])'));
});

test("Live end derives the Place from the session, never from client input", () => {
  assert.ok(endRoute.includes('select("place_id")'));
  assert.ok(endRoute.includes("session.place_id"), "authorization uses the session's Place");
  assert.ok(endRoute.includes("canOperateLiveForPlace"));
  assert.ok(endRoute.includes("live_session_not_found"));
  assert.doesNotMatch(endRoute, /body\.placeId/, "the client cannot name the Place");
});

test("Account live-access reads only active assignments", () => {
  assert.ok(accountLiveAccess.includes('from("live_operators")'));
  assert.ok(accountLiveAccess.includes('is("revoked_at", null)'));
});

test("Live Operator management stays an owner/manager capability", () => {
  assert.ok(accountLiveOperators.includes('in("role", ["owner", "manager"])'));
  assert.ok(accountLiveOperators.includes("producer_authorization_required"));
  assert.ok(accountLiveOperators.includes("grant_live_operator_access"));
  assert.ok(accountLiveOperators.includes("revoke_live_operator_access"));
  // granted_by is derived inside the RPC, not accepted from the client.
  assert.doesNotMatch(accountLiveOperators, /p_producer_id/);
});
