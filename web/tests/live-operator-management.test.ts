import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

// The two REAL modules behind the console contract: the component whose step-1
// gate this change fixes, and the repository whose stage reads feed it. Both are
// imported directly, so the behavioral checks below run against the same code
// the page runs (no copy of the rule exists in this test).
import { resolveEffectiveStageId } from "../app/producer/live/LiveConsole";
import { SupabaseProductionStoryRepository } from "../lib/production-story-repository";

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
 *
 * CONSOLE GATE (bug fix, this change): step 1 of the Live console gated its
 * "Lanjut ke pemeriksaan kamera" button on the RAW override state `stageId`,
 * which is deliberately "" until the Producer picks an option. An eligible
 * published stage that the select itself displays could therefore not proceed,
 * and a Place with exactly ONE published stage locked the console permanently
 * (there was no other option to pick). The gate is now the EFFECTIVE stage
 * selection — the same value the select renders and the start request sends.
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
const authorityMigration = read("supabase/migrations/0049_live_operator_authority.sql");
const moderationMigration = read("supabase/migrations/0056_live_moderation_audit_trail.sql");

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
  // It cannot "list users" and it cannot address an account directly.
  assert.doesNotMatch(manager, /listUsers|admin\.listUsers|from\("users"\)/);
  assert.match(manager, /\/api\/account\/live-operators\?placeId=/);
  // Tahap 3: the manager surface now drives the INVITATION lifecycle, so the
  // account is reached by registered email through the (non-enumerating) invite
  // endpoint instead of a client-side username lookup. The 0047 lookup/grant
  // APIs are untouched server-side — this test locks the UI contract only.
  assert.match(manager, /\/api\/account\/live-operators\/invitations/);
  assert.doesNotMatch(manager, /\/api\/account\/lookup/);
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
  // own, and reject anyone else. Start goes through the ONE shared start gate
  // (A-07) — which is the operator-aware check, used by both start endpoints —
  // and end calls the predicate directly, against the session's own Place.
  assert.match(startRoute, /requireLiveStartAuthority/, "start uses the operator-aware gate");
  assert.match(startRoute, /producer_authorization_required/, "start fails closed");
  assert.match(endRoute, /canOperateLiveForPlace/, "end uses the operator-aware check");
  assert.match(endRoute, /producer_authorization_required/, "end fails closed");
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
  // A-07: the START path of this same endpoint is no longer a Producer-only
  // rule of its own — it calls the shared gate, exactly like /api/live/start.
  const startHandler = producerSessions.slice(
    0,
    producerSessions.indexOf("export async function DELETE"),
  );
  assert.match(startHandler, /requireLiveStartAuthority\(request, placeId\)/);
  assert.doesNotMatch(startHandler, /requireProducerAccess\(request, placeId/);
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
    source.includes("canOperateLiveForPlace") || source.includes("requireLiveStartAuthority"),
  );
  assert.deepEqual(operatorReachable, [true, true, true]);
  for (const route of PRODUCER_RESOURCE_ROUTES) {
    assert.equal(read(route).includes("canOperateLiveForPlace"), false, route);
  }
});

// ---------------------------------------------------------------------------
// 7. Konsol Live — gerbang langkah 1 dan daftar Proses yang ditawarkan
// ---------------------------------------------------------------------------

test("the step-1 gate uses the EFFECTIVE stage selection, never the raw state", () => {
  const code = stripComments(liveConsole);
  assert.match(code, /disabled=\{!effectiveStageId\}/, "the button is gated on the effective selection");
  assert.equal(
    code.includes("disabled={!stageId}"),
    false,
    "the uninitialized override state must never be the gate",
  );
  // ONE derived value, computed off the real props by a pure function — no
  // second selection state and no setState-in-effect to keep it in sync.
  assert.match(code, /const effectiveStageId = resolveEffectiveStageId\(stages, stageId\);/);
  assert.equal(
    (code.match(/setStageId\(/g) ?? []).length,
    1,
    "only the select's onChange writes the override (single source of truth)",
  );
  assert.ok(
    code.indexOf("onChange={(event) => setStageId(event.target.value)}") > -1,
    "the override is written only by a real user choice",
  );
  // The displayed value, the gate, and the start request are the same value.
  assert.match(code, /value=\{effectiveStageId\}/);
  assert.match(code, /stageId: effectiveStageId/);
});

test("an available published stage opens the gate; an empty list keeps it closed", () => {
  // No eligible stage: no effective selection, so step 1 stays blocked.
  assert.equal(resolveEffectiveStageId([], ""), "");
  assert.equal(Boolean(resolveEffectiveStageId([], "")), false);
  // A selection that no longer belongs to the list (the Place changed under it)
  // can never open the gate either.
  assert.equal(resolveEffectiveStageId([], "stage-lama"), "");

  // EXACTLY the reported defect: a single eligible published stage is a valid
  // effective selection with ZERO user interaction — the select already shows
  // it, so the gate must be open.
  const single = [{ id: "stage-a" }];
  assert.equal(resolveEffectiveStageId(single, ""), "stage-a");
  assert.equal(Boolean(resolveEffectiveStageId(single, "")), true);

  // Several eligible stages: the Producer's own choice wins while it is still
  // eligible, otherwise the FIRST eligible stage (canonical order from props).
  const many = [{ id: "stage-a" }, { id: "stage-b" }];
  assert.equal(resolveEffectiveStageId(many, "stage-b"), "stage-b");
  assert.equal(resolveEffectiveStageId(many, "stage-a"), "stage-a");
  assert.equal(resolveEffectiveStageId(many, ""), "stage-a");
  // Switching Place keeps the rule: only the NEW Place's stages can be selected.
  assert.equal(resolveEffectiveStageId([{ id: "stage-lain" }], "stage-a"), "stage-lain");
});

test("only published stages are ever offered or accepted for Live", () => {
  const code = stripComments(liveConsole);
  // Server side: the console reads the assigned Place's stages PUBLISHED-ONLY,
  // and keeps the published filter as a second, explicit guard on the props.
  assert.match(livePage, /listForPlace\(membership\.place_id, true\)/);
  assert.match(livePage, /\.filter\(\(stage\) => stage\.status === "published"\)/);
  // Console side: the option list is the SELECTED Place's own stages, and no
  // unpublished status is ever named (there is no draft/paused/archived path).
  assert.match(code, /places\.find\(\(place\) => place\.id === placeId\)\?\.stages \?\? \[\]/);
  assert.doesNotMatch(code, /"draft"|"paused"|"archived"/);
  // Last authority layer stays in the database: the start RPC requires the
  // stage to belong to the SAME Place and to still be Published.
  assert.match(authorityMigration, /where id = p_stage_id and place_id = p_place_id/);
  assert.match(authorityMigration, /v_stage_status <> 'published'/);
  assert.match(authorityMigration, /raise exception 'live_stage_not_published'/);
});

test("the offered stages are always scoped to the selected Place", () => {
  const code = stripComments(liveConsole);
  // One Place → one stage read, keyed on that membership's own place_id.
  assert.match(livePage, /placeRepository\.getById\(membership\.place_id\)/);
  assert.match(livePage, /listForPlace\(membership\.place_id, true\)/);
  assert.match(code, /places\.find\(\(place\) => place\.id === placeId\)\?\.stages/);
  // The request carries the SAME Place and the SAME selected stage.
  assert.match(
    code,
    /body: JSON\.stringify\(\{ placeId, stageId: effectiveStageId, idempotencyKey \}\)/,
  );
});

/**
 * Minimal transport stub for the repository's REAL query chain. The logic under
 * test is the repository's own error handling, so only the PostgREST transport
 * is replaced: `listForPlace` still builds its real chain
 * (`from(...).select(...).eq(...).order(...).order(...)`) and still decides what
 * to do with the answer.
 */
function stageQueryStub(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "in"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (value: typeof result) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

test("a repository error is never silently turned into an empty stage list", async () => {
  // (1) The stage read fails: the console must see a FAILURE, not "Tidak ada
  //     Proses yang Tayang", because the two are not the same thing.
  const failingStages = {
    from: () => stageQueryStub({ data: null, error: new Error("permission denied") }),
  } as unknown as SupabaseClient;
  await assert.rejects(
    () => new SupabaseProductionStoryRepository(failingStages).listForPlace("rumah-teh-lokal", true),
    /permission denied/,
    "a failed stage read must throw",
  );

  // (2) A failure on the EXPERIENCE relation is not swallowed either: a
  //     partially mapped stage must never be served as if it were complete.
  const failingRelations = {
    from: (table: string) =>
      table === "production_stages"
        ? stageQueryStub({
            data: [
              {
                id: "stage-a",
                place_id: "rumah-teh-lokal",
                title: "Proses A",
                description: "x",
                sort_order: 0,
                status: "published",
              },
            ],
            error: null,
          })
        : stageQueryStub({ data: null, error: new Error("relation read denied") }),
  } as unknown as SupabaseClient;
  await assert.rejects(
    () =>
      new SupabaseProductionStoryRepository(failingRelations).listForPlace(
        "rumah-teh-lokal",
        true,
      ),
    /relation read denied/,
    "a related-table failure must throw as well",
  );

  // (3) The genuinely empty answer (no error, zero rows) stays an empty list —
  //     that is the ONE case the console may report as "no published stage".
  const empty = {
    from: () => stageQueryStub({ data: [], error: null }),
  } as unknown as SupabaseClient;
  assert.deepEqual(
    await new SupabaseProductionStoryRepository(empty).listForPlace("rumah-teh-lokal", true),
    [],
  );
});

test("the operator read policies of 0047 and 0056 agree: read-only, published-only, Place-scoped", () => {
  // 0047 declared the operator's stage read; 0056 re-created it (A-12) so the
  // policy expression no longer references public.live_operators — which is
  // what makes it work for a session WITHOUT a client privilege on that table —
  // while the GRANT OF ACCESS stays identical: published stages, assigned Place
  // only, SELECT only.
  assert.match(
    moderationMigration,
    /create or replace function public\.is_active_live_operator_for_place\(p_place_id text\)/,
  );
  assert.match(moderationMigration, /security definer set search_path = public/);
  assert.match(
    moderationMigration,
    /grant execute on function public\.is_active_live_operator_for_place\(text\) to anon, authenticated, service_role;/,
  );
  assert.match(
    moderationMigration,
    /create policy production_stages_live_operator_read\s+on public\.production_stages for select\s+using \(\s+status = 'published'\s+and public\.is_active_live_operator_for_place\(production_stages\.place_id\)/,
  );
  assert.match(
    moderationMigration,
    /create policy places_live_operator_read\s+on public\.places for select\s+using \(public\.is_active_live_operator_for_place\(places\.id\)\)/,
  );
  // Still no write policy for an operator, in either migration.
  for (const source of [migration, moderationMigration]) {
    for (const block of source.split("create policy ")) {
      if (!block.includes("_live_operator_read")) continue;
      assert.equal(
        /for (insert|update|delete|all)/i.test(block.slice(0, 200)),
        false,
        "an operator read policy must never grant a write",
      );
    }
  }
});
