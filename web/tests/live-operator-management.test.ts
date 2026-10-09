import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * ACCOUNT CENTER — delegated Live Operator management.
 *
 * Locked rules (correction, 2026-10-08):
 * - "Kelola Akses Live" lives INSIDE the Account Center's ONE "Akses" section
 *   and is rendered only for an owner/manager (Pengelola) account.
 * - The Place selector is fed by the SERVER's owner/manager memberships only:
 *   an owner/manager can never be offered a Place they do not manage.
 * - The account lookup is privacy-safe: authentication + owner/manager gate,
 *   EXACT username match through a SECURITY DEFINER RPC, one row, no email, no
 *   listing, no pattern search.
 * - Grant/revoke only ever go through the audited RPCs, and the routes
 *   re-check the owner/manager membership for the EXACT Place.
 * - Operator Live and Pengelola are SEPARATE authorities: neither produces the
 *   other, and a delegated operator may operate Live for the assigned Place
 *   while being unable to edit any Producer resource.
 */

function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const accountPage = read("app/account/page.tsx");
const manager = read("components/account/account-live-operator-manager.tsx");
const accessClient = read("components/account/account-access-client.tsx");
const lookupRoute = read("app/api/account/lookup/route.ts");
const operatorsRoute = read("app/api/account/live-operators/route.ts");
const liveAccessRoute = read("app/api/account/live-access/route.ts");
const startRoute = read("app/api/live/start/route.ts");
const endRoute = read("app/api/live/end/route.ts");
const producerSessions = read("app/api/producer/live/sessions/route.ts");
const publishUrlRoute = read("app/api/producer/live/sessions/[sessionId]/publish-url/route.ts");
const liveConsole = read("app/producer/live/LiveConsole.tsx");
const livePage = read("app/producer/live/page.tsx");
const producerWorkspace = stripComments(read("app/producer/places/ProducerPlaceWorkspace.tsx"));
const migration = read("supabase/migrations/0047_account_center_live_operator.sql");

// ---------------------------------------------------------------------------
// 1. Producer → Account Center navigation
// ---------------------------------------------------------------------------

test("the Producer dashboard links to the Account & Access Center and keeps the way home", () => {
  assert.match(producerWorkspace, /href="\/account"/, "the compact link points at /account");
  assert.match(producerWorkspace, /← Akun & Akses/, "the compact link is labelled as such");
  assert.match(producerWorkspace, /Kembali ke Beranda/, "the way back to the public home stays");
  assert.match(producerWorkspace, /href="\//, "the home link is unchanged");
  assert.equal(
    producerWorkspace.includes('href="/producer"'),
    false,
    "the area root still never links to itself",
  );
});

// ---------------------------------------------------------------------------
// 2. "Kelola Akses Live" placement + visibility
// ---------------------------------------------------------------------------

test("Kelola Akses Live sits inside the ONE Akses section and only for Pengelola", () => {
  assert.equal(
    (accountPage.match(/<Section title="Akses">/g) ?? []).length,
    1,
    "exactly one Akses section",
  );
  const aksesIdx = accountPage.indexOf('<Section title="Akses">');
  const managerIdx = accountPage.indexOf("<AccountLiveOperatorManager");
  assert.ok(aksesIdx >= 0 && managerIdx > aksesIdx, "the manager lives inside Akses");

  // Visible ONLY to an owner/manager: it is rendered on the same predicate that
  // produces the Pengelola card, and is absent for an operator-only account.
  assert.match(
    accountPage,
    /\{hasProducerAccess \? \(\s*<AccountLiveOperatorManager places=\{authority\.memberships\} \/>/,
    "the manager is gated on Pengelola authority and fed the owner/manager Places",
  );
  assert.match(accountPage, /<AccountAccessClient memberships=\{authority\.memberships\} \/>/);
  assert.match(manager, /places: AccountPlaceMembership\[\]/);
  assert.match(manager, /places\.length === 0/);
});

test("the manager never invents a Place: it only offers the memberships it was given", () => {
  // The Place selector is built from the prop, never from a fetch.
  assert.match(manager, /places\.map\(/);
  assert.match(manager, /place\.placeName/);
  // It cannot "list users": the only account source is the exact lookup.
  assert.doesNotMatch(manager, /listUsers|admin\.listUsers|from\("users"\)/);
  assert.match(manager, /\/api\/account\/lookup\?username=/);
  assert.match(manager, /\/api\/account\/live-operators\?placeId=/);
});

test("the manager shows the assigned Place and the assignment status", () => {
  assert.match(manager, /Operator aktif/);
  assert.match(manager, /Aktif/);
  assert.match(manager, /Dicabut/);
  assert.match(manager, /formatWhen\(row\.grantedAt\)/);
  assert.match(manager, /formatWhen\(row\.revokedAt\)/);
  // Grant + revoke are both reachable.
  assert.match(manager, /method: "POST"/);
  assert.match(manager, /method: "DELETE"/);
});

// ---------------------------------------------------------------------------
// 3. Privacy-safe account lookup
// ---------------------------------------------------------------------------

test("the account lookup is authentication + owner/manager gated", () => {
  assert.match(lookupRoute, /authentication_required/);
  assert.match(lookupRoute, /producer_authorization_required/);
  assert.match(lookupRoute, /in\("role", \["owner", "manager"\]\)/);
  assert.match(lookupRoute, /resolve_account_by_username/);
});

test("the account lookup exposes no directory and no email", () => {
  const code = stripComments(lookupRoute);
  assert.doesNotMatch(code, /\.from\("users"\)/, "no direct users table read");
  assert.doesNotMatch(code, /email/i, "no email lookup path");
  assert.doesNotMatch(code, /ilike|\.or\(|%/, "no pattern/partial search");
  assert.match(code, /account: null/, "an unmatched username returns no account");
  // Only the public label + id come back.
  assert.match(code, /userId: String\(row\.user_id\)/);
  assert.match(code, /username: row\.username \? String\(row\.username\) : null/);
});

test("the migration ships an exact-match, owner/manager-gated lookup RPC", () => {
  assert.match(migration, /create or replace function public\.resolve_account_by_username/);
  assert.match(migration, /raise exception 'account_lookup_not_allowed'/);
  assert.match(migration, /u\.username = p_username/, "EXACT match only");
  assert.match(migration, /limit 1/);
  assert.match(migration, /grant execute on function public\.resolve_account_by_username\(text\) to authenticated/);
});

// ---------------------------------------------------------------------------
// 4. Grant / revoke authorization on the exact Place
// ---------------------------------------------------------------------------

test("grant and revoke are owner/manager-only for the EXACT Place", () => {
  const post = operatorsRoute.slice(operatorsRoute.indexOf("export async function POST"));
  const del = operatorsRoute.slice(operatorsRoute.indexOf("export async function DELETE"));
  for (const [name, handler] of [["POST", post], ["DELETE", del]] as const) {
    assert.match(handler, /in\("role", \["owner", "manager"\]\)/, `${name} requires owner/manager`);
    assert.match(handler, /\.eq\("place_id", placeId\)/, `${name} is scoped to the exact Place`);
    assert.match(handler, /producer_authorization_required/, `${name} fails closed`);
  }
  assert.match(post, /grant_live_operator_access/);
  assert.match(del, /revoke_live_operator_access/);
  // The client never supplies granted_by.
  assert.doesNotMatch(operatorsRoute, /p_producer_id|granted_by:/);
});

test("the operator list is authorized and labelled server-side, never by user id", () => {
  assert.match(operatorsRoute, /list_place_live_operators/);
  assert.match(migration, /create or replace function public\.list_place_live_operators/);
  assert.match(migration, /raise exception 'live_operator_list_not_allowed'/);
  assert.match(migration, /left join public\.users u on u\.id = lo\.user_id/);
  // A revoked assignment is still listed (as history), but the Account Center
  // access resolver counts only ACTIVE ones.
  assert.match(liveAccessRoute, /is\("revoked_at", null\)/);
});

// ---------------------------------------------------------------------------
// 5. Authority separation: Operator Live ≠ Pengelola
// ---------------------------------------------------------------------------

test("a membership never creates an operator assignment and vice versa", () => {
  // The ONLY write into live_operators in the migration is inside the audited
  // grant RPC (plus its conflict update) — no trigger, no policy, no view can
  // create one from producer_memberships.
  const inserts = migration.match(/insert into public\.live_operators/g) ?? [];
  assert.equal(inserts.length, 1, "exactly one write path into live_operators");
  const insertIdx = migration.indexOf("insert into public.live_operators");
  const grantFnIdx = migration.indexOf(
    "create or replace function public.grant_live_operator_access",
  );
  assert.ok(
    grantFnIdx >= 0 && insertIdx > grantFnIdx,
    "the only write lives inside the audited grant RPC",
  );
  assert.equal(
    migration.includes("create trigger"),
    false,
    "no trigger can create an operator assignment from a membership",
  );
  // The Account Center feeds memberships to Pengelola/manager only.
  assert.match(accountPage, /<AccountAccessClient memberships=\{authority\.memberships\} \/>/);
  assert.match(accountPage, /<AccountLiveAccessClient assignments=\{authority\.liveAssignments\} \/>/);
  assert.equal(
    accessClient.includes("live_operators"),
    false,
    "the Pengelola card never reads operator rows",
  );
});

test("a delegated operator may operate Live for the assigned Place only", () => {
  // Both Live entry points accept the two authorities, each established on its
  // own, and reject anyone else.
  for (const [name, route] of [["start", startRoute], ["end", endRoute]] as const) {
    assert.match(route, /canOperateLiveForPlace/, `${name} uses the operator-aware check`);
    assert.match(route, /producer_authorization_required/, `${name} fails closed`);
  }
  // Ending derives the Place from the SESSION, never from client input.
  assert.match(endRoute, /session\.place_id/);
  assert.doesNotMatch(endRoute, /body\.placeId/);
  // The console now talks to those authority-aware endpoints.
  assert.match(liveConsole, /"\/api\/live\/start"/);
  assert.match(liveConsole, /"\/api\/live\/end"/);
  assert.doesNotMatch(liveConsole, /"\/api\/producer\/live\/sessions"/);
  // ...and it can only offer Places the account may operate.
  assert.match(livePage, /from\("live_operators"\)/);
  assert.match(livePage, /is\("revoked_at", null\)/);
  assert.match(livePage, /\.eq\("user_id", userData\.user\.id\)/);
});

test("publishing re-issuance is authorized against the session's own Place", () => {
  assert.match(publishUrlRoute, /canOperateLiveForPlace/);
  assert.match(publishUrlRoute, /session\.place_id/);
  assert.match(publishUrlRoute, /authentication_required/);
  assert.match(publishUrlRoute, /producer_authorization_required/);
});

test("ending Producer Live is authorized against the session's own Place", () => {
  const deleteHandler = producerSessions.slice(
    producerSessions.indexOf("export async function DELETE"),
  );
  assert.match(deleteHandler, /canOperateLiveForPlace/);
  assert.match(deleteHandler, /select\("place_id"\)/);
  assert.doesNotMatch(deleteHandler, /body\.placeId/, "the client cannot name the Place to end");
  // The Producer-only START entry point is unchanged.
  assert.match(producerSessions, /requireProducerAccess\(request, placeId, \["owner", "manager"\]\)/);
});

// ---------------------------------------------------------------------------
// 6. A Live Operator cannot edit Producer resources
// ---------------------------------------------------------------------------

const PRODUCER_RESOURCE_ROUTES = [
  "app/api/producer/places/[placeId]/route.ts",
  "app/api/producer/places/[placeId]/experiences/route.ts",
  "app/api/producer/places/[placeId]/experiences/[experienceId]/route.ts",
  "app/api/producer/places/[placeId]/production-story/route.ts",
  "app/api/producer/places/[placeId]/production-story/[stageId]/route.ts",
  "app/api/producer/places/[placeId]/photos/route.ts",
  "app/api/producer/places/[placeId]/publication/route.ts",
  "app/api/producer/places/[placeId]/ai-media/route.ts",
  "app/api/producer/visit-intents/[id]/route.ts",
] as const;

test("every Producer resource route stays owner/manager only", () => {
  for (const route of PRODUCER_RESOURCE_ROUTES) {
    const source = read(route);
    assert.match(source, /requireProducerAccess/, `${route} must require Pengelola access`);
    assert.equal(
      source.includes("canOperateLiveForPlace"),
      false,
      `${route} must not accept operator authority`,
    );
    assert.equal(
      source.includes("live_operators"),
      false,
      `${route} must not consult operator assignments`,
    );
  }
});

test("the operator's delegated reads are read-only and published/scoped", () => {
  // The migration grants the operator exactly three extra SELECTs — the Place
  // they operate, its PUBLISHED stages, and its live sessions — and additions
  // to live_operators reads for the Place's owner/manager. No INSERT/UPDATE/
  // DELETE policy for operators exists anywhere.
  const addedPolicies = migration.match(/create policy [a-z_]*_live_operator_read/g) ?? [];
  assert.deepEqual(
    addedPolicies.sort(),
    [
      "create policy live_sessions_live_operator_read",
      "create policy places_live_operator_read",
      "create policy production_stages_live_operator_read",
    ],
    "only scoped, read-only operator policies are added",
  );
  const policyBlocks = migration.split("create policy ");
  for (const block of policyBlocks) {
    if (!block.includes("_live_operator_read")) continue;
    assert.equal(
      /for (insert|update|delete|all)/i.test(block.slice(0, 200)),
      false,
      "an operator policy must never grant a write",
    );
  }
  // The stage read is published-only, so an operator cannot read drafts.
  assert.match(migration, /status = 'published'\s*\n\s*and exists/);
  assert.match(migration, /alter table public\.live_operators enable row level security/);
});

test("the Live Operator is the operator of Live and nothing else", () => {
  // The endpoints the operator reaches are exactly Live operation endpoints.
  const operatorReachable = [startRoute, endRoute, publishUrlRoute].map((source) =>
    source.includes("canOperateLiveForPlace"),
  );
  assert.deepEqual(operatorReachable, [true, true, true]);
  for (const route of PRODUCER_RESOURCE_ROUTES) {
    assert.equal(read(route).includes("canOperateLiveForPlace"), false, route);
  }
});
