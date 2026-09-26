import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { followPlace, listFollowedPlaceIds, PlaceFollowPersistenceError, unfollowPlace } from "../lib/place-follows";

/**
 * Place Follow service contract (lib/place-follows.ts):
 * - identity is always the server-side actor (never client-supplied);
 * - duplicate follow stays idempotent (exists) instead of erroring;
 * - unfollow returns not_followed when there is nothing to delete;
 * - the API route never accepts a user identity from the request body.
 *
 * The Supabase client is stubbed with the exact chained-query surface the
 * repository uses, so failures here are contract drift, not mock drift.
 */

type Row = Record<string, unknown>;

type Call = { table: string; op: "select" | "insert" | "delete"; filters: Record<string, string>; values?: Row };

function makeClient(rowsByTable: { place_follows?: Row[] } = {}) {
  const calls: Call[] = [];
  let rows = rowsByTable.place_follows ? [...rowsByTable.place_follows] : [];
  let nextError: { code?: string; message: string } | null = null;

  const client = {
    from(table: string) {
      const state: { op: Call["op"]; values?: Row; filters: Record<string, string>; returning: boolean } = {
        op: "select",
        filters: {},
        returning: false,
      };
      const builder = {
        insert(values: Row) {
          state.op = "insert";
          state.values = values;
          return builder;
        },
        delete() {
          state.op = "delete";
          return builder;
        },
        select(_columns = "*") {
          state.returning = true;
          return builder;
        },
        eq(column: string, value: string) {
          state.filters[column] = value;
          return builder;
        },
        order(_column: string, _options?: Record<string, unknown>) {
          return builder;
        },
        async then(resolve: (result: { data: Row[] | null; error: typeof nextError }) => unknown) {
          calls.push({ table, op: state.op, filters: state.filters, values: state.values });
          if (state.op === "insert") {
            if (nextError) {
              const error = nextError;
              nextError = null;
              return resolve({ data: null, error });
            }
            rows = [...rows, state.values as Row];
            return resolve({ data: null, error: null });
          }
          if (state.op === "delete") {
            const matches = (row: Row) =>
              Object.entries(state.filters).every(([column, value]) => String(row[column]) === value);
            const removed = rows.filter(matches);
            rows = rows.filter((row) => !matches(row));
            return resolve({ data: state.returning ? removed : null, error: null });
          }
          return resolve({ data: rows, error: null });
        },
      };
      return builder;
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    calls,
    seed(follows: Row[]) {
      rows = [...follows];
    },
    failNext(error: { code?: string; message: string }) {
      nextError = error;
    },
    rows() {
      return rows;
    },
  };
}

test("followPlace inserts the actor's own row and reports the outcome", async () => {
  const harness = makeClient();
  const result = await followPlace(harness.client, "user-1", "kopi-dari-kebun");
  assert.deepEqual(result, { outcome: "created" });

  const call = harness.calls[0];
  assert.equal(call.table, "place_follows");
  assert.equal(call.op, "insert");
  assert.deepEqual(call.values, { user_id: "user-1", place_id: "kopi-dari-kebun" });
});

test("followPlace is idempotent: a unique violation replays as exists", async () => {
  const harness = makeClient();
  harness.failNext({ code: "23505", message: "duplicate key value violates unique constraint" });
  const result = await followPlace(harness.client, "user-1", "kopi-dari-kebun");
  assert.deepEqual(result, { outcome: "exists" });
});

test("followPlace rethrows non-duplicate persistence errors", async () => {
  const harness = makeClient();
  harness.failNext({ code: "42501", message: "new row violates row-level security policy" });
  await assert.rejects(
    () => followPlace(harness.client, "user-1", "kopi-dari-kebun"),
    (error: unknown) => error instanceof PlaceFollowPersistenceError && error.code === "42501",
  );
});

test("followPlace rejects a missing identity or Place before touching the database", async () => {
  const harness = makeClient();
  await assert.rejects(() => followPlace(harness.client, "  ", "kopi-dari-kebun"), /Authenticated user is required/);
  await assert.rejects(() => followPlace(harness.client, "user-1", ""), /Place is required/);
  assert.equal(harness.calls.length, 0, "no query may run for an invalid request");
});

test("unfollowPlace deletes only the actor's own row and reports honestly", async () => {
  const harness = makeClient();
  harness.seed([{ user_id: "user-1", place_id: "kopi-dari-kebun" }]);

  const result = await unfollowPlace(harness.client, "user-1", "kopi-dari-kebun");
  assert.deepEqual(result, { outcome: "unfollowed" });
  const call = harness.calls[0];
  assert.equal(call.op, "delete");
  assert.deepEqual(call.filters, { user_id: "user-1", place_id: "kopi-dari-kebun" });
  assert.equal(harness.rows().length, 0);

  // Nothing to delete → not_followed (never a fake success).
  const again = await unfollowPlace(harness.client, "user-1", "kopi-dari-kebun");
  assert.deepEqual(again, { outcome: "not_followed" });
});

test("unfollowPlace never deletes another user's follow", async () => {
  const harness = makeClient();
  harness.seed([{ user_id: "user-2", place_id: "kopi-dari-kebun" }]);
  const result = await unfollowPlace(harness.client, "user-1", "kopi-dari-kebun");
  assert.deepEqual(result, { outcome: "not_followed" });
  assert.equal(harness.rows().length, 1, "the other user's follow must survive");
});

test("listFollowedPlaceIds reads only the authenticated user's rows", async () => {
  const harness = makeClient();
  harness.seed([
    { user_id: "user-1", place_id: "kopi-dari-kebun" },
    { user_id: "user-1", place_id: "dapur-rasa" },
  ]);
  const ids = await listFollowedPlaceIds(harness.client, "user-1");
  assert.deepEqual(ids, ["kopi-dari-kebun", "dapur-rasa"]);
  assert.deepEqual(harness.calls[0].filters, { user_id: "user-1" });
});

test("unauthenticated identity is rejected on every operation", async () => {
  const harness = makeClient();
  await assert.rejects(() => listFollowedPlaceIds(harness.client, ""), /Authenticated user is required/);
  await assert.rejects(() => unfollowPlace(harness.client, "", "kopi-dari-kebun"), /Authenticated user is required/);
  assert.equal(harness.calls.length, 0);
});

test("the follow service stays server-side: client bundles import the client helper only", () => {
  // Boundary guard: the Place Card (client component) may import only the
  // thin fetch helper — never the server service module.
  const clientComponent = readFileSync(new URL("../components/place-follow-button.tsx", import.meta.url), "utf8");
  assert.match(clientComponent, /from "@\/lib\/place-follows-client"/);
  assert.doesNotMatch(clientComponent, /from "@\/lib\/place-follows"/, "client components must not import the server service");
  const clientHelper = readFileSync(new URL("../lib/place-follows-client.ts", import.meta.url), "utf8");
  assert.doesNotMatch(clientHelper, /server-only|createSupabaseServerClient|service_role/, "the client helper must stay credential-free");
});

// --- API route contract (source scan, repo convention for route guards) ----

const routeSource = readFileSync(new URL("../app/api/place-follows/route.ts", import.meta.url), "utf8");

test("API route enforces authentication server-side on every method", () => {
  const guards = routeSource.match(/requireAuthenticatedActor\(request\)/g) ?? [];
  assert.ok(guards.length >= 3, "GET, POST and DELETE must all authenticate");
  assert.match(routeSource, /authentication_required/, "signed-out callers get 401");
  // The user identity is NEVER taken from the request body.
  assert.doesNotMatch(routeSource, /(user_id|userId)\s*[:=][^;]*body/, "identity must come from the session only");
});

// --- Place Card wiring (source scan) ---------------------------------------

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const followButton = readFileSync(new URL("../components/place-follow-button.tsx", import.meta.url), "utf8");

test("Place Card shows the server-derived Follow/Following state", () => {
  assert.match(homeDiscovery, /PlaceFollowButton/, "the card must render the follow control");
  assert.match(followButton, /"Following"/, "the followed state must be visually distinct");
  assert.match(followButton, /aria-pressed=\{followed\}/);
  // State comes from the database via the API — never invented client-side.
  assert.match(followButton, /\/api\/place-follows/);
  assert.match(followButton, /setFollowed\(result\.followed\)/, "state flips only on server confirmation");
});

test("signed-out user cannot create a follow from the card", () => {
  assert.match(followButton, /response\.status === 401/, "signed-out is detected from the 401");
  assert.match(followButton, /\/auth\?returnTo=\//, "signed-out CTA routes to the existing auth flow");
  assert.doesNotMatch(followButton, /requestFollowPlace[\s\S]*sessionState !== "in"/, "no follow request while signed out");
});

test("card navigation and design stay untouched by the follow control", () => {
  // The follow control must not become the card link and must not alter the
  // LIVE/Direction affordances (scope lock).
  assert.match(homeDiscovery, /href=\{live \? `\/live\/\$\{live\.sessionId\}` : `\/places\/\$\{place\.id\}`\}/);
  assert.match(homeDiscovery, /LIVE — Lihat proses sekarang/);
  assert.match(homeDiscovery, /LIVE — Belum berlangsung/);
  // The button suppresses the wrapping card action.
  assert.match(followButton, /preventDefault\(\)/);
  assert.match(followButton, /stopPropagation\(\)/);
});
