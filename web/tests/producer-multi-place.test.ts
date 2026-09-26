import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * 1 PRODUCER = N PLACE regression (PO decision, 2026-09-26).
 *
 * A single account may hold producer_memberships for MULTIPLE Places.
 * Migration 0020 (one-membership-per-user, PO request 2026-09-25) stays in
 * the migration history untouched; migration 0022 retires its unique index.
 * The foundation PK (user_id, place_id) from 0001 remains the only
 * membership constraint: no duplicate (user, place) pairs, but N Places per
 * account. The harness executes the migration chain on a real Postgres
 * engine (PGlite):
 * - 0022 drops the 0020 index and is idempotent (safe to re-run);
 * - multiple memberships for the same user_id across DIFFERENT Places are
 *   accepted — the new rule;
 * - a duplicate (user_id, place_id) pair is still rejected by the PK;
 * - no migration re-seeds Producer data (DEV producers=0 by PO decision —
 *   Bakso Migran stays a demo Place with NO producer).
 */

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

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

const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
] as const;

test("Migration 0022 retires the one-membership-per-user index while 0020 stays in history", () => {
  const sql = readMigration("0022_allow_multiple_places_per_producer.sql");
  assert.match(sql, /drop index if exists public\.producer_memberships_one_per_user_idx/);
  // 0022 must retire the rule, not re-introduce it, and must be a pure
  // schema change: no destructive data migration, no seeding.
  assert.doesNotMatch(sql, /create unique index/i);
  assert.doesNotMatch(sql, /delete from|truncate|drop table|drop column/i);
  assert.doesNotMatch(sql, /\binsert\s+into\b/i);

  // History is preserved: 0020 remains in the chain with its original
  // unique-index definition (never rewritten to hide the old rule).
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes("0020_one_membership_per_user.sql"), "0020 must remain in the migration chain");
  assert.ok(files.includes("0022_allow_multiple_places_per_producer.sql"), "0022 must exist as the next free number");
  const migration0020 = readMigration("0020_one_membership_per_user.sql");
  assert.match(migration0020, /create unique index if not exists producer_memberships_one_per_user_idx/);
  assert.match(migration0020, /on public\.producer_memberships \(user_id\)/);
});

test("No migration seeds Producer rows (DEV producers were reset by the PO)", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const sql = readMigration(name);
    // Migrations never seed the producers table (DEV producers=0 by PO
    // decision; approval creates memberships through the 0016 RPC, not
    // through migration data).
    assert.doesNotMatch(
      sql,
      /insert\s+into\s+public\.producers\b/i,
      `${name} must not seed producer rows`,
    );
  }
  // The demo Place keeps its canonical coordinates and gains NO producer.
  const bakso = readMigration("0019_bakso_migran_demo_place.sql");
  assert.match(bakso, /26\.3642121/);
  assert.match(bakso, /50\.1988771/);
  assert.doesNotMatch(bakso, /producer_id/);
});

test("0022 allows multiple memberships for one account across different Places", async () => {
  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    await db.exec("create publication supabase_realtime;");
    for (const name of FOUNDATION) {
      await db.exec(stripPgcrypto(readMigration(name)));
    }
    // Apply the old rule first, then retire it: this is the exact upgrade
    // path of an environment that already ran 0020.
    await db.exec(stripPgcrypto(readMigration("0020_one_membership_per_user.sql")));
    await db.exec(stripPgcrypto(readMigration("0022_allow_multiple_places_per_producer.sql")));

    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const userId = uuid(1);
    await db.exec(`insert into auth.users (id, email_confirmed_at) values ('${userId}', now());`);
    await db.exec(`insert into public.producers (id, display_name) values ('p-1', 'Producer 1');`);
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
      values ('place-a', 'Place A', 'desc', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', 'p-1'),
             ('place-b', 'Place B', 'desc', 'Teh', 'production', 'Lembang', 'Asia/Jakarta', 'IDR', 'p-1');
    `);

    // THE NEW RULE: the same account may own several Places. Both inserts
    // must succeed even though 0020 ran first.
    await db.exec(`
      insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values ('${userId}', 'p-1', 'place-a', 'owner'),
             ('${userId}', 'p-1', 'place-b', 'owner');
    `);

    const rows = ((await db.query(
      "select place_id, role from public.producer_memberships where user_id = $1 order by place_id",
      [userId],
    )).rows ?? []) as { place_id: string; role: string }[];
    assert.deepEqual(
      rows.map((row) => ({ place_id: row.place_id, role: row.role })),
      [
        { place_id: "place-a", role: "owner" },
        { place_id: "place-b", role: "owner" },
      ],
    );

    // The foundation PK (user_id, place_id) is preserved: a duplicate pair
    // is still rejected.
    await assert.rejects(
      () =>
        db.query(
          `insert into public.producer_memberships (user_id, producer_id, place_id, role)
           values ('${userId}', 'p-1', 'place-a', 'owner');`,
        ),
      /duplicate key|unique constraint|producer_memberships_pkey/i,
    );

    // A second ACCOUNT may hold its own membership for the same Places
    // (membership is per (user, place), never global).
    const other = uuid(2);
    await db.exec(`insert into auth.users (id, email_confirmed_at) values ('${other}', now());`);
    await db.exec(`
      insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values ('${other}', 'p-1', 'place-a', 'manager');
    `);
    const all = ((await db.query("select count(*)::int as c from public.producer_memberships"))
      .rows ?? []) as { c: number }[];
    assert.equal(all[0].c, 3);
  } finally {
    await db.close();
  }
});

test("0022 is idempotent and fully removes the 0020 index, keeping the foundation PK", async () => {
  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    await db.exec("create publication supabase_realtime;");
    for (const name of FOUNDATION) {
      await db.exec(stripPgcrypto(readMigration(name)));
    }
    await db.exec(stripPgcrypto(readMigration("0020_one_membership_per_user.sql")));
    await db.exec(stripPgcrypto(readMigration("0022_allow_multiple_places_per_producer.sql")));
    // Re-apply (Supabase CLI re-runs are no-ops thanks to IF EXISTS).
    await db.exec(stripPgcrypto(readMigration("0022_allow_multiple_places_per_producer.sql")));

    const staleIndex = ((await db.query(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'producer_memberships'
         and indexname = 'producer_memberships_one_per_user_idx'`,
    )).rows ?? []) as { indexname: string }[];
    assert.equal(staleIndex.length, 0, "the one-per-user index must be gone");

    const primaryKey = ((await db.query(
      `select constraintname from (
         select conname as constraintname
         from pg_constraint
         where conrelid = 'public.producer_memberships'::regclass and contype = 'p'
       ) t`,
    )).rows ?? []) as { constraintname: string }[];
    assert.equal(primaryKey.length, 1, "the (user_id, place_id) primary key must remain");
  } finally {
    await db.close();
  }
});
