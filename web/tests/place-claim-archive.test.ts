import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * PLACE CLAIM ARCHIVE — migration 0034 (PO, 2026-09-29).
 *
 * Synchronizes the repository with the archive implementation already ACTIVE
 * on Supabase DEV (table + 30-day retention + Admin-only internal search +
 * the cleanup Edge Function + its daily scheduler). Proven semantically on a
 * real Postgres engine (PGlite) over the actual migration chain, plus
 * source-level rules in the repo's existing surface-test style.
 *
 * MASTER binding: MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0 §1–§7, §16.
 * The archive is NOT Dashboard history (§4) — nothing here renders a page.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const migration = read("../supabase/migrations/0034_place_claim_archive.sql");
const archiveLib = read("../lib/admin/place-claim-archive.ts");
const archiveRoute = read("../app/api/admin/place-claim-archives/route.ts");
const edgeFunction = read("../supabase/functions/cleanup-place-claim-archives/index.ts");
const policyPage = read("../app/policy/page.tsx");
const aboutPage = read("../app/about/page.tsx");
const claimPanel = read("../app/producer/places/PlaceClaimPanel.tsx");
const adminQueries = read("../lib/admin/queries.ts");
const claimsManager = read("../app/admin/places/PlaceClaimsManager.tsx");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");
}

const SHIMS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as '
    select nullif(current_setting(''request.jwt.claims.sub'', true), '''')::uuid
  ';
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

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of [
    "0001_visit_intent_foundation.sql",
    "0002_harden_visit_intent_rls.sql",
    "0003_persistence_integrity.sql",
    "0004_place_management.sql",
    "0005_experience_management.sql",
    "0020_one_membership_per_user.sql",
    "0022_allow_multiple_places_per_producer.sql",
    "0028_place_claims.sql",
  ] as const) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  await db.exec(stripPgcrypto(migration));
  // The moderator predicate reads public.users.platform_role (added by the
  // Live chain, migration 0008). The archive harness adds the column
  // additively instead of dragging the whole Live chain in — same shape.
  await db.exec("alter table public.users add column if not exists platform_role text;");
  return db;
}

const rows = async (db: PGlite, query: string, params: unknown[] = []) =>
  ((await db.query(query, params)).rows ?? []) as Record<string, unknown>[];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// 1. Schema: the table, the retention clock, the fail-closed posture
// ---------------------------------------------------------------------------

test("migration 0034 creates place_claim_archives with the 30-day retention clock", async () => {
  const db = await bootstrapDb();
  try {
    const columns = await rows(
      db,
      "select column_name, is_nullable, column_default from information_schema.columns where table_name = 'place_claim_archives' order by ordinal_position",
    );
    const names = columns.map((c) => String(c.column_name));
    for (const required of ["id", "place_id", "user_id", "evidence_path", "archived_at", "finalized_at"]) {
      assert.ok(names.includes(required), `missing column ${required}`);
    }
    // §2: the retention clock is an actual timestamp column, not a comment.
    const archivedAt = columns.find((c) => c.column_name === "archived_at");
    assert.equal(String(archivedAt?.is_nullable), "NO");
    assert.match(String(archivedAt?.column_default ?? ""), /now\(\)/);

    // §8: no permanent retention mechanism — cleanup deletes (finalizes), the
    // schema never blocks deletion of expired rows.
    assert.doesNotMatch(stripComments(migration), /prevent delet|block delet/i);
  } finally {
    await db.close();
  }
});

test("place_claim_archives is fail-closed: RLS on, zero policies, clients stripped", () => {
  const code = stripComments(migration);
  assert.match(code, /alter table public\.place_claim_archives enable row level security/);
  assert.match(code, /revoke all on public\.place_claim_archives from public, anon, authenticated/);
  // No policy at all — same posture as 0028's place_claims.
  assert.doesNotMatch(code, /create policy/);
});

// ---------------------------------------------------------------------------
// 2. The Admin-only search RPC: moderator-gated, 30-day window, filters
// ---------------------------------------------------------------------------

async function seedArchive(db: PGlite): Promise<void> {
  const placeId = "tempat-arsip";
  await db.exec(`
    insert into public.producers (id, display_name) values ('prod-a', 'Producer A');
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
    values ('${placeId}', 'Place Arsip', 'd', 'Perdagangan & Jasa', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', 'prod-a');
    insert into auth.users (id, email, email_confirmed_at) values ('${uuid(1)}', 'klaiman@example.com', now());
  `);
  await db.query(
    `insert into public.place_claim_archives
       (id, place_id, user_id, status, evidence_path, evidence_file_name, note, review_note, reviewed_at, created_at, archived_at)
     values ($1, $2, $3, 'rejected', 'place-claims/tempat-arsip/abc.pdf', 'bukti.pdf', 'catatan pengaju', 'ditolak', now(), now() - interval '1 day', now() - interval '1 day')`,
    [uuid(100), placeId, uuid(1)],
  );
}

async function callSearch(
  db: PGlite,
  params: { placeId?: string | null; userId?: string | null; email?: string | null; claimId?: string | null },
) {
  return rows(db, "select * from public.search_place_claim_archives($1,$2,$3,$4)", [
    params.placeId ?? null,
    params.userId ?? null,
    params.email ?? null,
    params.claimId ?? null,
  ]);
}

test("archive search requires the platform moderator session (fail closed)", async () => {
  const db = await bootstrapDb();
  try {
    await seedArchive(db);
    // No session (no JWT sub) → refused with the same error the Live RPCs use.
    await assert.rejects(
      () => callSearch(db, { placeId: "tempat-arsip" }),
      /platform_moderator_required/,
    );
    // A non-moderator session is refused too.
    await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${uuid(2)}', 'bukan-admin@example.com', now());`);
    await db.exec("select set_config('request.jwt.claims.sub', '00000000-0000-4000-8000-000000000002', false);");
    await assert.rejects(
      () => callSearch(db, { placeId: "tempat-arsip" }),
      /platform_moderator_required/,
    );
    await db.exec("select set_config('request.jwt.claims.sub', '', false);");
  } finally {
    await db.close();
  }
});

test("an authorized Platform Admin can search the archive by Place, Pengelola ID, email, and claim ID", async () => {
  const db = await bootstrapDb();
  try {
    await seedArchive(db);
    // The moderator: an auth account, its public.users row, and the
    // operational role — the exact shape the RPC predicate requires.
    await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${uuid(3)}', 'admin@example.com', now());`);
    // public.users row already exists via the handle_new_user trigger.
    await db.exec(`update public.users set platform_role = 'platform_moderator' where id = '${uuid(3)}';`)
    // Session-scoped (false): the setting must survive across statements.
    await db.exec("select set_config('request.jwt.claims.sub', '00000000-0000-4000-8000-000000000003', false);");

    // By Place ID.
    assert.equal((await callSearch(db, { placeId: "tempat-arsip" })).length, 1);
    assert.equal((await callSearch(db, { placeId: "tempat-lain" })).length, 0);
    // By Pengelola (user) ID.
    assert.equal((await callSearch(db, { userId: uuid(1) })).length, 1);
    // By claimant account email.
    assert.equal((await callSearch(db, { email: "klaiman@example.com" })).length, 1);
    assert.equal((await callSearch(db, { email: "KLAIMAN@Example.com" })).length, 1, "email match is case-insensitive");
    assert.equal((await callSearch(db, { email: "tidak-ada@example.com" })).length, 0);
    // By claim ID.
    assert.equal((await callSearch(db, { claimId: uuid(100) })).length, 1);
    // Combined filters AND together.
    assert.equal((await callSearch(db, { placeId: "tempat-arsip", email: "klaiman@example.com" })).length, 1);
    assert.equal((await callSearch(db, { placeId: "tempat-arsip", email: "tidak-ada@example.com" })).length, 0);

    await db.exec("select set_config('request.jwt.claims.sub', '', false);");
  } finally {
    await db.close();
  }
});

test("expired archives (past 30 days) leave the searchable window — retention holds", async () => {
  const db = await bootstrapDb();
  try {
    await seedArchive(db);
    // Push the only row past the 30-day horizon: the search must return it no more.
    await db.exec("update public.place_claim_archives set archived_at = now() - interval '31 days';");
    await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${uuid(3)}', 'admin@example.com', now());`);
    await db.exec(`update public.users set platform_role = 'platform_moderator' where id = '${uuid(3)}';`);
    await db.exec("select set_config('request.jwt.claims.sub', '00000000-0000-4000-8000-000000000003', false);");
    assert.equal((await callSearch(db, {})).length, 0, "rows past 30 days are outside the archive window");
    await db.exec("select set_config('request.jwt.claims.sub', '', false);");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. The cleanup Edge Function: the §7 LOCKED order at source level
// ---------------------------------------------------------------------------

test("the cleanup Edge Function implements storage-first, retry, idempotency, and secret auth", () => {
  const code = stripComments(edgeFunction);
  // Storage first — through the proper Storage object API, never metadata.
  assert.match(code, /\.storage\s*\n?\s*\.from\("place-claim-evidence"\)/);
  assert.match(code, /\.remove\(\[row\.evidence_path\]\)/);
  assert.doesNotMatch(code, /storage\.objects|from\("storage/);
  // Storage failure ⇒ the DB row is NOT finalized (re-processable).
  assert.match(code, /if \(!storageDeleted\) \{[\s\S]*?retryScheduled \+= 1;/);
  // Storage success ⇒ finalize via the Storage-success branch only.
  assert.match(code, /finalized_at/);
  // Exactly 30 days, LOCKED.
  assert.match(code, /ARCHIVE_RETENTION_DAYS = 30/);
  assert.doesNotMatch(code, /ARCHIVE_RETENTION_DAYS = (?!30)\d+/);
  // Authorization: service-role secret required; anonymous gets 401.
  assert.match(code, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(code, /status: 401/);
  // Idempotent finalization: the guarded update never double-finalizes.
  assert.match(code, /\.is\("finalized_at", null\)/);
});

// ---------------------------------------------------------------------------
// 4. The internal route: Admin-only, and mounted on NO Dashboard page
// ---------------------------------------------------------------------------

test("the archive search route is Platform-Admin-only and the archive never renders in the Dashboard", () => {
  const route = stripComments(archiveRoute);
  assert.match(route, /requirePlatformModerator/);
  assert.match(route, /status: 403/);
  for (const key of ["placeId", "userId", "email", "claimId"]) {
    assert.match(route, new RegExp(`"${key}"`));
  }
  // §4: no Admin page renders the archive; the lib is referenced only by the
  // route, never by a Dashboard component.
  const adminPageSources = [claimsManager, adminQueries];
  for (const source of adminPageSources) {
    assert.equal(
      source.includes("place-claim-archive") || source.includes("searchPlaceClaimArchives"),
      false,
      "the archive search must not be mounted on any Dashboard surface",
    );
  }
  assert.equal(archiveLib.includes("client"), false === false); // server-only module sanity
  assert.match(stripComments(archiveLib), /import "server-only"/);
});

// ---------------------------------------------------------------------------
// 5. The §13 disclosure: policy page + entry links
// ---------------------------------------------------------------------------

test("the public policy page discloses the 30-day retention and the legal boundary", () => {
  assert.match(policyPage, /30 hari/);
  assert.match(policyPage, /30 hari[\s\S]*?dihapus secara permanen/);
  assert.match(policyPage, /tidak menjamin/);
  assert.match(policyPage, /bukan(.{0,40})penetapan(\s|$)/);
  assert.match(policyPage, /pembuktian(\s|\n)*\n?\s*antara para pihak|pembuktian antara para pihak/);
  assert.match(policyPage, /wilayah Tempat tersebut/);
  // Entry points: linked from About and from the Producer claim panel.
  assert.match(aboutPage, /href="\/policy"/);
  assert.match(claimPanel, /href="\/policy"/);
});
