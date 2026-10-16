import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";

/**
 * 0057 diterapkan DI ATAS rantai migrasi nyata (jalur SQL-Editor runbook).
 *
 * `docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md` menempelkan migrasi satu per
 * satu, berurutan, ke atas rantai yang sudah ada. Test ini menjalankan SELURUH
 * rantai `supabase/migrations/*.sql` berurutan di mesin Postgres nyata (PGlite)
 * dan membuktikan bahwa 0057:
 * - menempel bersih setelah 0056 tanpa menyentuh migrasi 0046–0056;
 * - idempoten (dijalankan ulang = no-op);
 * - tidak menambah GRANT apa pun ke anon;
 * - tidak mematikan RLS;
 * - MENGUBAH HANYA `producer_memberships` (satu kolom + satu unique index) dan
 *   CHECK `action` pada `place_audit`, lalu menambah RPC yang hanya
 *   `service_role` boleh memanggilnya.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

/** Every migration, in the order the runbook applies them. */
const ALL_MIGRATIONS = readdirSync(new URL(MIGRATION_DIR, import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();

/** The numeric prefix of a migration file name ("0057_..." → 57). */
const migrationNumber = (name: string): number => Number(name.slice(0, 4));

/** Strip line/block comments so a source assertion checks CODE, not prose. */
const stripComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

async function applyChain(db: PGlite, names: readonly string[]): Promise<void> {
  for (const name of names) {
    try {
      await db.exec(stripPgcrypto(readMigration(name)));
    } catch (error) {
      throw new Error(`${name} failed to apply: ${(error as Error).message}`);
    }
    if (name === "0001_visit_intent_foundation.sql") {
      // Supabase grants its default table privileges when a table is CREATED,
      // i.e. before the later explicit REVOKE/GRANT statements run. Applying
      // them here is what makes each migration's lockdown the real posture.
      await db.exec(
        `grant usage on schema public to anon, authenticated, service_role;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
}

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key,
      email text,
      email_confirmed_at timestamptz,
      encrypted_password text,
      phone text,
      raw_user_meta_data jsonb,
      raw_app_meta_data jsonb
    );
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
    alter role service_role bypassrls;
    grant usage on schema auth to anon, authenticated;

    create schema if not exists realtime;
    create table realtime.messages (id bigserial primary key, topic text, extension text, event text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to anon, authenticated;
    grant select on realtime.messages to anon, authenticated;
    create function realtime.topic() returns text language sql stable as 'select current_setting(''realtime.topic'', true)';
    create function realtime.send(p_payload jsonb, p_event text, p_topic text, p_private boolean default true)
      returns void language plpgsql as $$
      begin
        insert into realtime.messages (topic, extension, event, payload)
        values (p_topic, 'broadcast', p_event, p_payload);
      end;
      $$;

    create schema if not exists storage;
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text,
      name text,
      owner uuid,
      metadata jsonb,
      created_at timestamptz default now()
    );
    alter table storage.objects enable row level security;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  `);
  await db.exec("create publication supabase_realtime;");
  return db;
}

test("0057: dipakai setelah 0056, sekali, bersih, tanpa menyentuh 0046–0056", async () => {
  const db = await createDb();
  const upTo0056 = ALL_MIGRATIONS.filter((name) => migrationNumber(name) <= 56);
  assert.ok(upTo0056.includes("0056_live_moderation_audit_trail.sql"));
  assert.ok(!upTo0056.includes("0057_admin_revoke_producer_place_access.sql"));
  assert.ok(upTo0056.length >= 50, `expected the whole chain, got ${upTo0056.length} files`);

  // 1. Seluruh rantai sampai 0056 (termasuk data DEV) harus bersih dulu.
  await applyChain(db, upTo0056);

  // Snapshot taken BEFORE 0057: the surrogate `id` does not exist yet, so the
  // pre-existing canonical columns are what must survive untouched.
  // (0058 later REPLACES the RPC signature and 0059 adds the legal-document
  // registry; both run after this snapshot and change no membership row.)
  const beforeSnapshot = await db.query(
    `select user_id, producer_id, place_id, role from public.producer_memberships order by user_id, place_id`,
  );

  // 2. Terapkan 0057 (jalur paste SQL Editor runbook).
  await applyChain(db, ["0057_admin_revoke_producer_place_access.sql"]);

  // 3. Idempoten: menerapkan ulang = no-op, tanpa error.
  await applyChain(db, ["0057_admin_revoke_producer_place_access.sql"]);

  // 4. Tidak ada baris membership yang hilang/diubah — hanya kolom id ditambah.
  const afterSnapshot = await db.query(
    `select user_id, producer_id, place_id, role from public.producer_memberships order by user_id, place_id`,
  );
  assert.deepEqual(
    afterSnapshot.rows,
    beforeSnapshot.rows,
    "0057 must not add, remove, or alter membership rows",
  );

  // Setiap baris lama kini punya id yang terisi.
  const missing = await db.query(
    `select count(*)::int as n from public.producer_memberships where id is null`,
  );
  assert.equal((missing.rows[0] as Record<string, unknown>).n, 0);

  // 5. Posture RLS tidak berubah di kedua tabel yang disentuh.
  for (const table of ["public.producer_memberships", "public.place_audit", "public.notifications"]) {
    const rls = await db.query(
      `select relrowsecurity as ok from pg_class where oid = '${table}'::regclass`,
    );
    assert.equal((rls.rows[0] as Record<string, unknown>).ok, true, `${table} RLS harus tetap menyala`);
  }

  // 6. Tidak ada GRANT baru ke anon dari 0057.
  const sql = readMigration("0057_admin_revoke_producer_place_access.sql");
  assert.doesNotMatch(sql, /grant\s+[^;]*\bto\s+anon\b/i);
  assert.match(sql, /grant execute on function public\.revoke_producer_place_access\(uuid, uuid\) to service_role;/);

  const anonExecute = await db.query(
    `select has_function_privilege('anon', 'public.revoke_producer_place_access(uuid, uuid)', 'execute') as ok`,
  );
  assert.equal((anonExecute.rows[0] as Record<string, unknown>).ok, false);
  const serviceExecute = await db.query(
    `select has_function_privilege('service_role', 'public.revoke_producer_place_access(uuid, uuid)', 'execute') as ok`,
  );
  assert.equal((serviceExecute.rows[0] as Record<string, unknown>).ok, true);

  // 7. Rantai tidak berubah: 0046–0056 tetap ada, tidak ada nomor yang bolong,
  // dan 0059 adalah nomor tertinggi (kebijakan 0058 + dokumen hukum 0059).
  // 0060 (Live ↔ Kegiatan/Kelola Proses decoupling) ditambahkan setelah 0059
  // dan TIDAK mengubah migrasi mana pun di atasnya.
  const numbers = ALL_MIGRATIONS.map(migrationNumber);
  for (let n = 46; n <= 59; n += 1) {
    assert.ok(numbers.includes(n), `migration ${n} must still exist`);
  }
  assert.equal(
    numbers[numbers.length - 1],
    60,
    "0060 is the highest migration number in the chain",
  );
  assert.deepEqual(
    numbers,
    Array.from({ length: numbers.length }, (_, index) => numbers[0] + index),
    "the migration chain has no gaps and no renumbering",
  );

  await db.close();
});

test("db-regression/admin-revoke-place-access.sql lulus semua check dan rollback", async () => {
  const db = await createDb();
  await applyChain(db, ALL_MIGRATIONS);

  const script = readFileSync(
    new URL("./db-regression/admin-revoke-place-access.sql", import.meta.url),
    "utf8",
  );
  const results = await db.exec(script);
  const checkSet = results.find((result) =>
    (result.fields ?? []).some((field) => field.name === "check_name"),
  );
  assert.ok(checkSet, "the script must emit its (ord, check_name, passed, detail) result set");
  const checkRows = (checkSet.rows ?? []) as Array<Record<string, unknown>>;
  assert.ok(checkRows.length >= 30, `expected at least 30 checks, got ${checkRows.length}`);
  const failures = checkRows.filter((row) => row.passed !== true);
  assert.deepEqual(
    failures.map((row) => ({ ord: row.ord, check_name: row.check_name, detail: row.detail })),
    [],
    "every check must pass",
  );
  // Setiap nomor 1..33 hadir (schema, happy path, kebijakan managerless, alasan
  // wajib, idempotensi/isolasi, batas akses klien).
  const ords = checkRows.map((row) => Number(row.ord)).sort((a, b) => a - b);
  assert.deepEqual(ords, Array.from({ length: 33 }, (_, index) => index + 1));

  // Rollback: tidak ada residu fixture.
  const leftover = await db.query(
    `select 1 as one from public.producers where id = 'prod-admin-revoke-dev'`,
  );
  assert.equal((leftover.rows ?? []).length, 0, "skrip harus rollback fixture-nya");

  await db.close();
});

test("0057: tidak menyentuh kebijakan Live (assert_viewer_eligible / admit_live_viewer)", () => {
  // Comments mention the Live gates by name (as the immutable object set this
  // file must not touch); the assertion checks the executable statements only.
  const sql = stripComments(readMigration("0057_admin_revoke_producer_place_access.sql"));
  for (const liveObject of [
    "assert_viewer_eligible",
    "admit_live_viewer",
    "live_sessions",
    "live_operators",
    "live_viewer_presence",
    "live_capability_suspensions",
  ]) {
    assert.doesNotMatch(sql, new RegExp(liveObject), `0057 must not touch ${liveObject}`);
  }
  // Non-destruktif: tidak ada tabel/kolom yang dihapus.
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /drop column/i);
  // Satu-satunya DELETE adalah baris membership yang dicabut.
  const deletes = sql.match(/delete from [a-z_."]+/gi) ?? [];
  assert.deepEqual(deletes, ["delete from public.producer_memberships"], "only the membership row is deleted");
  // Migrasi 0046–0056 tidak disentuh sama sekali.
  for (const name of ALL_MIGRATIONS.filter((n) => migrationNumber(n) >= 46 && migrationNumber(n) <= 56)) {
    assert.equal(
      readMigration(name).includes("producer_place_access"),
      false,
      `${name} must be untouched by this feature`,
    );
  }
});
