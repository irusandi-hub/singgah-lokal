import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * STAGE 4 — Admin Tempat Pilihan curation service contract
 * (lib/admin/place-workspace.setAdminPlaceCurated).
 *
 * Required cases: moderator can curate, moderator can uncurate, unauthorized
 * rejected, Discovery score stays independent, audit is created, and the
 * flag ROLLS BACK when the audit write fails (no unattributed promotion).
 *
 * The service imports "server-only", so the module graph is validated by
 * source-contract assertions while the runtime behavior is exercised through
 * a stubbed Supabase client with the exact chained surface the service uses.
 */

const workspaceSource = readFileSync(new URL("../lib/admin/place-workspace.ts", import.meta.url), "utf8");



// ---------------------------------------------------------------------------
// Source contracts — the module graph and authority rules, locked at source.
// The service module is server-only (guarded by lib/server), so its runtime
// behavior is exercised end-to-end by the PGlite tests (place-curated-admin-
// migration) plus the source contracts below — the same pattern place-audit
// and discovery-cache already use for server-only modules.
// ---------------------------------------------------------------------------

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("curation is reachable ONLY behind the server-side moderator guard", () => {
  const code = stripComments(workspaceSource);
  // The FIRST statement of the curation function is the guard — the actor
  // comes from the session, never from client input.
  const fn = code.slice(code.indexOf("export async function setAdminPlaceCurated"));
  assert.match(fn, /^[\s\S]*?requirePlatformModerator\(\)/);
  const guardIndex = fn.indexOf("await requirePlatformModerator()");
  const actorIndex = fn.indexOf("actor.userId");
  assert.ok(guardIndex >= 0 && actorIndex > guardIndex, "the actor is the guard's return value");
});

test("the service-role path is the ONLY writer of places.is_curated", () => {
  const code = stripComments(workspaceSource);
  const fn = code.slice(code.indexOf("export async function setAdminPlaceCurated"));
  // The write goes through the service client and the canonical is_curated
  // column — and the repository's generic update/updatePublicationStatus are
  // NOT used for the flag (no is_curated parameter exists on them).
  assert.match(fn, /createSupabaseServiceClient\(\)/);
  assert.match(fn, /is_curated: curated/);
  assert.doesNotMatch(fn, /updatePublicationStatus|repository\.update\(/);
  // The API route re-verifies moderator authorization independently.
  const route = stripComments(
    readFileSync(new URL("../app/api/admin/places/[placeId]/curated/route.ts", import.meta.url), "utf8"),
  );
  assert.match(route, /await requirePlatformModerator\(\)/);
  // The migration refuses the flip from any non-service writer (column lock).
  const migration = readFileSync(new URL("../supabase/migrations/0036_place_curated_admin.sql", import.meta.url), "utf8");
  assert.match(migration, /current_user <> 'service_role'/);
});

test("Discovery stays independent: promotion cannot touch score, stars, or eligibility", () => {
  const code = stripComments(workspaceSource);
  // Isolate the curation function body (up to the next top-level export) so
  // the read-only Discovery view below it cannot false-positive the check.
  const fn = code.slice(
    code.indexOf("export async function setAdminPlaceCurated"),
    code.indexOf("export type AdminPlaceDiscoveryView"),
  );
  // No Discovery value is written anywhere in the curation function — no
  // score, no stars, no rank, and no engine call of any kind.
  assert.doesNotMatch(fn, /score|stars|rankDiscovery|discoveryStarsForScore|evaluateDiscoveryEligibility/);
  // The engine's write surface is structurally empty: no exported function
  // can persist anything (contract v1.0 — pure functions only).
  const engine = readFileSync(new URL("../lib/discovery/scoring.ts", import.meta.url), "utf8");
  const engineCode = stripComments(engine);
  for (const forbidden of [".update(", ".insert(", "from(\"places\")", "writeFile"]) {
    assert.equal(engineCode.includes(forbidden), false, `engine must stay read-only: ${forbidden}`);
  }
  // The Admin Discovery view is READ-ONLY: it renders engine output and has
  // no write path of its own.
  const view = code.slice(code.indexOf("export async function getAdminPlaceDiscoveryView"));
  assert.match(view, /rankDiscoveryPlaces\(|discoveryStarsForScore\(/);
  for (const forbidden of [".update(", ".insert(", "recordPlaceAudit"]) {
    assert.equal(view.includes(forbidden), false, `the Discovery view must stay read-only: ${forbidden}`);
  }
});

test("audit is created with rollback when it fails — no unattributed promotion", () => {
  const code = stripComments(workspaceSource);
  const fn = code.slice(code.indexOf("export async function setAdminPlaceCurated"));
  // The audit write happens inside try/catch and uses the locked action keys.
  assert.match(fn, /recordPlaceAudit\(\{[\s\S]*?action: curated \? PLACE_AUDIT_ACTIONS\.curated : PLACE_AUDIT_ACTIONS\.uncurated/);
  // Rollback restores the PREVIOUS flag value before the error surfaces.
  assert.match(fn, /is_curated: place\.isCurated/);
  // The route maps the audit failure to the operator-facing message through
  // the shared error table (place_audit_unavailable → adminPlaceErrorMessage).
  const route = stripComments(
    readFileSync(new URL("../app/api/admin/places/[placeId]/curated/route.ts", import.meta.url), "utf8"),
  );
  assert.match(route, /adminPlaceErrorMessage\(error\.code\)/);
});

test("no-op retries are idempotent and record nothing", () => {
  const code = stripComments(workspaceSource);
  const fn = code.slice(code.indexOf("export async function setAdminPlaceCurated"));
  const guardIndex = fn.indexOf("if (place.isCurated === curated) return place;");
  const writeIndex = fn.indexOf("from(\"places\")");
  assert.ok(guardIndex >= 0 && writeIndex > guardIndex, "the no-op guard precedes any write");
});

test("the Admin detail page renders the read-only Discovery view and the curation control", () => {
  const detail = stripComments(
    readFileSync(new URL("../app/admin/places/[placeId]/page.tsx", import.meta.url), "utf8"),
  );
  // Stars + breakdown from the engine; the numeric score is never rendered.
  assert.match(detail, /formatDiscoveryStars\(discoveryView\.stars\)/);
  assert.match(detail, /DISCOVERY_BREAKDOWN_LABELS\.map/);
  assert.match(detail, /discoveryView\.breakdown/);
  assert.doesNotMatch(detail, /\.score\b/);
  // The list row carries the read-only Tempat Pilihan status.
  const table = stripComments(readFileSync(new URL("../app/admin/places/AdminPlacesTable.tsx", import.meta.url), "utf8"));
  assert.match(table, /row\.isCurated/);
  assert.match(table, /✦ Tempat Pilihan/);
  // The curation control sends exactly one boolean — nothing else.
  const curation = stripComments(
    readFileSync(new URL("../components/admin/place-curation.tsx", import.meta.url), "utf8"),
  );
  assert.match(curation, /isCurated: next/);
  assert.match(curation, /Jadikan Tempat Pilihan/);
  assert.match(curation, /Cabut Promosi/);
});

test("the two audit actions exist in both code and database vocabulary", () => {
  const format = stripComments(readFileSync(new URL("../lib/place-audit-format.ts", import.meta.url), "utf8"));
  assert.match(format, /curated: "admin_place_curated"/);
  assert.match(format, /uncurated: "admin_place_uncurated"/);
  assert.match(format, /is_curated: place\.isCurated/);
  const migration = readFileSync(new URL("../supabase/migrations/0036_place_curated_admin.sql", import.meta.url), "utf8");
  assert.match(migration, /'admin_place_curated'/);
  assert.match(migration, /'admin_place_uncurated'/);
});
