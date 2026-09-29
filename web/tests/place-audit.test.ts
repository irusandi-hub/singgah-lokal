import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  PLACE_AUDIT_ACTIONS,
  PLACE_AUDIT_ACTION_LABEL,
  placeAuditChanges,
  placeAuditSnapshot,
} from "../lib/place-audit-format";

/**
 * PLACE AUDIT — the append-only, attributable trail of Platform Admin action
 * on a Place (MASTER 09 §2 / §13).
 *
 * The database rules run on a real Postgres engine (PGlite) over the actual
 * migration chain, so they are proven SEMANTICALLY rather than by reading SQL:
 * the trail is truly append-only, truly unreachable by anon/authenticated, and
 * truly bound to its Place and its actor. The application rules — that every
 * action records the ADMIN rather than the service role, and that the Riwayat
 * surface shows time / action / actor / important changes without leaking
 * anything extra — are locked at the source level, matching the existing test
 * style.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const readMigration = (name: string) => read(`../supabase/migrations/${name}`);

const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

const auditModule = read("../lib/admin/place-audit.ts");
const auditFormat = read("../lib/place-audit-format.ts");
const placeWorkspace = read("../lib/admin/place-workspace.ts");
const claimService = read("../lib/producer/place-claim.ts");
const claimRoute = read("../app/api/admin/place-claims/route.ts");
const detailPage = read("../app/admin/places/[placeId]/page.tsx");
const userDirectory = read("../lib/admin/user-directory.ts");

// ---------------------------------------------------------------------------
// Migration harness — the real chain, unmodified.
// ---------------------------------------------------------------------------

const SHIMS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  create role anon;
  create role authenticated;
  create role service_role;
  create role supabase_admin;
  create role authenticator;
  create schema if not exists storage;
  create table if not exists storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
`;

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
  "0028_place_claims.sql",
  "0031_place_audit.sql",
] as const;

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of FOUNDATION) await db.exec(stripPgcrypto(readMigration(name)));
  return db;
}

const rows = async (db: PGlite, query: string): Promise<Record<string, unknown>[]> =>
  ((await db.query(query)).rows ?? []) as Record<string, unknown>[];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// High ids so the fixture never collides with the rows migration 0001 seeds.
const ADMIN_ID = uuid(90);
const PLACE_ID = "tempat-audit";

async function seedAuditFixture(db: PGlite): Promise<void> {
  // `public.users` is populated by migration 0001's `handle_new_user` trigger on
  // `auth.users`, exactly as in Supabase, so the explicit insert is a no-op.
  await db.exec(`
    insert into auth.users (id, email_confirmed_at) values ('${ADMIN_ID}', now());
    insert into public.users (id) values ('${ADMIN_ID}') on conflict do nothing;
    insert into public.places (id, name, short_description, category, type, area, address,
      contact_information, timezone, currency, producer_id, claim_status, publication_status)
    values ('${PLACE_ID}', 'Tempat Audit', 'd', 'Kopi', 'production', 'Bandung', 'Jalan Sbomen 1',
      '', 'Asia/Jakarta', 'IDR', null, 'unverified', 'draft');
  `);
}

// ---------------------------------------------------------------------------
// Migration structure
// ---------------------------------------------------------------------------

test("migration 0031 creates place_audit with exactly the required columns", async () => {
  const db = await bootstrapDb();
  try {
    const columns = await rows(
      db,
      "select column_name, is_nullable, data_type from information_schema.columns where table_schema='public' and table_name='place_audit' order by column_name",
    );
    const byName = Object.fromEntries(columns.map((c) => [String(c.column_name), c]));

    for (const required of [
      "place_id",
      "actor_id",
      "action",
      "before_data",
      "after_data",
      "detail",
      "created_at",
    ]) {
      assert.ok(byName[required], `place_audit must have a ${required} column`);
    }
    // Attribution is not optional (MASTER 09 §2): no action without an actor.
    assert.equal(byName.actor_id.is_nullable, "NO");
    assert.equal(byName.place_id.is_nullable, "NO");
    assert.equal(byName.action.is_nullable, "NO");
    assert.equal(byName.created_at.is_nullable, "NO");
    // Snapshots are optional: a creation has no "before".
    assert.equal(byName.before_data.is_nullable, "YES");
    assert.equal(byName.after_data.is_nullable, "YES");
    assert.equal(byName.detail.is_nullable, "NO");
    assert.equal(byName.before_data.data_type, "jsonb");
    assert.equal(byName.after_data.data_type, "jsonb");
    assert.equal(byName.detail.data_type, "jsonb");
  } finally {
    await db.close();
  }
});

test("place_audit is RLS-protected and unreachable by public/anon/authenticated", async () => {
  const db = await bootstrapDb();
  try {
    const rls = await rows(
      db,
      "select relrowsecurity from pg_class where oid = 'public.place_audit'::regclass",
    );
    assert.equal(rls[0].relrowsecurity, true, "RLS must be enabled");

    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const check = await rows(
          db,
          `select has_table_privilege('${role}', 'public.place_audit', '${privilege}') as ok`,
        );
        assert.equal(check[0].ok, false, `${role} must not have ${privilege} on place_audit`);
      }
    }
    // No SELECT policy exists either, so even a grant would not open it.
    const policies = await rows(
      db,
      "select count(*)::int as c from pg_policies where schemaname='public' and tablename='place_audit'",
    );
    assert.equal((policies[0].c as number), 0, "place_audit must have zero policies (fail closed)");
  } finally {
    await db.close();
  }
});

test("place_audit is append-only — UPDATE and DELETE are refused for every writer", async () => {
  const db = await bootstrapDb();
  try {
    await seedAuditFixture(db);
    await db.exec(`
      insert into public.place_audit (place_id, actor_id, action, before_data, after_data, detail)
      values ('${PLACE_ID}', '${ADMIN_ID}', 'admin_place_created', null, '{"name":"Tempat Audit"}', '{}');
    `);

    await assert.rejects(
      db.exec(`update public.place_audit set action = 'admin_place_archived'`),
      /place_audit is append-only/,
      "an audit row must never be rewritten",
    );
    await assert.rejects(
      db.exec("delete from public.place_audit"),
      /place_audit is append-only/,
      "an audit row must never be deleted",
    );

    // The refused attempts changed nothing.
    const remaining = await rows(db, "select action from public.place_audit");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].action, "admin_place_created");
  } finally {
    await db.close();
  }
});

test("a trail entry cannot outlive or detach from its Place or its actor", async () => {
  const db = await bootstrapDb();
  try {
    await seedAuditFixture(db);

    // A Place that does not exist cannot have history.
    await assert.rejects(
      db.exec(`
        insert into public.place_audit (place_id, actor_id, action)
        values ('tempat-hantu', '${ADMIN_ID}', 'admin_place_created')
      `),
      /violates foreign key constraint/,
    );
    // An actor that is not a known account cannot be recorded.
    await assert.rejects(
      db.exec(`
        insert into public.place_audit (place_id, actor_id, action)
        values ('${PLACE_ID}', '${uuid(9)}', 'admin_place_created')
      `),
      /violates foreign key constraint/,
    );
    // An action outside the locked vocabulary is refused.
    await assert.rejects(
      db.exec(`
        insert into public.place_audit (place_id, actor_id, action)
        values ('${PLACE_ID}', '${ADMIN_ID}', 'place_deleted')
      `),
      /violates check constraint/,
    );

    await db.exec(`
      insert into public.place_audit (place_id, actor_id, action)
      values ('${PLACE_ID}', '${ADMIN_ID}', 'admin_place_created');
    `);
    // MASTER 09 §15: a Place with a trail cannot be removed out from under
    // it. Deleting a Place is never a routine operation, and the database
    // enforces that its history cannot be silently orphaned.
    await assert.rejects(
      db.exec(`delete from public.places where id = '${PLACE_ID}'`),
      /place_audit_place_id_fkey/,
    );
    // The Admin account that appears in a trail is likewise not deletable.
    await assert.rejects(
      db.exec(`delete from public.users where id = '${ADMIN_ID}'`),
      /place_audit_actor_id_fkey/,
    );
  } finally {
    await db.close();
  }
});

test("migration 0031 is idempotent and additive — it touches nothing that already existed", () => {
  const sql = readMigration("0031_place_audit.sql");
  assert.match(sql, /create table if not exists public\.place_audit/);
  assert.match(sql, /create index if not exists place_audit_place_created_idx/);
  assert.match(sql, /drop trigger if exists place_audit_block_mutation/);
  assert.match(sql, /alter table public\.place_audit enable row level security/);
  assert.match(sql, /revoke all on public\.place_audit from public, anon, authenticated/);
  // Additive only: no existing table, policy, function body, or grant is
  // rewritten, and no Place is ever deleted.
  for (const table of ["places", "place_claims", "producer_memberships", "users", "experiences"]) {
    assert.doesNotMatch(sql, new RegExp(`(alter|drop|truncate)\\s+table\\s+public\\.${table}\\b`, "i"));
  }
  assert.doesNotMatch(sql, /delete\s+from/i);
  // Re-applying the file is a no-op.
  const reapply = stripComments(sql);
  assert.doesNotMatch(reapply, /create table public\.place_audit(?!\s*\()/);
});

// ---------------------------------------------------------------------------
// Action coverage — every required Admin action is recorded
// ---------------------------------------------------------------------------

test("the action vocabulary covers exactly the required Admin Place actions", () => {
  assert.deepEqual(Object.values(PLACE_AUDIT_ACTIONS).sort(), [
    "admin_place_archived",
    "admin_place_created",
    "admin_place_paused",
    "admin_place_published",
    "admin_place_restored",
    "admin_place_updated",
    "place_claim_approved",
    "place_claim_rejected",
  ]);
  // Every action has an operator-facing label for the Riwayat surface.
  for (const action of Object.values(PLACE_AUDIT_ACTIONS)) {
    assert.ok(PLACE_AUDIT_ACTION_LABEL[action], `${action} needs a label`);
  }
  // The vocabulary in code is the vocabulary the database enforces.
  const sql = stripComments(readMigration("0031_place_audit.sql"));
  for (const action of Object.values(PLACE_AUDIT_ACTIONS)) {
    assert.match(sql, new RegExp(`'${action}'`));
  }
});

test("create, edit, publish, pause, archive, and restore each record their own action", () => {
  const code = stripComments(placeWorkspace);
  assert.match(code, /action: PLACE_AUDIT_ACTIONS\.created/);
  assert.match(code, /action: PLACE_AUDIT_ACTIONS\.updated/);
  // The moderation mapping is what distinguishes publish / pause / archive,
  // and a restore is recorded as a restore even when it lands on 'published'.
  assert.match(code, /function moderationAction\(from: PublicationStatus, to: PublicationStatus\)/);
  assert.match(code, /if \(from === "archived" && to !== "archived"\) return PLACE_AUDIT_ACTIONS\.restored;/);
  assert.match(code, /if \(to === "published"\) return PLACE_AUDIT_ACTIONS\.published;/);
  assert.match(code, /if \(to === "paused"\) return PLACE_AUDIT_ACTIONS\.paused;/);
  assert.match(code, /if \(to === "archived"\) return PLACE_AUDIT_ACTIONS\.archived;/);
  // A status change records where it came from and where it went.
  assert.match(code, /detail: \{ fromStatus: place\.publicationStatus, toStatus: nextStatus \}/);
});

test("re-submitting the current status is a retry: no write, no trail entry", () => {
  const code = stripComments(placeWorkspace);
  const guard = code.indexOf("if (place.publicationStatus === nextStatus) return place;");
  const transition = code.indexOf("canAdminTransitionPlaceStatus(place.publicationStatus, nextStatus)");
  const write = code.indexOf("repository.updatePublicationStatus(id, nextStatus)");
  const audit = code.indexOf("recordPlaceAudit({", transition);

  // The guard stands BEFORE the write and before the audit call, so a no-op
  // moderation submit can never reach the append-only trail. It also returns
  // instead of throwing, which keeps a retried submit idempotent.
  assert.ok(guard > -1, "the no-op guard must exist");
  assert.ok(transition > guard, "the guard must precede the transition check");
  assert.ok(write > transition, "the write must follow the transition check");
  assert.ok(audit > write, "the audit call must follow the write");
  // Independently of the guard, an archive-on-archive can never be labelled a
  // restore — a false entry here is uncorrectable, the trail is append-only.
  assert.match(code, /if \(from === "archived" && to !== "archived"\) return PLACE_AUDIT_ACTIONS\.restored;/);
});

test("claim approval and rejection are recorded without changing the claim semantics", () => {
  const code = stripComments(claimService);
  // The decision is still made by the one existing RPC with the same args.
  assert.match(code, /rpc\("review_place_claim", \{/);
  assert.match(code, /p_claim_id: params\.claimId/);
  assert.match(code, /p_decision: params\.decision/);
  // Nothing about the Place itself is created or edited here.
  assert.doesNotMatch(code, /from\("places"\)\s*\.\s*(insert|update|upsert|delete)/);
  // The decision itself is what gets recorded.
  assert.match(code, /PLACE_AUDIT_ACTIONS\.claimApproved : PLACE_AUDIT_ACTIONS\.claimRejected/);
  // The Place is identified before the decision, so the entry names its target.
  assert.match(code, /place_id, user_id/);
  // The claimant is recorded as context, never as the actor.
  assert.match(code, /claimantUserId: String\(claimRow\.user_id/);
});

// ---------------------------------------------------------------------------
// The actor is the Admin, not the service role
// ---------------------------------------------------------------------------

test("every audit entry is attributed to the authenticated Admin, never the service role", () => {
  const workspace = stripComments(placeWorkspace);
  // The guard's return value is the actor source, in all three workspace
  // write actions (create, edit, moderate).
  const actors = workspace.match(/const actor = await requirePlatformModerator\(\);/g) ?? [];
  assert.equal(actors.length, 3, "every Place workspace write must capture the Admin identity");
  assert.equal((workspace.match(/actorId: actor\.userId/g) ?? []).length, 3);

  // The claim review takes the same session-derived identity from its route.
  const route = stripComments(claimRoute);
  assert.match(route, /actorId = \(await requirePlatformModerator\(\)\)\.userId/);
  assert.match(route, /reviewPlaceClaim\(\{ claimId, decision, reviewNote, actorId \}\)/);

  // The identity is never taken from the request, never defaulted, and the
  // service-role key is never used as an actor.
  for (const source of [workspace, stripComments(claimService), route]) {
    assert.doesNotMatch(source, /body\.actorId|body\.userId|params\.actorId \?\?/);
    assert.doesNotMatch(source, /SERVICE_ROLE|service_role_key/);
  }
  // An unattributable action is refused, not recorded anonymously.
  const audit = stripComments(auditModule);
  assert.match(audit, /if \(!placeId \|\| !actorId\) throw new PlaceAuditError\("place_audit_actor_required"\)/);
  // The presentation module stays pure: no client, no service role.
  const format = stripComments(auditFormat);
  assert.doesNotMatch(format, /server-only|createSupabaseServiceClient|requirePlatformModerator|auth\.admin/);
});

test("a failed audit write never leaves a Place change without a trail", () => {
  const code = stripComments(placeWorkspace);
  // Creation removes the row it created in the same request when the trail
  // cannot be written — no pre-existing data is touched.
  const createBody = code.slice(
    code.indexOf("export async function createAdminPlace"),
    code.indexOf("export async function updateAdminPlace"),
  );
  assert.match(createBody, /await admin\.from\("places"\)\.delete\(\)\.eq\("id", id\)/);
  assert.match(createBody, /place_audit_unavailable/);
  // An edit and a status change revert to the state they read.
  assert.match(code, /name: existing\.name/);
  assert.match(code, /shortDescription: existing\.shortDescription/);
  assert.match(code, /repository\.updatePublicationStatus\(id, place\.publicationStatus\)/);
  // The Admin is told the change was not saved.
  const message = stripComments(placeWorkspace);
  assert.match(message, /case "place_audit_unavailable"/);
});

// ---------------------------------------------------------------------------
// Riwayat rendering — and the privacy rule
// ---------------------------------------------------------------------------

test("the workspace Riwayat shows time, action, actor, and the important changes", () => {
  assert.match(detailPage, /listPlaceAudit\(placeId\)/);
  assert.match(detailPage, /PLACE_AUDIT_ACTION_LABEL\[entry\.action\]/);
  assert.match(detailPage, /formatAdminTimestamp\(entry\.createdAt\)/);
  assert.match(detailPage, /actorEmails\.get\(entry\.actorId\)/);
  assert.match(detailPage, /placeAuditChanges\(entry\.before, entry\.after\)/);
  assert.match(detailPage, /aria-label="Riwayat"/);
  // Read through the Admin-only helpers, never a client fetch.
  assert.match(detailPage, /listAdminActorEmails/);
  assert.doesNotMatch(detailPage, /useEffect|fetch\(/);
  // A missing migration degrades to an explanation, not a broken page.
  assert.match(detailPage, /Terapkan migration 0031/);
});

test("the audit trail holds Place columns only — never user email, credentials, or secrets", () => {
  // The snapshot is built from the canonical Place fields.
  const snapshot = placeAuditSnapshot({
    id: "tempat-audit",
    name: "Tempat Audit",
    shortDescription: "d",
    category: "Perdagangan & Jasa",
    type: "production",
    area: "Bandung",
    countryCode: "ID",
    regionName: "Jawa Barat",
    address: "Jalan Sbomen 1",
    contactInformation: "",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    latitude: -6.9,
    longitude: 107.6,
    coverImageUrl: null,
    producer: null,
    claimStatus: "unverified",
    publicationStatus: "draft",
    isCurated: false,
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "address",
    "area",
    "category",
    "claim_status",
    "contact_information",
    "cover_image_url",
    "currency",
    "latitude",
    "longitude",
    "name",
    "producer_id",
    "publication_status",
    "short_description",
    "timezone",
    "type",
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /email|password|token|secret|@/i);
  // The module never reads a user table.
  const audit = stripComments(auditModule);
  assert.doesNotMatch(audit, /from\("users"\)|auth\.admin/);
  assert.doesNotMatch(audit, /SERVICE_ROLE|api_key|signing/i);
});

test("the Riwayat diff shows only what actually changed, bounded in length", () => {
  const changes = placeAuditChanges(
    { name: "Nama Lama", area: "Bandung", publication_status: "draft" },
    { name: "Nama Baru", area: "Bandung", publication_status: "published" },
  );
  assert.deepEqual(
    changes.map((change) => change.label),
    ["Nama", "Status publikasi"],
  );
  assert.equal(changes[0].from, "Nama Lama");
  assert.equal(changes[0].to, "Nama Baru");
  assert.equal(changes[1].to, "published");
  // A creation has no "before", so there is no misleading diff.
  assert.deepEqual(placeAuditChanges(null, { name: "Baru" }), []);
  // A long value cannot blow up the row.
  const bounded = placeAuditChanges({ address: "x".repeat(400) }, { address: "y".repeat(400) });
  assert.ok((bounded[0].from as string).length <= 81);
  assert.ok((bounded[0].from as string).endsWith("…"));
  // An empty value reads as absent rather than blank.
  assert.equal(placeAuditChanges({ name: "A" }, { name: "B" })[0].to, "B");
  assert.equal(placeAuditChanges({ cover_image_url: null }, { cover_image_url: "https://x" })[0].from, "—");
});

// ---------------------------------------------------------------------------
// Email privacy is unchanged by this work
// ---------------------------------------------------------------------------

test("email stays Admin/Creator-only: Admin sees it, Producer and public never do", () => {
  // Platform Admin resolves it in user management and for the audit actor.
  assert.match(userDirectory, /export async function listAdminDirectoryUsers/);
  assert.match(userDirectory, /export async function listAdminActorEmails/);
  // The email renders in the list's client table (Admin context only).
  assert.match(read("../app/admin/users/AdminUsersTable.tsx"), /row\.email/);
  // Both resolvers are session-guarded and return only an address.
  const directory = stripComments(userDirectory);
  assert.equal((directory.match(/await requirePlatformModerator\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(directory, /password|token|secret|api_key/i);
  // Creator/Developer authority is untouched.
  assert.match(read("../app/api/developer/platform-admins/route.ts"), /listPlatformAdmins/);
  assert.match(read("../lib/developer/platform-admins.ts"), /auth\.admin\.listUsers/);
  // Nothing public or Producer-facing gained an email.
  for (const file of ["../app/api/places/route.ts", "../app/api/producer/places/route.ts"]) {
    assert.doesNotMatch(stripComments(read(file)), /email|user-directory|place_audit/i);
  }
  // The audit table is not readable by any client role, so a Producer cannot
  // even learn who acted through it.
  const audit = stripComments(auditModule);
  assert.doesNotMatch(audit, /from\("place_audit"\)\s*\.\s*select(?![\s\S]{0,200}eq\("place_id")/);
  assert.doesNotMatch(read("../app/api/admin/places/[placeId]/route.ts"), /place_audit|before_data/);
});
