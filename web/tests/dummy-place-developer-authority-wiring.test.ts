import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";

/**
 * DEVELOPER AUTHORITY — WIRING & EXPOSURE (Master Dummy Place v1.0 §4).
 *
 * The database behaviour is proven on a real engine in
 * `dummy-place-developer-authority.test.ts`. This suite proves the thing a
 * SQL test cannot see: that the Creator path has NO client surface at all, and
 * that the pieces which cannot be executed here (the Creator gate, the audit
 * ordering) are wired the way the Master requires.
 *
 * The decisive check is the negative one: nothing under `app/` or `components/`
 * may reference the Developer Authority, and no API route may exist for it.
 * A service-role endpoint for Dummy mutation would be the single worst
 * possible outcome of this Master, so it is asserted absent, not merely unused.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

const boundary = read("../lib/developer/dummy-places.ts");
const core = read("../lib/developer/dummy-places-core.ts");

const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

const boundaryCode = stripComments(boundary);

/** Recursive file walk that works on this Node version (Dirent.path absent). */
function walk(dir: URL): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...walk(child));
    else out.push(child.pathname);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. No client surface at all
// ---------------------------------------------------------------------------

test("the Developer Authority module is server-only", () => {
  assert.match(boundary, /^import "server-only";/);
  // The pure core is the only part a client could ever import: no database
  // client, no network access, and it deliberately does NOT carry the marker.
  assert.doesNotMatch(core, /createSupabaseServiceClient|supabase-js|fetch\(/);
  assert.doesNotMatch(core, /^import "server-only";/m);
});

test("NO client component or API route references the Developer Authority", () => {
  const offenders: string[] = [];
  for (const dir of ["../components", "../app", "../hooks"]) {
    let entries: string[];
    try {
      entries = walk(new URL(`${dir}/`, import.meta.url));
    } catch {
      continue; // directory does not exist in this repo — nothing to scan
    }
    for (const file of entries) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      if (/dummy-places|dummy-riyadh|DeveloperPlace|setDeveloperPlace|is_dummy/.test(source)) {
        offenders.push(file.replace(/^.*\/web\//, ""));
      }
    }
  }
  assert.deepEqual(offenders, [], "no client component or API route may touch the Developer Authority");
});

test("there is NO service-role API route for Dummy mutation", () => {
  // A public route that flips is_dummy through the service role would be the
  // worst outcome of this Master. Assert the route does not exist.
  const routes = walk(new URL("../app/api/", import.meta.url)).filter((f) => f.endsWith("route.ts"));
  assert.ok(routes.length > 0, "the repo must still have its API routes to scan");
  for (const route of routes) {
    const source = readFileSync(route, "utf8");
    assert.doesNotMatch(source, /setDeveloperPlaceDummy|setDeveloperPlaceCurated|markRiyadhDummyPlacesCurated|is_dummy/);
  }
});

// ---------------------------------------------------------------------------
// 2. The Creator gate — fail closed, never platform_moderator
// ---------------------------------------------------------------------------

test("every entry point is gated by requireCreator()", () => {
  // All four exported operations must authorize before touching the database.
  for (const fn of [
    "export async function setDeveloperPlaceDummy",
    "export async function setDeveloperPlaceCurated",
    "export async function listDeveloperDummyPlaces",
    "export async function markRiyadhDummyPlacesCurated",
  ]) {
    assert.ok(boundaryCode.includes(fn), `${fn} must exist`);
  }
  // Three physical gates: the shared mutation runner, the listing, and the
  // batch helper. The two single-Place exports delegate to the runner, which is
  // where the gate lives — so no operation is reachable without authorizing.
  const gates = boundaryCode.match(/await requireCreator\(\);/g) ?? [];
  assert.equal(gates.length, 3, `expected three Creator gates, found ${gates.length}`);
  assert.match(boundaryCode, /import \{ requireCreator/);
  assert.match(boundaryCode, /const actor: CreatorActor = await requireCreator\(\);/);
});

test("the Developer Authority never grants or implies platform_moderator", () => {
  // Authority Master §4: the Creator is NOT platform_moderator and must never
  // be modelled as one.
  assert.doesNotMatch(boundaryCode, /platform_moderator/);
  assert.doesNotMatch(boundaryCode, /requirePlatformModerator/);
  assert.doesNotMatch(core, /platform_moderator|platform_role/);
  // It does not write the role column either.
  assert.doesNotMatch(boundaryCode, /platform_role/);
});

test("no secret, credential, or service-role key is exposed by the module", () => {
  // The module must not read any credential or publish a public env value.
  assert.doesNotMatch(boundaryCode, /SERVICE_ROLE|NEXT_PUBLIC_/);
  // The service client is a local import, never returned to a caller.
  assert.doesNotMatch(
    boundaryCode,
    /return\s+createSupabaseServiceClient\(\)|:\s*createSupabaseServiceClient\(\)\s*=>/,
  );
});

// ---------------------------------------------------------------------------
// 3. Audit ordering and rollback
// ---------------------------------------------------------------------------

test("the audit is written AFTER the change and a failure ROLLS THE CHANGE BACK", () => {
  const writeAt = boundaryCode.indexOf(".update({ ...patch");
  const auditAt = boundaryCode.indexOf("await recordPlaceAudit({");
  const rollbackAt = boundaryCode.indexOf("catch (error) {", auditAt);
  assert.ok(writeAt > 0 && auditAt > 0, "both the write and the audit must exist");
  assert.ok(writeAt < auditAt, "the change is written first, then audited");
  assert.ok(rollbackAt > auditAt, "the audit failure handler comes after the audit call");
  // The rollback writes the ORIGINAL value back before the error surfaces.
  assert.match(boundary, /Roll back BEFORE surfacing the failure/);
  assert.match(boundary, /place_audit_unavailable/);
  // The actor is the Creator's own id, never the service role.
  assert.match(boundaryCode, /actorId: actor\.userId/);
  assert.doesNotMatch(boundaryCode, /actorId:\s*["']?service/);
});

test("the reason is mandatory and normalized into the audit row", () => {
  assert.match(boundaryCode, /const reason = normalizeDeveloperReason\(params\.reason as string\);/);
  assert.match(boundaryCode, /detail: \{ operation: params\.operation, reason, developerAuthority: true \}/);
});

// ---------------------------------------------------------------------------
// 4. Scope limits
// ---------------------------------------------------------------------------

test("curation is wired to require a Dummy target, and nothing else is permitted", () => {
  assert.match(core, /export const DEVELOPER_PLACE_OPERATIONS = \["set_dummy", "set_curated"\] as const;/);
  assert.match(core, /operation === "set_curated" && !input\.target\.isDummy/);
  // Only these two operations exist — there is no delete/publish/claim verb.
  assert.doesNotMatch(core, /delete_place|set_publication_status|approve_claim|force/);
  // The boundary exposes no broader writer.
  assert.doesNotMatch(boundary, /export async function (delete|publish|approveClaim|force)/);
});

test("the DEV Riyadh helper promotes only Dummy fixtures, one audited decision each", () => {
  assert.match(boundaryCode, /for \(const placeId of RIYADH_DUMMY_PLACE_IDS\)/);
  assert.match(boundaryCode, /await setDeveloperPlaceCurated\(\{/);
  // It routes through the audited operation rather than writing the flag itself.
  assert.doesNotMatch(boundaryCode, /\.update\(\{ is_curated: true \}/);
});

// ---------------------------------------------------------------------------
// 5. Master consistency
// ---------------------------------------------------------------------------

test("the Master and MASTER_INDEX record this authority", () => {
  const master = read("../../docs/masters/MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0.md");
  const index = read("../../docs/masters/MASTER_INDEX_v1.0.md");

  // The Master is registered in the authority index.
  assert.match(index, /MASTER DEVELOPER AUTHORITY & DUMMY PLACE v1\.0/);
  assert.match(index, /MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1\.0\.md/);
  // The hierarchy is renumbered consistently.
  assert.match(index, /6\. MASTER AUTHORITY & ROLE STRUCTURE v1\.0/);
  assert.match(index, /7\. MASTER DEVELOPER AUTHORITY & DUMMY PLACE v1\.0/);

  // The locked points are actually written down.
  for (const clause of [
    "is_dummy",
    "set_curated",
    "platform_moderator",
    "no client",
    "append-only",
    "DEV ONLY",
  ]) {
    assert.match(master, new RegExp(clause, "i"), `Master must state: ${clause}`);
  }
  // It declares itself additive rather than silently overriding a locked master.
  assert.match(master, /additive/i);
  assert.match(master, /MASTER_AUTHORITY_STRUCTURE_v1\.0/);
});

test("migration 0039 does not weaken any existing protection", () => {
  const sql = stripComments(readMigration("0039_dummy_place_developer_authority.sql"));
  // Nothing is destroyed.
  assert.doesNotMatch(sql, /drop\s+table/i);
  assert.doesNotMatch(sql, /delete\s+from/i);
  assert.doesNotMatch(sql, /drop\s+column/i);
  // The append-only audit trigger from 0031 is never dropped or disabled.
  assert.doesNotMatch(sql, /block_place_audit_mutation/);
  // The 0036 curation lockdown is untouched — 0039 never mentions its function.
  assert.doesNotMatch(sql, /block_place_is_curated_update/);
  // RLS is not disabled anywhere.
  assert.doesNotMatch(sql, /disable row level security/i);
  assert.doesNotMatch(sql, /no\s+security\s+definer/i);
  // The backfill is an explicit id list, not a text predicate.
  assert.match(sql, /where id in \(/);
  assert.doesNotMatch(sql, /name\s+like\s+'%dummy%'i|short_description\s+like/i);
});