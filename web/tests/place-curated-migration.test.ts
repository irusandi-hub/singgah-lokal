import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0035 — `places.is_curated` (Tempat Pilihan flag) regression.
 *
 * Applied on a real Postgres engine over its dependency chain (0001 creates
 * `public.places`). Locked properties:
 * - additive column: boolean NOT NULL DEFAULT false, with its partial index;
 * - every existing/seeded Place starts NOT curated (no fake curation);
 * - the server can flip the flag per Place (idempotent repeated writes);
 * - Discovery stays curated-blind: no trigger/policy couples the flag to
 *   any other table.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

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
  await db.exec(stripPgcrypto(readMigration("0001_visit_intent_foundation.sql")));
  await db.exec(stripPgcrypto(readMigration("0035_place_curated_flag.sql")));
  return db;
}

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

test("0035 applies cleanly and adds the locked is_curated shape", async () => {
  const db = await createDb();

  const columns = await rows(
    db,
    `select column_name, data_type, is_nullable, column_default from information_schema.columns
     where table_schema='public' and table_name='places' and column_name='is_curated'`,
  );
  assert.equal(columns.length, 1, "exactly one is_curated column");
  assert.equal(columns[0].data_type, "boolean");
  assert.equal(columns[0].is_nullable, "NO", "NOT NULL — the layer membership is always known");
  assert.match(String(columns[0].column_default), /false/, "defaults to NOT curated");

  const index = await rows(
    db,
    `select indexname from pg_indexes where schemaname='public' and tablename='places' and indexname='places_is_curated_idx'`,
  );
  assert.equal(index.length, 1, "the partial flag index exists");
});

test("every existing Place starts NOT curated; the flag flips per Place idempotently", async () => {
  const db = await createDb();

  const seeded = await rows(db, `select id, is_curated from public.places order by id`);
  assert.ok(seeded.length > 0, "the 0001 seed Places exist");
  assert.ok(seeded.every((row) => row.is_curated === false), "no fake curation on existing rows");

  const placeId = String(seeded[0].id);
  await db.exec(`update public.places set is_curated = true where id = '${placeId}';`);
  await db.exec(`update public.places set is_curated = true where id = '${placeId}';`);
  const after = await rows(db, `select id, is_curated from public.places where id = '${placeId}'`);
  assert.equal(after[0].is_curated, true, "repeated writes stay idempotent");

  const others = await rows(db, `select count(*)::int as n from public.places where is_curated = false`);
  assert.ok(Number(others[0].n) >= seeded.length - 1, "other Places stay untouched");
});

test("Discovery stays curated-blind: no trigger couples is_curated to any other table", async () => {
  const db = await createDb();
  const triggers = await rows(
    db,
    `select trigger_name from information_schema.triggers where event_object_table = 'places' and trigger_name like '%curat%'`,
  );
  assert.equal(triggers.length, 0, "no curated trigger exists on places");
});
