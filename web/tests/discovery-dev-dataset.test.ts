import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  evaluateDiscoveryEligibility,
  rankDiscoveryPlaces,
  type DiscoveryPlaceInput,
} from "../lib/discovery/scoring";

/**
 * STAGE 5 — the DEV demo dataset produces ≥10 eligible Discovery Places.
 *
 * This regression runs the REAL migration chain on a real Postgres (PGlite),
 * applies the demo seed (0037), then feeds the canonical signal assembly of
 * the resulting rows through the REAL engine (evaluate + rank — scores and
 * stars come from the engine, never from this test).
 *
 * Required guarantees:
 * - ≥10 eligible Discovery Places from the DEV dataset;
 * - deterministic ranking (repeated calls are identical);
 * - no unpublished Place enters the ranked Discovery set;
 * - no duplicate Place in the ranked set;
 * - overlap stays valid: a curated Place remains both curated and ranked.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const CHAIN = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0018_place_cover_image.sql",
  "0020_one_membership_per_user.sql",
  "0021_place_photos.sql",
  "0022_allow_multiple_places_per_producer.sql",
  "0023_place_follows.sql",
  "0031_place_audit.sql",
  "0032_place_geography.sql",
  "0033_place_category_currency.sql",
  "0035_place_curated_flag.sql",
  "0036_place_curated_admin.sql",
  "0037_dev_demo_discovery_dataset.sql",
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
  await db.exec("create publication supabase_realtime;");
  for (const name of CHAIN) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  // Supabase role shape (harness-only): the service role carries full table
  // grants + BYPASSRLS — the audited server path depends on it. Granted AFTER
  // the chain so every table the migrations created is covered.
  await db.exec("alter role service_role bypassrls;");
  await db.exec("grant all on all tables in schema public to service_role;");
  return db;
}

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

/** Canonical signal assembly mirroring the repository (counts only, no scoring). */
async function assembleInputs(db: PGlite): Promise<DiscoveryPlaceInput[]> {
  const placeRows = await rows(
    db,
    `select id, name, short_description, area, address, latitude, longitude, claim_status, publication_status, is_curated, cover_image_url
     from public.places where publication_status = 'published' order by id`,
  );
  const inputs: DiscoveryPlaceInput[] = [];
  for (const place of placeRows) {
    const followers = Number(
      (await rows(db, `select count(*)::int as c from public.place_follows where place_id = '${place.id}'`))[0].c,
    );
    const intents = Number(
      (await rows(db, `select count(*)::int as c from public.visit_intents where place_id = '${place.id}'`))[0].c,
    );
    const experiences = Number(
      (
        await rows(
          db,
          `select count(*)::int as c from public.experiences
           where place_id = '${place.id}' and status = 'published' and publication_status = 'published'`,
        )
      )[0].c,
    );
    const photos = Number(
      (await rows(db, `select count(*)::int as c from public.place_photos where place_id = '${place.id}'`))[0].c,
    );
    inputs.push({
      place: {
        id: String(place.id),
        name: String(place.name),
        shortDescription: String(place.short_description),
        area: String(place.area),
        address: String(place.address ?? ""),
        latitude: place.latitude === null ? null : Number(place.latitude),
        longitude: place.longitude === null ? null : Number(place.longitude),
        claimStatus: String(place.claim_status) as DiscoveryPlaceInput["place"]["claimStatus"],
        publicationStatus: String(place.publication_status) as DiscoveryPlaceInput["place"]["publicationStatus"],
      },
      signals: {
        live: null,
        engagement: {
          followers,
          visitIntents: intents,
          publishedExperiences: experiences,
          hasCoverImage: place.cover_image_url !== null,
          photoCount: photos,
        },
      },
    });
  }
  return inputs;
}

const NOW = new Date("2026-09-29T12:00:00.000Z");

test("the DEV dataset yields at least 10 eligible Discovery Places (ranked by the real engine)", async () => {
  const db = await createDb();
  const inputs = await assembleInputs(db);
  const ranked = rankDiscoveryPlaces(inputs, NOW);

  assert.ok(
    ranked.length >= 10,
    `expected ≥10 eligible ranked Places from the DEV dataset, got ${ranked.length}`,
  );
  // Stars come from the engine and stay inside the four-tier model.
  for (const entry of ranked) {
    assert.ok(entry.stars >= 1 && entry.stars <= 4);
    assert.ok(entry.rank >= 1 && entry.rank <= ranked.length);
  }
  // Ids are recorded HERE (report/test only) — never in engine logic.
  const topTen = ranked.slice(0, 10).map((entry) => entry.placeId);
  assert.equal(new Set(topTen).size, 10);
});

test("ranking is deterministic over the DEV dataset (repeated runs identical)", async () => {
  const db = await createDb();
  const inputs = await assembleInputs(db);
  const first = rankDiscoveryPlaces(inputs, NOW);
  const second = rankDiscoveryPlaces(inputs, new Date("2026-09-29T12:00:00.000Z"));
  assert.deepEqual(first, second);
});

test("no unpublished Place enters the ranked Discovery set", async () => {
  const db = await createDb();

  // Guard for the guarantee: an unpublished demo Place exists and is NOT ranked.
  await db.exec("set role service_role;");
  await db.exec(`update public.places set is_curated = false where id = 'sari-jagung-sejahtera';`);
  await db.exec(`update public.places set publication_status = 'paused' where id = 'sari-jagung-sejahtera';`);
  await db.exec("reset role;");

  const inputs = await assembleInputs(db);
  const ranked = rankDiscoveryPlaces(inputs, NOW);
  assert.ok(ranked.length >= 10, "the guarantee holds even with one Place unpublished");
  assert.equal(
    ranked.some((entry) => entry.placeId === "sari-jagung-sejahtera"),
    false,
    "the paused Place never enters the ranked set",
  );
  // The dataset still contains published rows only in the ranked output.
  const publishedIds = new Set(
    (await rows(db, `select id from public.places where publication_status = 'published'`)).map((row) => String(row.id)),
  );
  for (const entry of ranked) {
    assert.ok(publishedIds.has(entry.placeId), `ranked Place ${entry.placeId} must be published`);
  }
});

test("no duplicate Place appears in the ranked set (idempotent seed re-run)", async () => {
  const db = await createDb();
  // Re-apply the whole seed migration: idempotency means no duplicate rows.
  await db.exec(stripPgcrypto(readMigration("0037_dev_demo_discovery_dataset.sql")));
  const placeCount = Number(
    (await rows(db, `select count(*)::int as c from public.places where id like 'sari-%'`))[0].c,
  );
  assert.equal(placeCount, 10, "the demo seed is idempotent — exactly the 10 demo Places");

  const inputs = await assembleInputs(db);
  const ranked = rankDiscoveryPlaces(inputs, NOW);
  const ids = ranked.map((entry) => entry.placeId);
  assert.equal(new Set(ids).size, ids.length, "no duplicate Place in the ranked set");
  assert.ok(ranked.length >= 10);
});

test("overlap stays valid: a curated Place remains curated AND Discovery-ranked", async () => {
  const db = await createDb();
  // Promote one demo Place (service role — the only permitted writer).
  await db.exec("set role service_role;");
  await db.exec(`update public.places set is_curated = true where id = 'sari-batik-pancarsari';`);
  await db.exec("reset role;");

  const curated = await rows(db, `select id from public.places where is_curated = true and publication_status = 'published'`);
  assert.equal(curated.length, 1);
  const curatedId = String(curated[0].id);

  const inputs = await assembleInputs(db);
  const ranked = rankDiscoveryPlaces(inputs, NOW);
  // The curated Place is ALSO ranked by the engine — both layers, no dedupe.
  assert.ok(ranked.some((entry) => entry.placeId === curatedId), "the curated Place stays Discovery-ranked");
  // And the eligibility evaluation agrees through the engine itself.
  const input = inputs.find((candidate) => candidate.place.id === curatedId);
  assert.ok(input);
  assert.equal(evaluateDiscoveryEligibility(input!.place), true);
});
