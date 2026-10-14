import assert from "node:assert/strict";
import test, { before } from "node:test";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

import type * as AuthServerModule from "@/lib/auth/server";
import type * as LiveAuthorizationModule from "@/lib/live/operator-authorization";

/**
 * A-07 — THE TWO LIVE-START ENDPOINTS MUST NOT DISAGREE.
 *
 * The audit found `POST /api/live/start` and `POST /api/producer/live/sessions`
 * applying different authority rules to the same request: the first accepted a
 * delegated Live Operator, the second re-implemented a Producer-only check. The
 * same signed-in caller could therefore start a broadcast on one endpoint and
 * be refused on the other, and only one of them knew about the delegated
 * authority at all.
 *
 * Both routes now call ONE helper (requireLiveStartAuthority) on ONE shared
 * decision (decideLiveOperateAuthority) and answer its outcomes through ONE
 * mapper (liveStartAuthorityErrorResponse). The parity assertions below drive
 * the REAL handlers of both endpoints with the same input and compare the
 * status and body they produce; the Place / assignment / confirmed-email state
 * comes from a small fake PostgREST client, and the authenticated actor from
 * the existing server-auth-provider seam.
 *
 * Locked here:
 *  - owner/manager and a VERIFIED active operator pass the single gate;
 *  - an editor, an unrelated account, an owner of a DIFFERENT Place, a revoked
 *    operator and an operator whose email is unconfirmed are refused — and BOTH
 *    endpoints produce byte-equal answers for each of them;
 *  - an unauthenticated request is 401 on both;
 *  - neither route keeps its own membership/assignment query.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const operatorLib = read("../lib/live/operator-authorization.ts");
const startRoute = read("../app/api/live/start/route.ts");
const producerSessionsRoute = read("../app/api/producer/live/sessions/route.ts");

const PLACE = "rumah-teh-lokal";
const ACTOR = "11111111-1111-1111-1111-111111111111";

/**
 * lib/live/operator-authorization.ts carries the `server-only` marker, whose
 * entire job is to THROW outside a server runtime — which is exactly what a
 * node test process is. The marker's contract ("this module is never bundled
 * for the client") is a build concern; it is asserted by the source contract
 * below, and here it is neutralised so the REAL route handlers can run.
 *
 * `server-only` ships the empty module Next.js itself resolves for server
 * components; Node's synchronous resolve hook points the marker at it. The
 * routes are then imported dynamically, so nothing is loaded before the hook
 * is in place. Both use the `@/...` specifiers the routes themselves use: tsx
 * keys its module cache per specifier, and mixing `../lib/...` with
 * `@/lib/...` would hand this file a SECOND instance of the shared modules —
 * with its own auth provider, its own authority-client seam and its own error
 * classes, so `instanceof` would never match what the routes throw.
 */
type SyncHooks = {
  registerHooks?: (hooks: {
    resolve?: (
      specifier: string,
      context: unknown,
      nextResolve: (specifier: string, context: unknown) => unknown,
    ) => unknown;
  }) => void;
};

const SERVER_ONLY_STUB_URL = new URL("../node_modules/server-only/empty.js", import.meta.url).href;

type RouteHandler = (request: Request) => Promise<Response>;

let startRoutePost!: RouteHandler;
let producerSessionsPost!: RouteHandler;
let decideLiveOperateAuthority!: typeof LiveAuthorizationModule.decideLiveOperateAuthority;
let liveStartAuthorityErrorResponse!: typeof LiveAuthorizationModule.liveStartAuthorityErrorResponse;
let LiveEmailVerificationRequiredError!: typeof LiveAuthorizationModule.LiveEmailVerificationRequiredError;
let requireLiveStartAuthority!: typeof LiveAuthorizationModule.requireLiveStartAuthority;
let setLiveAuthorityClientProvider!: typeof LiveAuthorizationModule.setLiveAuthorityClientProvider;
let AuthenticationRequiredError!: typeof AuthServerModule.AuthenticationRequiredError;
let ProducerAuthorizationRequiredError!: typeof AuthServerModule.ProducerAuthorizationRequiredError;
let setServerAuthProvider!: typeof AuthServerModule.setServerAuthProvider;

let harness: Promise<void> | null = null;

function loadHarness(): Promise<void> {
  harness ??= (async () => {
    const nodeModule = (await import("node:module")) as unknown as SyncHooks;
    nodeModule.registerHooks?.({
      resolve(specifier, context, nextResolve) {
        if (specifier === "server-only") {
          return { url: SERVER_ONLY_STUB_URL, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });

    const authority = await import("@/lib/live/operator-authorization");
    decideLiveOperateAuthority = authority.decideLiveOperateAuthority;
    liveStartAuthorityErrorResponse = authority.liveStartAuthorityErrorResponse;
    LiveEmailVerificationRequiredError = authority.LiveEmailVerificationRequiredError;
    requireLiveStartAuthority = authority.requireLiveStartAuthority;
    setLiveAuthorityClientProvider = authority.setLiveAuthorityClientProvider;

    const authServer = await import("@/lib/auth/server");
    AuthenticationRequiredError = authServer.AuthenticationRequiredError;
    ProducerAuthorizationRequiredError = authServer.ProducerAuthorizationRequiredError;
    setServerAuthProvider = authServer.setServerAuthProvider;

    startRoutePost = (await import("@/app/api/live/start/route")).POST;
    producerSessionsPost = (await import("@/app/api/producer/live/sessions/route")).POST;
  })();
  return harness;
}

before(async () => {
  await loadHarness();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Membership = {
  user_id: string;
  place_id: string;
  producer_id: string;
  role: string;
} | null;
type OperatorRow = { user_id: string; place_id: string; revoked_at: string | null } | null;

/**
 * The smallest faithful stand-in for the PostgREST client the gate queries: it
 * APPLIES the filters the real queries send (eq / in / is), so a row the
 * database would exclude — an editor role, another Place, a revoked assignment
 * — is excluded here too. (Returning the row regardless would make these tests
 * agree with any rule at all.) `auth.getUser()` answers the authoritative
 * confirmed-at state.
 */
function fakeSupabaseClient(scenario: {
  membership?: Membership;
  operator?: OperatorRow;
  emailConfirmedAt?: string | null;
}): SupabaseClient {
  const from = (table: string) => {
    const equals: Record<string, unknown> = {};
    const sets: Record<string, readonly unknown[]> = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        equals[column] = value;
        return builder;
      },
      in: (column: string, values: readonly unknown[]) => {
        sets[column] = values;
        return builder;
      },
      is: (column: string, value: unknown) => {
        equals[column] = value;
        return builder;
      },
      maybeSingle: async () => {
        const row = (table === "producer_memberships"
          ? scenario.membership
          : table === "live_operators"
            ? scenario.operator
            : null) as Record<string, unknown> | null;
        if (!row) return { data: null, error: null };
        for (const [column, value] of Object.entries(equals)) {
          if ((row[column] ?? null) !== value) return { data: null, error: null };
        }
        for (const [column, values] of Object.entries(sets)) {
          if (!values.includes(row[column])) return { data: null, error: null };
        }
        return { data: row, error: null };
      },
    };
    return builder;
  };
  return {
    from,
    auth: {
      getUser: async () => ({
        data: { user: { id: ACTOR, email_confirmed_at: scenario.emailConfirmedAt ?? null } },
        error: null,
      }),
    },
  } as unknown as SupabaseClient;
}

type Scenario = {
  name: string;
  actor: string | null;
  membership?: Membership;
  operator?: OperatorRow;
  emailConfirmedAt?: string | null;
};

const OWNER: Scenario = {
  name: "owner membership, email unconfirmed (policy scope: still allowed)",
  actor: ACTOR,
  membership: { user_id: ACTOR, place_id: PLACE, producer_id: "prod-a", role: "owner" },
  emailConfirmedAt: null,
};

const MANAGER: Scenario = {
  name: "manager membership",
  actor: ACTOR,
  membership: { user_id: ACTOR, place_id: PLACE, producer_id: "prod-a", role: "manager" },
  emailConfirmedAt: "2026-10-01T00:00:00Z",
};

const EDITOR: Scenario = {
  name: "editor membership",
  actor: ACTOR,
  membership: { user_id: ACTOR, place_id: PLACE, producer_id: "prod-a", role: "editor" },
  emailConfirmedAt: "2026-10-01T00:00:00Z",
};

const OUTSIDER: Scenario = {
  name: "no membership, no assignment",
  actor: ACTOR,
  emailConfirmedAt: "2026-10-01T00:00:00Z",
};

const OTHER_PLACE_OWNER: Scenario = {
  name: "owner of a different Place",
  actor: ACTOR,
  membership: { user_id: ACTOR, place_id: "other-place", producer_id: "prod-b", role: "owner" },
  emailConfirmedAt: "2026-10-01T00:00:00Z",
};

const VERIFIED_OPERATOR: Scenario = {
  name: "active operator with a confirmed email",
  actor: ACTOR,
  membership: null,
  operator: { user_id: ACTOR, place_id: PLACE, revoked_at: null },
  emailConfirmedAt: "2026-10-01T00:00:00Z",
};

const UNVERIFIED_OPERATOR: Scenario = {
  name: "active operator whose email is unconfirmed",
  actor: ACTOR,
  membership: null,
  operator: { user_id: ACTOR, place_id: PLACE, revoked_at: null },
  emailConfirmedAt: null,
};

const REVOKED_OPERATOR: Scenario = {
  name: "revoked operator (no active assignment)",
  actor: ACTOR,
  membership: null,
  operator: null,
  emailConfirmedAt: "2026-10-01T00:00:00Z",
};

const SIGNED_OUT: Scenario = { name: "signed out", actor: null };

function armScenario(scenario: Scenario): void {
  setServerAuthProvider({
    authenticate: async () => (scenario.actor ? { userId: scenario.actor } : null),
  });
  setLiveAuthorityClientProvider(async () =>
    fakeSupabaseClient({
      membership: scenario.membership ?? null,
      operator: scenario.operator ?? null,
      emailConfirmedAt: scenario.emailConfirmedAt ?? null,
    }),
  );
}

function decideAs(scenario: Scenario) {
  return decideLiveOperateAuthority(
    fakeSupabaseClient({
      membership: scenario.membership ?? null,
      operator: scenario.operator ?? null,
      emailConfirmedAt: scenario.emailConfirmedAt ?? null,
    }),
    ACTOR,
    PLACE,
  );
}

function startRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/live/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = { placeId: PLACE, stageId: "stage-1", idempotencyKey: "key-1" };

async function bothEndpoints(input: unknown): Promise<{
  start: { status: number; body: unknown };
  producer: { status: number; body: unknown };
}> {
  const startResponse = await startRoutePost(startRequest(input));
  const producerResponse = await producerSessionsPost(startRequest(input));
  return {
    start: { status: startResponse.status, body: await startResponse.json() },
    producer: { status: producerResponse.status, body: await producerResponse.json() },
  };
}

// ---------------------------------------------------------------------------
// Source contract: one gate, one mapper, no second rule
// ---------------------------------------------------------------------------

test("A-07: both start endpoints use the ONE shared gate and error mapper", () => {
  for (const [name, source] of [
    ["/api/live/start", startRoute],
    ["/api/producer/live/sessions", producerSessionsRoute],
  ] as const) {
    assert.ok(
      source.includes("requireLiveStartAuthority"),
      `${name} must authorize through the shared gate`,
    );
    assert.ok(
      source.includes("liveStartAuthorityErrorResponse"),
      `${name} must answer through the shared mapper`,
    );
    // No endpoint keeps a private authority query.
    assert.doesNotMatch(source, /from\("live_operators"\)/, `${name} must not query assignments itself`);
    assert.doesNotMatch(source, /from\("producer_memberships"\)/, `${name} must not query memberships itself`);
  }

  // The Producer-only rule is gone from the start path of the console route.
  assert.doesNotMatch(
    producerSessionsRoute,
    /requireProducerAccess\(request, placeId/,
    "the console start path must not keep a second, Producer-only authority rule",
  );

  // The gate is the gate for BOTH routes: same call, same arguments.
  const gateCalls = [
    ...startRoute.matchAll(/requireLiveStartAuthority\(([^)]*)\)/g),
    ...producerSessionsRoute.matchAll(/requireLiveStartAuthority\(([^)]*)\)/g),
  ].map((match) => match[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(gateCalls, ["request, placeId", "request, placeId"]);

  // The module keeps its server-only marker (the import shim above exists for
  // this test process only — the app still cannot bundle it for a client).
  assert.ok(operatorLib.includes('import "server-only"'));

  // The single decision resolves both authorities separately (A-06 shape),
  // then the operator branch checks the confirmed email.
  const decideOffset = operatorLib.indexOf("export async function decideLiveOperateAuthority");
  assert.ok(decideOffset > -1, "decideLiveOperateAuthority must exist");
  const decideBody = operatorLib.slice(
    decideOffset,
    operatorLib.indexOf("export async function canOperateLiveForPlace"),
  );
  assert.match(decideBody, /isPlaceOwnerOrManager\(supabase, userId, placeId\)/);
  assert.match(decideBody, /hasActiveLiveOperatorAssignment\(supabase, userId, placeId\)/);
  assert.match(decideBody, /hasVerifiedAccountEmail\(supabase, userId\)/);
  assert.match(decideBody, /code: "email_verification_required"/);
});

// ---------------------------------------------------------------------------
// The shared decision itself
// ---------------------------------------------------------------------------

test("the shared decision admits exactly the two authorities, verified", async () => {
  for (const scenario of [OWNER, MANAGER, VERIFIED_OPERATOR]) {
    const decision = await decideAs(scenario);
    assert.equal(decision.allowed, true, `${scenario.name} must be allowed`);
  }

  assert.deepEqual(await decideAs(OWNER), { allowed: true, authority: "owner_manager" });
  assert.deepEqual(await decideAs(MANAGER), { allowed: true, authority: "owner_manager" });
  assert.deepEqual(await decideAs(VERIFIED_OPERATOR), { allowed: true, authority: "live_operator" });

  for (const scenario of [EDITOR, OUTSIDER, OTHER_PLACE_OWNER, REVOKED_OPERATOR]) {
    assert.deepEqual(
      await decideAs(scenario),
      { allowed: false, code: "producer_authorization_required" },
      scenario.name,
    );
  }

  assert.deepEqual(
    await decideAs(UNVERIFIED_OPERATOR),
    { allowed: false, code: "email_verification_required" },
    UNVERIFIED_OPERATOR.name,
  );

  // A blank Place is never authority.
  assert.deepEqual(
    await decideLiveOperateAuthority(
      fakeSupabaseClient({
        membership: { user_id: ACTOR, place_id: PLACE, producer_id: "prod-a", role: "owner" },
      }),
      ACTOR,
      "",
    ),
    { allowed: false, code: "producer_authorization_required" },
  );
});

test("the shared mapper answers one status/body per outcome, for both routes", () => {
  assert.deepEqual(liveStartAuthorityErrorResponse(new AuthenticationRequiredError()), {
    status: 401,
    body: { error: "authentication_required" },
  });
  assert.deepEqual(liveStartAuthorityErrorResponse(new LiveEmailVerificationRequiredError()), {
    status: 403,
    body: { error: "email_verification_required" },
  });
  assert.deepEqual(liveStartAuthorityErrorResponse(new ProducerAuthorizationRequiredError()), {
    status: 403,
    body: { error: "producer_authorization_required" },
  });
  // Anything else is the caller's own to handle (never swallowed as authority).
  assert.equal(liveStartAuthorityErrorResponse(new Error("live_cap_denied")), null);
});

// ---------------------------------------------------------------------------
// Parity through BOTH real route handlers
// ---------------------------------------------------------------------------

test("A-07: the two start endpoints answer every refusal identically", async () => {
  for (const scenario of [EDITOR, OUTSIDER, OTHER_PLACE_OWNER, REVOKED_OPERATOR, UNVERIFIED_OPERATOR]) {
    armScenario(scenario);
    const { start, producer } = await bothEndpoints(validBody);
    assert.equal(start.status, 403, `${scenario.name}: /api/live/start status`);
    assert.equal(producer.status, 403, `${scenario.name}: console status`);
    assert.deepEqual(start.body, producer.body, `${scenario.name}: the endpoints disagree`);
  }

  // The editor is refused with the generic code, not with the A-06 code.
  armScenario(EDITOR);
  const editor = await bothEndpoints(validBody);
  assert.deepEqual(editor.start.body, { error: "producer_authorization_required" });

  // An unconfirmed operator email → the A-06 code, on BOTH endpoints.
  armScenario(UNVERIFIED_OPERATOR);
  const unverified = await bothEndpoints(validBody);
  assert.deepEqual(unverified.start.body, { error: "email_verification_required" });
  assert.deepEqual(unverified.producer.body, { error: "email_verification_required" });

  // Unauthenticated → 401 on both, same body.
  armScenario(SIGNED_OUT);
  const anonymous = await bothEndpoints(validBody);
  assert.equal(anonymous.start.status, 401);
  assert.equal(anonymous.producer.status, 401);
  assert.deepEqual(anonymous.start.body, anonymous.producer.body);

  // Malformed input → the same validation answer on both (no client reached).
  armScenario(OUTSIDER);
  const malformed = await bothEndpoints({ placeId: PLACE });
  assert.equal(malformed.start.status, 400);
  assert.equal(malformed.producer.status, 400);
  assert.deepEqual(malformed.start.body, { error: "placeId_stage_idempotency_required" });
  assert.deepEqual(malformed.start, malformed.producer);

  // Anonymous AND malformed: still identical between the two endpoints.
  armScenario(SIGNED_OUT);
  const anonymousMalformed = await bothEndpoints({ placeId: PLACE });
  assert.deepEqual(anonymousMalformed.start, anonymousMalformed.producer);
});

test("A-07: the gate itself is the shared decision, not a re-implementation", async () => {
  armScenario(UNVERIFIED_OPERATOR);
  await assert.rejects(
    () => requireLiveStartAuthority(startRequest(validBody), PLACE),
    (error: unknown) => error instanceof LiveEmailVerificationRequiredError,
  );

  armScenario(EDITOR);
  await assert.rejects(
    () => requireLiveStartAuthority(startRequest(validBody), PLACE),
    (error: unknown) => error instanceof ProducerAuthorizationRequiredError,
  );

  armScenario(SIGNED_OUT);
  await assert.rejects(
    () => requireLiveStartAuthority(startRequest(validBody), PLACE),
    (error: unknown) => error instanceof AuthenticationRequiredError,
  );

  // A missing Place is never authority, even for a real owner.
  armScenario(OWNER);
  await assert.rejects(
    () => requireLiveStartAuthority(startRequest(validBody), ""),
    (error: unknown) => error instanceof ProducerAuthorizationRequiredError,
  );

  // Releasing the seams leaves production behaviour untouched (the routes go
  // back to the real server Supabase client and the real auth provider).
  setLiveAuthorityClientProvider(null);
  setServerAuthProvider({ authenticate: async () => null });
});
