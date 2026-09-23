import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

const adminQueries = readFileSync(new URL("../lib/admin/queries.ts", import.meta.url), "utf8");
const adminLayout = readFileSync(new URL("../app/admin/layout.tsx", import.meta.url), "utf8");
const adminUsers = readFileSync(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8");
const adminOverview = readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
const adminLive = readFileSync(new URL("../app/admin/live/page.tsx", import.meta.url), "utf8");

const adminPages = [
  { path: "../app/admin/page.tsx", label: "Overview" },
  { path: "../app/admin/users/page.tsx", label: "Users" },
  { path: "../app/admin/producers/page.tsx", label: "Producers" },
  { path: "../app/admin/producer-membership/page.tsx", label: "Producer Membership" },
  { path: "../app/admin/places/page.tsx", label: "Places" },
  { path: "../app/admin/experiences/page.tsx", label: "Experiences" },
  { path: "../app/admin/visit-intents/page.tsx", label: "Visit Intents" },
  { path: "../app/admin/live/page.tsx", label: "Live" },
  { path: "../app/admin/moderation/page.tsx", label: "Moderation" },
];

test("Admin Center covers exactly the locked MVP sections", () => {
  for (const page of adminPages) {
    assert.equal(existsSync(new URL(page.path, import.meta.url)), true, `${page.label} page missing`);
  }
});

test("Every admin page and the layout are server-rendered and dynamic", () => {
  for (const file of [adminLayout, adminOverview, adminUsers, adminLive, ...adminPages.slice(2).map(({ path }) => readFileSync(new URL(path, import.meta.url), "utf8"))]) {
    assert.match(file, /export const dynamic = "force-dynamic"/);
  }
});

test("Admin data layer re-verifies platform moderator authorization on every read", () => {
  // Every exported read goes through requirePlatformModerator — fail closed.
  const exportsNeedingAuth = [
    "getAdminOverview",
    "listAdminUsers",
    "listAdminProducers",
    "listAdminMemberships",
    "listAdminPlaces",
    "listAdminExperiences",
    "listAdminVisitIntents",
    "listAdminLiveSessions",
    "listAdminLiveReports",
    "listAdminEligibility",
    "listAdminAudit",
  ];
  for (const name of exportsNeedingAuth) {
    const fn = adminQueries.slice(adminQueries.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /await requireAdmin\(\)/, `${name} must verify moderator authorization first`);
  }
});

test("Admin layout redirects unauthenticated users to auth and 403s non-moderators", () => {
  assert.match(adminLayout, /redirect\("\/auth\?returnTo=%2Fadmin"\)/);
  assert.match(adminLayout, /PlatformModeratorRequiredError/);
  assert.match(adminLayout, /requirePlatformModerator\(\)/);
  assert.match(adminLayout, /Akses ditolak/);
});

test("Admin Users is read-only with no email or credential exposure", () => {
  assert.match(adminUsers, /Read-only/);
  // The actual SELECT must only name id, created_at, platform_role (strip comments).
  const code = adminQueries.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
  assert.match(code, /select\("id, created_at, platform_role"\)/);
  assert.doesNotMatch(code, /email/);
  assert.doesNotMatch(code, /password|token|secret|service_role|api_key/i);
});

test("Admin reads come from canonical Supabase tables, not cache or search index", () => {
  for (const table of ["users", "producers", "producer_memberships", "places", "experiences", "visit_intents", "live_sessions", "live_reports", "live_eligibility", "live_audit"]) {
    assert.match(adminQueries, new RegExp(`from\\("${table}"\\)`));
  }
  // No cache/search-index data source in the executable code (comments excluded).
  const canonicalCode = adminQueries.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(canonicalCode, /cache|search_index|searchIndex/i);
});

test("Admin pages surface failures instead of fabricating data", () => {
  for (const file of [adminOverview, adminLive]) {
    assert.match(file, /AdminErrorState/);
    assert.match(file, /tidak dapat dimuat/);
  }
});

test("No infrastructure credentials or mutation scope entered the Admin MVP", () => {
  // Authority Master §3: infra secrets never reach Admin surfaces.
  assert.doesNotMatch(adminQueries, /CLOUDFLARE|VERCEL_TOKEN|SUPABASE_SERVICE|SERVICE_ROLE|SIGNING_KEY/i);
  // MVP Admin Center is read-only: no insert/update/delete calls in the query layer.
  assert.doesNotMatch(adminQueries, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
});
