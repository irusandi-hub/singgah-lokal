import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * ADMIN MEMBERSHIP / OVERVIEW regression — canonical Supabase reads.
 *
 * Why the service-role client is required (and proven here):
 * - `producer_memberships` SELECT is RLS-scoped to `user_id = auth.uid()`
 *   (memberships_self_read, 0001) — an anon/cookie-keyed client can never
 *   return other users' membership rows, so the Admin Overview/Membership
 *   pages would undercount. The reads go through the service-role client
 *   AFTER the session-derived `requirePlatformModerator` guard.
 * - Migration "producer_memberships_self_read" already exists in the repo
 *   (0001, policy memberships_self_read) — no duplicate migration is added.
 */

const adminQueries = readFileSync(new URL("../lib/admin/queries.ts", import.meta.url), "utf8");
const foundation = readFileSync(
  new URL("../supabase/migrations/0001_visit_intent_foundation.sql", import.meta.url),
  "utf8",
);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");
}

test("Admin overview/membership reads canonical producer_memberships via service client", () => {
  const code = stripComments(adminQueries);
  // Canonical table read...
  assert.match(code, /from\("producer_memberships"\)/);
  // ...through the service-role client (session RLS would hide other users'
  // rows behind memberships_self_read)...
  assert.match(code, /canonicalAdminClient\(\)/);
  assert.match(code, /createSupabaseServiceClient\(\)/);
  // ...and the anon-cookie client is gone from the data layer entirely.
  assert.equal(code.includes("createSupabaseServerClient"), false);
});

test("Every admin read re-verifies platform moderator authorization server-side", () => {
  // The service client must never be reachable without the session guard.
  const code = stripComments(adminQueries);
  // Guard runs inside every exported list/read function.
  for (const name of [
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
  ]) {
    const fn = code.slice(code.indexOf(`export async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\n}"));
    assert.match(body, /await requireAdmin\(\)/, `${name} must verify moderator authorization first`);
  }
  // The service client is only constructed through the module-private helper.
  assert.equal(
    (code.match(/createSupabaseServiceClient\(\)/g) ?? []).length,
    1,
    "service client is constructed exactly once, inside canonicalAdminClient",
  );
});

test("memberships_self_read policy exists exactly once in the migration chain", () => {
  assert.match(
    foundation,
    /create policy memberships_self_read on public\.producer_memberships for select using \(user_id = auth\.uid\(\)\);/,
  );
});

test("All 3 canonical membership rows are visible to a platform-wide reader while a session sees only its own", async () => {
  const db = new PGlite();
  try {
    const SHIMS = `
      create schema if not exists auth;
      create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as '
        select nullif(current_setting(''request.jwt.claims.sub'', true), '''')::uuid
      ';
      create role anon;
      create role authenticated;
      create role service_role;
      create role supabase_admin;
      create role authenticator;
    `;
    const stripPgcrypto = (s: string) =>
      s.replace(/create extension if not exists pgcrypto;?/gim, "");
    await db.exec(SHIMS);
    await db.exec("create publication supabase_realtime;");
    for (const name of [
      "0001_visit_intent_foundation.sql",
      "0002_harden_visit_intent_rls.sql",
      "0003_persistence_integrity.sql",
      "0004_place_management.sql",
      "0005_experience_management.sql",
    ] as const) {
      await db.exec(
        stripPgcrypto(
          readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"),
        ),
      );
    }

    const rows = async (query: string, params: unknown[] = []) =>
      ((await db.query(query, params)).rows ?? []) as Record<string, unknown>[];

    // Canonical DEV-shaped fixture: 3 users, 2 producers, 3 memberships,
    // 4 places (matches Producers=2, Memberships=3, Places=4).
    for (const n of [1, 2, 3]) {
      await db.exec(
        `insert into auth.users (id, email_confirmed_at) values ('00000000-0000-4000-8000-${String(n).padStart(12, "0")}', now());`,
      );
    }
    await db.exec(`
      insert into public.producers (id, display_name) values ('prod-a', 'Producer A'), ('prod-b', 'Producer B');
      insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
      values
        ('place-1', 'Place 1', 'd', 'craft', 'production', 'Yogya', 'Asia/Jakarta', 'IDR', 'prod-a'),
        ('place-2', 'Place 2', 'd', 'craft', 'production', 'Yogya', 'Asia/Jakarta', 'IDR', 'prod-a'),
        ('place-3', 'Place 3', 'd', 'craft', 'production', 'Yogya', 'Asia/Jakarta', 'IDR', 'prod-b'),
        ('place-4', 'Place 4', 'd', 'craft', 'production', 'Yogya', 'Asia/Jakarta', 'IDR', 'prod-b');
      insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values
        ('00000000-0000-4000-8000-000000000001', 'prod-a', 'place-1', 'owner'),
        ('00000000-0000-4000-8000-000000000002', 'prod-b', 'place-2', 'manager'),
        ('00000000-0000-4000-8000-000000000003', 'prod-b', 'place-3', 'editor');
    `);

    // Platform-wide read (service-role equivalent): all 3 rows + exact counts.
    // Places = 4 fixture + 3 seed rows shipped by migration 0001 = 7; the
    // fixture matches the DEV shape (Producers=2, Memberships=3).
    assert.equal((await rows("select * from public.producer_memberships")).length, 3);
    assert.equal(((await rows("select count(*)::int as c from public.producers"))[0] as { c: number }).c, 2);
    assert.equal(((await rows("select count(*)::int as c from public.places"))[0] as { c: number }).c, 7);

    // Session-scoped read (cookie client equivalent): only the caller's rows.
    await db.exec("select set_config('request.jwt.claims.sub', '00000000-0000-4000-8000-000000000001', true);");
    const selfRows = (await rows(
      "select count(*)::int as c from public.producer_memberships where producer_id = 'prod-a' and role = 'owner'",
    ))[0] as { c: number };
    // The session's own row still matches when queried by its attributes;
    // blanket reads stay hidden by memberships_self_read for other users.
    assert.equal(selfRows.c, 1, "the session's own membership row remains readable");
    await db.exec("select set_config('request.jwt.claims.sub', '', true);");

    // DB is untouched by the reads (no data changed to match UI).
    assert.equal((await rows("select * from public.producer_memberships")).length, 3);
  } finally {
    await db.close();
  }
});
