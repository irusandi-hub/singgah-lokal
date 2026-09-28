import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

const adminQueries = readFileSync(new URL("../lib/admin/queries.ts", import.meta.url), "utf8");
const adminDirectory = readFileSync(new URL("../lib/admin/user-directory.ts", import.meta.url), "utf8");
const adminPlaceWorkspace = readFileSync(new URL("../lib/admin/place-workspace.ts", import.meta.url), "utf8");
const adminPlacePublicationRoute = readFileSync(
  new URL("../app/api/admin/places/[placeId]/publication/route.ts", import.meta.url),
  "utf8",
);
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

function stripCode(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
}

test("Every admin page and the layout are server-rendered and dynamic", () => {
  for (const file of [adminLayout, adminOverview, adminUsers, adminLive, ...adminPages.slice(2).map(({ path }) => readFileSync(new URL(path, import.meta.url), "utf8"))]) {
    assert.match(file, /export const dynamic = "force-dynamic"/);
  }
});

test("Admin data layer re-verifies platform moderator authorization on every read", () => {
  // Every exported read goes through requirePlatformModerator — fail closed.
  const exportsNeedingAuth = [
    "getAdminOverview",
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

test("Admin Users shows the account email as Admin-only private data", () => {
  // Email IS visible to Platform Admin, in the one context that needs it:
  // user management. It is read from Supabase Auth (public.users stores
  // none) behind a fresh server-side moderator check, and the Admin page
  // states that it is not visible to Producer, other users, or the public.
  assert.match(adminUsers, /listAdminDirectoryUsers/);
  assert.match(adminUsers, /row\.email/);
  assert.match(adminUsers, /tidak pernah tampil untuk Producer, user lain, atau publik/);
  assert.match(stripCode(adminDirectory), /await requirePlatformModerator\(\)/);
  assert.match(stripCode(adminDirectory), /auth\.admin\.listUsers/);
  // No credential or secret is ever selected or returned alongside it.
  assert.doesNotMatch(stripCode(adminDirectory), /password|token|secret|api_key/i);
});

test("Admin reads come from canonical Supabase tables, not cache or search index", () => {
  for (const table of ["users", "producers", "producer_memberships", "places", "experiences", "visit_intents", "live_sessions", "live_reports", "live_eligibility", "live_audit"]) {
    // `users` is read by the Admin user directory; every other table by the
    // canonical admin query layer.
    const source = table === "users" ? adminDirectory : adminQueries;
    assert.match(source, new RegExp(`from\\("${table}"\\)`));
  }
  // No cache/search-index data source in the executable code (comments excluded).
  const canonicalCode = stripCode(adminQueries);
  assert.doesNotMatch(canonicalCode, /cache|search_index|searchIndex/i);
});

test("Admin pages surface failures instead of fabricating data", () => {
  for (const file of [adminOverview, adminLive]) {
    assert.match(file, /AdminErrorState/);
    assert.match(file, /tidak dapat dimuat/);
  }
});

test("No infrastructure credentials reached the Admin data layer, and the Place workspace never hard-deletes", () => {
  // Authority Master §3: infra secrets never reach Admin surfaces.
  for (const source of [adminQueries, adminDirectory, adminPlaceWorkspace]) {
    assert.doesNotMatch(source, /CLOUDFLARE|VERCEL_TOKEN|SUPABASE_SERVICE|SERVICE_ROLE|SIGNING_KEY/i);
  }
  // The read layer stays read-only: no insert/update/delete/rpc calls.
  assert.doesNotMatch(adminQueries, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  // A Place may have Experience, Visit Intent, claim, membership, Live, and
  // history, so hard-delete is never an admin operation — only archive. The
  // one delete in the Place workspace is the create rollback that fires when
  // an audit entry for a just-created Place cannot be written; it is scoped to
  // the id that request created and runs before the Place is ever returned.
  assert.doesNotMatch(adminPlaceWorkspace, /removeAdminPlace|hardDelete/);
  assert.doesNotMatch(adminPlacePublicationRoute, /DELETE/);
  assert.match(
    adminPlaceWorkspace,
    /catch \(error\) \{\s*await admin\.from\("places"\)\.delete\(\)\.eq\("id", id\);/,
  );
});
