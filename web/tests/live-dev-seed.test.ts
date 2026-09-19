import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// B2 dev-seed tests use the repo's source-shape pattern (readFileSync), like
// the migration tests, because `server-only` guards against Node imports and
// this module must only ever execute inside the Next.js server runtime.

const source = readFileSync(new URL("../lib/live/dev-seed.ts", import.meta.url), "utf8");

test("B2: production detection covers NODE_ENV and VERCEL_ENV", () => {
  assert.match(source, /NODE_ENV === "production" \|\| env\.VERCEL_ENV === "production"/);
  assert.match(source, /export function isProductionEnvironment/);
  // Defaults to the real process env.
  assert.match(source, /= process\.env/);
});

test("B2: seed refuses to run in production with no bypass flag", () => {
  assert.match(source, /if \(isProductionEnvironment\(\)\) \{/);
  assert.match(source, /throw new DevSeedProhibitedError\(\);/);
  assert.match(source, /live_dev_seed_prohibited_in_production/);
  assert.doesNotMatch(source, /allowProduction|force|skipProductionCheck/);
});

test("B2: seed delegates to the audited platform-role-gated grant RPC", () => {
  assert.match(source, /server-only/);
  assert.match(source, /grant_live_eligibility/);
  // The RPC itself enforces platform_role = 'platform_moderator'; dev-seed
  // never grants directly outside the audited path.
  assert.match(source, /p_producer_id: params\.producerId/);
  assert.match(source, /p_path: params\.path/);
});

test("B2: error class is exported for route handling", () => {
  assert.match(source, /export class DevSeedProhibitedError extends Error/);
});
