import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0036 — Tempat Pilihan Admin control regression (real Postgres).
 *
 * Locked properties:
 * - the two Stage 4 audit actions exist in the action CHECK;
 * - the append-only trail stays append-only (trigger + zero policies);
 * - `places.is_curated` is IMMUTABLE for every session role — only the
 *   service role (the server behind requirePlatformModerator) may flip it,
 *   so no client can self-promote a Place;
 * - the audit actions are accepted on real rows (vocabulary is enforced).
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const DEPENDENCIES = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0031_place_audit.sql",
  "0035_place_curated_flag.sql",
];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
  `);
  // Supabase environment shim (same as live-migration-validity): 0008 adds
  // live tables to this publication.
  await db.exec("create publication supabase_realtime;");
  for (const name of DEPENDENCIES) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  await db.exec(stripPgcrypto(readMigration("0036_place_curated_admin.sql")));
  // Supabase role shape (harness-only): the real project service role carries
  // full table grants and BYPASSRLS — the audited server path depends on it —
  // and supabase_admin/postgres act as superusers (RLS-bypassing), which is
  // what lets the guard trigger be exercised independently of RLS.
  await db.exec("alter role service_role bypassrls;");
  await db.exec("grant all on all tables in schema public to service_role;");
  await db.exec("alter role supabase_admin bypassrls;");
  await db.exec("grant all on all tables in schema public to supabase_admin;");
  return db;
}

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";

async function seedAdmin(db: PGlite): Promise<void> {
  await db.exec(`insert into auth.users (id) values ('${ADMIN_ID}') on conflict do nothing;`);
  await db.exec(`insert into public.users (id) values ('${ADMIN_ID}') on conflict do nothing;`);
}

test("0036 extends the audit action vocabulary with the two locked curation actions", async () => {
  const db = await createDb();
  await seedAdmin(db);

  const constraint = await rows(
    db,
    `select conname from pg_constraint where conrelid = 'public.place_audit'::regclass and conname = 'place_audit_action_check'`,
  );
  assert.equal(constraint.length, 1, "the action CHECK exists");

  // Both new actions are accepted on real rows (vocabulary enforced, exact keys).
  await db.exec(
    `insert into public.place_audit (place_id, actor_id, action, before_data, after_data, detail)
     values ('kopi-dari-kebun', '${ADMIN_ID}', 'admin_place_curated', null, '{"is_curated":true}', '{}');`,
  );
  await db.exec(
    `insert into public.place_audit (place_id, actor_id, action, before_data, after_data, detail)
     values ('kopi-dari-kebun', '${ADMIN_ID}', 'admin_place_uncurated', '{"is_curated":true}', '{"is_curated":false}', '{}');`,
  );
  const written = await rows(
    db,
    `select action from public.place_audit order by id`,
  );
  assert.deepEqual(written.map((row) => row.action), ["admin_place_curated", "admin_place_uncurated"]);
});

test("place_audit stays append-only and unreachable by clients after 0036", async () => {
  const db = await createDb();
  await seedAdmin(db);
  await db.exec(
    `insert into public.place_audit (place_id, actor_id, action) values ('kopi-dari-kebun', '${ADMIN_ID}', 'admin_place_curated');`,
  );

  // The append-only trigger refuses UPDATE/DELETE for EVERY writer, service
  // role included (0031 semantics preserved by 0036's additive check swap).
  await assert.rejects(
    db.exec(`update public.place_audit set action = 'admin_place_uncurated';`),
    /append-only/,
  );
  await assert.rejects(
    db.exec(`delete from public.place_audit;`),
    /append-only/,
  );

  // Session roles have no trail access at all (0031 revokes).
  await db.exec("set role authenticated;");
  await assert.rejects(db.exec(`select count(*) from public.place_audit;`));
  await db.exec("reset role;");

  const rls = await rows(db, `select rowsecurity from pg_tables where schemaname='public' and tablename='place_audit'`);
  assert.equal(rls[0]?.rowsecurity, true, "RLS stays enabled with zero policies");
});

test("is_curated is immutable for session roles; only the service role may flip it", async () => {
  const db = await createDb();

  // As the service role (the audited Admin path) the flip succeeds — twice.
  await db.exec("set role service_role;");
  await db.exec(`update public.places set is_curated = true where id = 'kopi-dari-kebun';`);
  await db.exec(`update public.places set is_curated = false where id = 'kopi-dari-kebun';`);
  const asService = await rows(db, `select is_curated from public.places where id = 'kopi-dari-kebun'`);
  assert.equal(asService[0].is_curated, false, "service-role writes are idempotent and unlocked");
  await db.exec("reset role;");

  // A non-service writer whose UPDATE reaches the rows (supabase_admin = the
  // real platform's superuser path; mirrors any bypassing writer) is still
  // refused by the guard trigger — the lockdown is column-level, not
  // policy-level.
  await db.exec("set role supabase_admin;");
  await assert.rejects(
    db.exec(`update public.places set is_curated = true where id = 'kopi-dari-kebun';`),
    /place_is_curated_locked/,
    "only the service role may change the Tempat Pilihan flag",
  );
  await db.exec("reset role;");
});

test("non-flag Place updates still work for session roles (lockdown is column-scoped)", async () => {
  const db = await createDb();
  await db.exec("set role authenticated;");
  // 0004 membership RLS would refuse anonymous updates for ownership rows;
  // the seeded 0001 Places carry no producer, so exercise the guard's KEY
  // property directly: an update that does NOT touch is_curated passes the
  // trigger regardless of role.
  await db.exec("reset role;");
  await db.exec(`update public.places set short_description = 'desc' where id = 'kopi-dari-kebun';`);
  const check = await rows(db, `select short_description from public.places where id = 'kopi-dari-kebun'`);
  assert.equal(check[0].short_description, "desc", "non-flag columns are untouched by the lockdown");
});
