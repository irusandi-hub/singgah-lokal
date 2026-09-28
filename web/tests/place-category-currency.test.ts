import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * PLACE CATEGORY + CURRENCY CANONICALIZATION — migration 0033 (PO, 2026-09-28).
 *
 * The vocabulary rules (three categories, two currencies) are proven against
 * the shared validator in place-management.test.ts; here the DATABASE rules
 * run on a real Postgres engine over the migration chain: legacy data is
 * seeded BEFORE 0033, then the migration reclassifies every existing Place,
 * maps the currencies, and adds the two CHECK constraints — semantics, not
 * SQL reading.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

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

const PRE_0033 = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0019_bakso_migran_demo_place.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
  "0028_place_claims.sql",
  "0031_place_audit.sql",
  "0032_place_geography.sql",
] as const;

/**
 * Schema up to 0032 (which already seeds the four legacy Places with the
 * retired categories through migrations 0001 and 0019), two extra legacy
 * rows for the catch-all rules, then 0033 applied on top.
 */
async function withLegacyDb(run: (db: PGlite) => Promise<void>): Promise<void> {
  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    await db.exec("create publication supabase_realtime;");
    for (const name of PRE_0033) await db.exec(stripPgcrypto(readMigration(name)));
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, country_code, region_name, timezone, currency)
      values
        ('tempat-lain', 'Tempat Lain', 'd', 'Kuliner', 'experience', 'Bandung', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'JPY'),
        ('tempat-tanpa-negara', 'Tempat Tanpa Negara', 'd', 'Kuliner', 'experience', 'Bandung', null, null, 'Asia/Jakarta', 'EUR');
    `);
    await db.exec(stripPgcrypto(readMigration("0033_place_category_currency.sql")));
    await run(db);
  } finally {
    await db.close();
  }
}

const rows = async (db: PGlite, query: string): Promise<Record<string, unknown>[]> =>
  ((await db.query(query)).rows ?? []) as Record<string, unknown>[];

test("the migration chain carries 0033 after 0032", () => {
  const sql = stripComments(readMigration("0033_place_category_currency.sql"));
  // Nothing is destroyed: no Place, no history row.
  assert.doesNotMatch(sql, /drop\s+table/i);
  assert.doesNotMatch(sql, /delete\s+from/i);
  assert.doesNotMatch(sql, /drop\s+column/i);
  // The named Places are reclassified, guarded against overwriting an
  // operator-corrected value on re-apply.
  assert.match(sql, /where name = 'Kopi dari Kebun'/);
  assert.match(sql, /where name = 'Bakso Migran'/);
  assert.match(sql, /where name = 'Rumah Teh Lokal'/);
  assert.match(sql, /where name = 'Dapur Rasa'/);
  assert.match(sql, /not in \('Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa'\)/);
  // Both CHECK constraints are idempotent and complete.
  assert.match(sql, /drop constraint if exists places_category_check/);
  assert.match(sql, /add constraint places_category_check/);
  assert.match(sql, /drop constraint if exists places_currency_check/);
  assert.match(sql, /add constraint places_currency_check/);
});

test("existing Places are reclassified into exactly the three categories", async () => {
  await withLegacyDb(async (db) => {
    const byId = new Map(
      (await rows(db, "select id, category, currency from public.places order by id")).map((row) => [
        String(row.id),
        { category: String(row.category), currency: String(row.currency) },
      ]),
    );
    // The PO mapping (PO, 2026-09-28).
    assert.equal(byId.get("kopi-dari-kebun")?.category, "Sumber Daya Alam");
    assert.equal(byId.get("bakso-migran")?.category, "Industri & Pengolahan");
    assert.equal(byId.get("rumah-teh-lokal")?.category, "Perdagangan & Jasa");
    assert.equal(byId.get("dapur-rasa")?.category, "Perdagangan & Jasa");
    // No row keeps an old category; other Places are classified by character
    // (experience → trade & services), never into a new category.
    assert.equal(byId.get("tempat-lain")?.category, "Perdagangan & Jasa");
    assert.equal(byId.get("tempat-tanpa-negara")?.category, "Perdagangan & Jasa");
    // No Place was created or destroyed by the migration: the four legacy
    // seeds plus the two extra rows.
    assert.equal(byId.size, 6);
    // Currency: every existing value maps onto IDR/USD by the Place's country.
    assert.equal(byId.get("rumah-teh-lokal")?.currency, "IDR");
    for (const row of byId.values()) {
      assert.ok(["IDR", "USD"].includes(row.currency), `currency ${row.currency} must be canonical`);
      assert.ok(
        ["Sumber Daya Alam", "Industri & Pengolahan", "Perdagangan & Jasa"].includes(row.category),
        `category ${row.category} must be canonical`,
      );
    }
  });
});

test("the category and currency CHECKs refuse anything outside the vocabulary", async () => {
  await withLegacyDb(async (db) => {
    // The constraints exist on the table.
    const constraints = await rows(
      db,
      "select conname from pg_constraint where conrelid = 'public.places'::regclass and contype = 'c'",
    );
    const names = constraints.map((row) => String(row.conname));
    assert.ok(names.includes("places_category_check"), "places_category_check must exist");
    assert.ok(names.includes("places_currency_check"), "places_currency_check must exist");

    // A retired category is refused at the database level — even by raw SQL
    // that bypasses every form and validator.
    await assert.rejects(
      () =>
        db.exec(
          `insert into public.places (id, name, short_description, category, type, area, timezone, currency)
           values ('x-kopi', 'X Kopi', 'd', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR');`,
        ),
      /places_category_check/,
    );
    await assert.rejects(
      () =>
        db.exec(
          `insert into public.places (id, name, short_description, category, type, area, timezone, currency)
           values ('x-craft', 'X Craft', 'd', 'craft', 'production', 'Bandung', 'Asia/Jakarta', 'IDR');`,
        ),
      /places_category_check/,
    );
    // A currency outside IDR/USD is equally refused.
    await assert.rejects(
      () =>
        db.exec(
          `insert into public.places (id, name, short_description, category, type, area, timezone, currency)
           values ('x-eur', 'X EUR', 'd', 'Perdagangan & Jasa', 'production', 'Bandung', 'Asia/Jakarta', 'EUR');`,
        ),
      /places_currency_check/,
    );
    // Each of the three categories is really accepted.
    for (const category of ["Sumber Daya Alam", "Industri & Pengolahan", "Perdagangan & Jasa"]) {
      await db.exec(
        `insert into public.places (id, name, short_description, category, type, area, timezone, currency)
         values ('ok-${category.length}', 'Ok ${category}', 'd', '${category}', 'production', 'Bandung', 'Asia/Jakarta', 'USD');`,
      );
    }
  });
});

test("re-applying 0033 is a no-op on already-canonical data", async () => {
  await withLegacyDb(async (db) => {
    const before = await rows(db, "select id, category, currency from public.places order by id");
    // Apply the migration a second time: the guarded updates and the
    // drop-then-add constraints make it idempotent.
    await db.exec(stripPgcrypto(readMigration("0033_place_category_currency.sql")));
    const after = await rows(db, "select id, category, currency from public.places order by id");
    assert.deepEqual(after, before);
  });
});
