import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * 1 AKUN = 1 PLACE regression (PO request, 2026-09-25).
 *
 * A single account may hold at most ONE producer_membership row. Migration
 * 0020 enforces this at the DATABASE level (unique index on user_id) so no
 * application path can bypass it. The harness executes the migration chain
 * on a real Postgres engine (PGlite):
 * - a second membership for a DIFFERENT Place on the same user_id is
 *   rejected by the unique index;
 * - the migration is idempotent (safe to re-run);
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

test("Migration 0020 exists as the next free number and only adds the one-membership-per-user index", () => {
  const sql = readMigration("0020_one_membership_per_user.sql");
  assert.match(sql, /create unique index if not exists producer_memberships_one_per_user_idx/);
  assert.match(sql, /on public\.producer_memberships \(user_id\)/);
  // The constraint is a pure schema addition: it must never delete or
  // rewrite membership data (no destructive data migration).
  assert.doesNotMatch(sql, /delete from|truncate|drop table|drop column/i);
});

test("No migration seeds Producer rows (DEV producers were reset by the PO)", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.includes("0020_one_membership_per_user.sql"), "0020 must exist in the migration chain");
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
  // 0020 itself is schema-only: it inserts no rows at all.
  const migration0020 = readMigration("0020_one_membership_per_user.sql");
  assert.doesNotMatch(migration0020, /\binsert\s+into\b/i);
  // The demo Place keeps its canonical coordinates and gains NO producer.
  const bakso = readMigration("0019_bakso_migran_demo_place.sql");
  assert.match(bakso, /26\.3642121/);
  assert.match(bakso, /50\.1988771/);
  assert.doesNotMatch(bakso, /producer_id/);
});

test("0020 rejects a second membership for the same account on a different Place", async () => {
  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    await db.exec("create publication supabase_realtime;");
    for (const name of FOUNDATION) {
      await db.exec(stripPgcrypto(readMigration(name)));
    }
    await db.exec(stripPgcrypto(readMigration("0020_one_membership_per_user.sql")));

    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const userId = uuid(1);
    await db.exec(`insert into auth.users (id, email_confirmed_at) values ('${userId}', now());`);
    await db.exec(`insert into public.producers (id, display_name) values ('p-1', 'Producer 1');`);
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
      values ('place-a', 'Place A', 'desc', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', 'p-1'),
             ('place-b', 'Place B', 'desc', 'Teh', 'production', 'Lembang', 'Asia/Jakarta', 'IDR', 'p-1');
    `);

    // First membership: fine.
    await db.exec(`
      insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values ('${userId}', 'p-1', 'place-a', 'owner');
    `);

    // Second Place on the SAME account: must be refused by the unique index.
    await assert.rejects(
      () =>
        db.query(
          `insert into public.producer_memberships (user_id, producer_id, place_id, role)
           values ('${userId}', 'p-1', 'place-b', 'manager');`,
        ),
      /duplicate key|unique constraint|producer_memberships_one_per_user_idx/i,
    );

    // Exactly one membership row remains for the account.
    const rows = ((await db.query(
      "select place_id, role from public.producer_memberships where user_id = $1",
      [userId],
    )).rows ?? []) as { place_id: string; role: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].place_id, "place-a");

    // Another ACCOUNT may still hold its own membership (the rule is
    // per-account, not per-table).
    const other = uuid(2);
    await db.exec(`insert into auth.users (id, email_confirmed_at) values ('${other}', now());`);
    await db.exec(`
      insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values ('${other}', 'p-1', 'place-b', 'owner');
    `);
    const all = ((await db.query("select count(*)::int as c from public.producer_memberships"))
      .rows ?? []) as { c: number }[];
    assert.equal(all[0].c, 2);
  } finally {
    await db.close();
  }
});

test("0020 is idempotent — re-running the migration changes nothing", async () => {
  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    await db.exec("create publication supabase_realtime;");
    for (const name of FOUNDATION) {
      await db.exec(stripPgcrypto(readMigration(name)));
    }
    await db.exec(stripPgcrypto(readMigration("0020_one_membership_per_user.sql")));
    // Re-apply (Supabase CLI re-runs are no-ops thanks to IF NOT EXISTS).
    await db.exec(stripPgcrypto(readMigration("0020_one_membership_per_user.sql")));

    const indexes = ((await db.query(
      `select indexname from pg_indexes
       where schemaname = 'public' and tablename = 'producer_memberships'
         and indexname = 'producer_memberships_one_per_user_idx'`,
    )).rows ?? []) as { indexname: string }[];
    assert.equal(indexes.length, 1, "exactly one one-per-user index exists");
  } finally {
    await db.close();
  }
});
