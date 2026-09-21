import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Regression: Cloudflare cleanup ordering (hardening 2026-09-21).
 *
 * Locked contract:
 *   1. The provider delete MUST happen BEFORE release_live_input. The release
 *      RPC nulls live_input_id — the last remaining retry handle — so a failed
 *      provider delete must leave the pointer in place for the next sweep.
 *   2. If the provider delete fails, live_input_id stays set (retry/sweep).
 *   3. HTTP 404 from the provider is already-cleaned: the pointer is released.
 *   4. The ended-input sweep follows the same order.
 *   5. Internal Live helpers are not EXECUTE-callable by public/anon (0013).
 */

const cloudflareSource = readFileSync(new URL("../lib/live/cloudflare.ts", import.meta.url), "utf8");
const serviceSource = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");
const capSource = readFileSync(new URL("../lib/live/session-service-cap.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(
  new URL("../supabase/migrations/0013_live_rpc_privilege_lockdown.sql", import.meta.url),
  "utf8",
);

function functionBody(source: string, name: string): string {
  const marker = `export async function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start > -1, `${name} must exist`);
  const rest = source.slice(start);
  const nextExport = rest.indexOf("\nexport ", 1);
  return nextExport > -1 ? rest.slice(0, nextExport) : rest;
}

test("Cleanup order 1: end path deletes the provider input before releasing the pointer", () => {
  const endBody = functionBody(serviceSource, "endLiveSession");

  const deleteOffset = endBody.indexOf("await deleteLiveInput(");
  const releaseOffset = endBody.indexOf('rpc("release_live_input"');
  assert.ok(deleteOffset > -1, "endLiveSession must call deleteLiveInput");
  assert.ok(releaseOffset > -1, "endLiveSession must call release_live_input");
  assert.ok(
    deleteOffset < releaseOffset,
    `provider delete (offset ${deleteOffset}) must run before release_live_input (offset ${releaseOffset})`,
  );

  // Exactly one release call, gated on provider-confirmed cleanup only.
  assert.equal([...endBody.matchAll(/rpc\("release_live_input"/g)].length, 1);
  assert.match(endBody, /outcome === "deleted" \|\| isLiveInputDeleteNotFound\(outcome\)/);
  // Failed delete: pointer retained for the sweep.
  assert.match(endBody, /pointer stays; the ended-input sweep retries later/);
});

test("Cleanup order 2: a failed provider delete never releases the pointer", () => {
  const deleteBody = functionBody(cloudflareSource, "deleteLiveInput");

  // Failed outcomes: missing config, non-ok status other than 404, network error.
  assert.match(deleteBody, /return "failed";/);
  assert.match(deleteBody, /response\.status === 404[\s\S]{0,80}return "not_found";/);
  assert.match(deleteBody, /return response\.ok \? "deleted" : "failed";/);
  assert.match(deleteBody, /catch \{[\s\S]{0,80}return "failed";\s*\}/);
  // "not_found" is the already-cleaned signal consumed by both release sites.
  assert.match(cloudflareSource, /export function isLiveInputDeleteNotFound/);
  assert.match(serviceSource, /isLiveInputDeleteNotFound/);
  assert.match(capSource, /isLiveInputDeleteNotFound/);
});

test("Cleanup order 3: HTTP 404 from the provider releases the pointer (already-cleaned)", () => {
  const endBody = functionBody(serviceSource, "endLiveSession");
  const sweepBody = functionBody(capSource, "sweepEndedLiveInputs");

  // Both call sites treat not_found exactly like a confirmed delete before
  // releasing the pointer — a 404 therefore releases live_input_id.
  assert.match(endBody, /isLiveInputDeleteNotFound\(outcome\)/);
  assert.match(sweepBody, /isLiveInputDeleteNotFound\(outcome\)/);
  // The boundary maps 404 to not_found (never "failed"): an already-deleted
  // input must not wedge the backlog.
  assert.match(functionBody(cloudflareSource, "deleteLiveInput"), /response\.status === 404/);
});

test("Cleanup order 4: the ended-input sweep applies the same delete-before-release order", () => {
  const sweepBody = functionBody(capSource, "sweepEndedLiveInputs");

  const deleteOffset = sweepBody.indexOf("await deleteLiveInput(");
  const releaseOffset = sweepBody.indexOf('rpc("release_live_input"');
  assert.ok(deleteOffset > -1, "sweepEndedLiveInputs must call deleteLiveInput");
  assert.ok(releaseOffset > -1, "sweepEndedLiveInputs must call release_live_input");
  assert.ok(
    deleteOffset < releaseOffset,
    `sweep delete (offset ${deleteOffset}) must run before release_live_input (offset ${releaseOffset})`,
  );

  // Failed delete: pointer stays in the backlog → retried on the next sweep.
  assert.match(sweepBody, /outcome !== "deleted" && !isLiveInputDeleteNotFound\(outcome\)/);
  assert.match(sweepBody, /keep the pointer for retry on the next sweep/);
  // The backlog lister is the retry source: released pointers vanish.
  assert.match(sweepBody, /list_ended_live_inputs/);
});

test("Cleanup order 5: sweep entry stays wired on the status poll (backstop coverage)", () => {
  const statusRouteSource = readFileSync(new URL("../app/api/live/status/route.ts", import.meta.url), "utf8");
  assert.match(statusRouteSource, /sweepEndedLiveInputs\(\)\.catch\(\(\) => 0\)/);
});

test("Gap 6: internal Live helpers are not EXECUTE-callable by public/anon (0013)", () => {
  // PUBLIC is the Postgres default for EXECUTE; each lockdown line must exist.
  for (const fn of [
    "public.assert_viewer_eligible(text)",
    "public.heal_live_duration_caps()",
    "public.release_live_input(text)",
    "public.list_ended_live_inputs()",
  ]) {
    assert.match(migrationSource, new RegExp(`revoke execute on function ${fn.replace("(", "\\(").replace(")", "\\)")}\\s*from public, anon;`));
  }

  // Server routes call the cleanup helpers as authenticated callers.
  for (const fn of [
    "public.assert_viewer_eligible(text)",
    "public.heal_live_duration_caps()",
    "public.release_live_input(text)",
    "public.list_ended_live_inputs()",
  ]) {
    assert.match(migrationSource, new RegExp(`grant execute on function ${fn.replace("(", "\\(").replace(")", "\\)")}\\s*to authenticated;`));
  }

  // Trigger functions keep NO direct EXECUTE anywhere (trigger execution is
  // owner-based; a PUBLIC EXECUTE grant there is pure surface area).
  assert.match(migrationSource, /revoke execute on function public\.block_live_audit_mutation\(\)\s*from public, anon, authenticated;/);
  assert.match(migrationSource, /revoke execute on function public\.live_stage_guard\(\)\s*from public, anon, authenticated;/);
  assert.doesNotMatch(migrationSource, /grant execute on function public\.(block_live_audit_mutation|live_stage_guard)/);

  // The client-facing cleanup RPCs (start/end) are NOT touched by 0013 —
  // their authenticated grants come from 0008/0012.
  assert.doesNotMatch(migrationSource, /revoke execute on function public\.(start_live_session|end_live_session)/);
});

test("Gap 6: trigger functions are trigger-called only (no EXECUTE grant anywhere)", () => {
  // The 0008 trigger definitions bind these functions to triggers — direct
  // EXECUTE access is never needed by any role.
  const base = readFileSync(new URL("../supabase/migrations/0008_live_sessions.sql", import.meta.url), "utf8");
  assert.match(base, /execute procedure public\.block_live_audit_mutation\(\)/);
  assert.match(base, /execute procedure public\.live_stage_guard\(\)/);
  assert.doesNotMatch(base, /grant execute on function public\.block_live_audit_mutation/);
  assert.doesNotMatch(base, /grant execute on function public\.live_stage_guard/);
});
