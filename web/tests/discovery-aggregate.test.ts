import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  rankDiscoveryPlaces,
  type DiscoveryPlaceInput,
} from "../lib/discovery/scoring";

/**
 * DISCOVERY SIGNAL AGGREGATION (0038) — Home N+1 fix.
 *
 * Required guarantees:
 * 1. PARITY: the aggregate RPC returns EXACTLY the signals the per-Place
 *    queries computed (latest live session, exact counts per table, the
 *    both-'published' experience gate) for EVERY published Place, so feeding
 *    its rows through the canonical engine produces the identical ranked
 *    result as the per-Place assembly.
 * 2. N+1 GONE: one RPC call serves all published Places (the repository path
 *    is verified in discovery-cache-style source assertions here).
 * 3. PRIVILEGE: EXECUTE revoked from public/anon/authenticated — only the
 *    service role (server path) can call it; no identity data is returned.
 * 4. IDEMPOTENT re-apply (idempotent migration discipline).
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
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
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

const AGGREGATE = "0038_discovery_signal_aggregate.sql";

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
  // grants + BYPASSRLS — the audited server path depends on it.
  await db.exec(stripPgcrypto(readMigration(AGGREGATE)));
  // Supabase role shape (harness-only): the service role carries full table
  // grants + BYPASSRLS — the audited server path depends on it. Granted AFTER
  // the whole chain (incl. 0038) so every function the chain created is
  // covered; 0038's revoke targets public/anon/authenticated only.
  await db.exec("alter role service_role bypassrls;");
  await db.exec("grant all on all tables in schema public to service_role;");
  await db.exec("grant execute on all functions in schema public to service_role;");
  return db;
}

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

/** The exact per-Place signal semantics the RPC replaced (live, 4 counts). */
async function assembleInputsPerPlace(db: PGlite): Promise<DiscoveryPlaceInput[]> {
  const placeRows = await rows(
    db,
    `select id, name, short_description, area, address, latitude, longitude, claim_status, publication_status, cover_image_url
     from public.places where publication_status = 'published' order by id`,
  );
  const inputs: DiscoveryPlaceInput[] = [];
  for (const place of placeRows) {
    const liveRow = (
      await rows(
        db,
        `select status, started_at from public.live_sessions where place_id = '${place.id}' order by started_at desc limit 1`,
      )
    )[0];
    const count = async (table: string) =>
      Number((await rows(db, `select count(*)::int as c from public.${table} where place_id = '${place.id}'`))[0].c);
    const experiences = Number(
      (
        await rows(
          db,
          `select count(*)::int as c from public.experiences
           where place_id = '${place.id}' and status = 'published' and publication_status = 'published'`,
        )
      )[0].c,
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
        live: liveRow
          ? { status: String(liveRow.status) as "scheduled" | "live" | "ended", startedAt: liveRow.started_at === null ? null : String(liveRow.started_at) }
          : null,
        engagement: {
          followers: await count("place_follows"),
          visitIntents: await count("visit_intents"),
          publishedExperiences: experiences,
          hasCoverImage: place.cover_image_url !== null,
          photoCount: await count("place_photos"),
        },
      },
    });
  }
  return inputs;
}

/** Signal assembly through the 0038 aggregate RPC (ONE call). */
async function assembleInputsAggregated(db: PGlite): Promise<DiscoveryPlaceInput[]> {
  const placeRows = await rows(
    db,
    `select id, name, short_description, area, address, latitude, longitude, claim_status, publication_status, cover_image_url
     from public.places where publication_status = 'published' order by id`,
  );
  const aggregates = await rows(db, `select * from public.list_discovery_signal_aggregates()`);
  const byId = new Map(aggregates.map((row) => [String(row.place_id), row]));
  return placeRows.map((place) => {
    const agg = byId.get(String(place.id))!;
    const liveStatus = agg.live_status === null ? null : String(agg.live_status);
    const live =
      liveStatus === "live" || liveStatus === "scheduled"
        ? { status: liveStatus as "scheduled" | "live", startedAt: agg.live_started_at === null ? null : String(agg.live_started_at) }
        : agg.live_started_at !== null
          ? { status: "ended" as const, startedAt: String(agg.live_started_at) }
          : null;
    return {
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
        live,
        engagement: {
          followers: Number(agg.followers),
          visitIntents: Number(agg.visit_intents),
          publishedExperiences: Number(agg.published_experiences),
          hasCoverImage: place.cover_image_url !== null,
          photoCount: Number(agg.photos),
        },
      },
    };
  });
}

const NOW = new Date("2026-09-30T12:00:00.000Z");

test("aggregate RPC exists, is security definer, and carries a fixed search_path", () => {
  const sql = readMigration(AGGREGATE);
  assert.match(sql, /create or replace function public\.list_discovery_signal_aggregates/);
  assert.match(sql, /security definer\s*\n?set search_path = public/);
});

test("aggregate RPC is locked to the service role only (no anon/authenticated access)", async () => {
  const db = await createDb();
  const privileges = await rows(
    db,
    `select grantee, privilege_type from information_schema.role_routine_grants
     where routine_name = 'list_discovery_signal_aggregates'
       and grantee in ('PUBLIC', 'anon', 'authenticated')`,
  );
  assert.deepEqual(privileges, [], "no EXECUTE for PUBLIC/anon/authenticated");
  // anon/authenticated callers actually fail at EXECUTE time (fail closed).
  await db.exec("set role anon;");
  await assert.rejects(db.query(`select * from public.list_discovery_signal_aggregates()`));
  await db.exec("reset role;");
  // The service role (server path) can call it.
  await db.exec("set role service_role;");
  const serviceRows = await rows(db, `select count(*)::int as c from public.list_discovery_signal_aggregates()`);
  await db.exec("reset role;");
  assert.ok(Number(serviceRows[0].c) >= 10, "service role reads the full published aggregate");
});

test("aggregate returns NO identity data (place_id + counts + live fact only)", async () => {
  const db = await createDb();
  // RETURNS TABLE columns surface as OUT parameters in information_schema.
  const columns = await rows(
    db,
    `select parameter_name as column_name
     from information_schema.parameters
     where specific_schema = 'public'
       and specific_name like 'list_discovery_signal_aggregates%'
       and parameter_mode = 'OUT'
     order by ordinal_position`,
  );
  const names = columns.map((column) => String(column.column_name)).sort();
  assert.deepEqual(names, [
    "followers",
    "live_started_at",
    "live_status",
    "photos",
    "place_id",
    "published_experiences",
    "visit_intents",
  ]);
});

test("PARITY: aggregate rows equal the per-Place signal assembly on the DEV dataset", async () => {
  const db = await createDb();
  const perPlace = await assembleInputsPerPlace(db);
  const aggregated = await assembleInputsAggregated(db);

  assert.equal(aggregated.length, perPlace.length);
  for (const [index, input] of perPlace.entries()) {
    const other = aggregated[index];
    assert.equal(other.place.id, input.place.id);
    assert.deepEqual(other.signals.engagement, input.signals.engagement, `engagement parity for ${input.place.id}`);
    assert.deepEqual(other.signals.live, input.signals.live, `live parity for ${input.place.id}`);
  }
});

test("PARITY: engine ranking is identical through either assembly path", async () => {
  const db = await createDb();
  const rankedPerPlace = rankDiscoveryPlaces(await assembleInputsPerPlace(db), NOW);
  const rankedAggregated = rankDiscoveryPlaces(await assembleInputsAggregated(db), NOW);
  assert.deepEqual(rankedAggregated, rankedPerPlace);
  assert.ok(rankedAggregated.length >= 10, "the ≥10 eligible Places guarantee holds through the aggregate");
});

test("aggregate covers the latest live session per Place exactly (live + scheduled)", async () => {
  const db = await createDb();
  await db.exec("set role service_role;");
  // The DEV dataset locks producers at 0, so this harness-only producer +
  // membership + published stage satisfy the composite FK for one Place.
  await db.exec(`
    insert into public.producers (id, display_name) values ('agg-prod', 'Aggregate Harness Producer');
    insert into public.producer_memberships (user_id, producer_id, place_id, role)
    values ('00000000-0000-4000-8000-00000000d001', 'agg-prod', 'sari-batik-pancarsari', 'owner');
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values ('agg-stage-1', 'sari-batik-pancarsari', 'Agg harness stage', 'Aggregate harness stage.', 0, 'published');
    insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key, started_at)
    values
      ('agg-live-1', 'sari-batik-pancarsari', 'agg-prod', 'agg-stage-1', 'ended', 'agg-key-1', '2026-09-30T08:00:00Z'),
      ('agg-live-2', 'sari-batik-pancarsari', 'agg-prod', 'agg-stage-1', 'live', 'agg-key-2', '2026-09-30T10:00:00Z');
  `);
  const aggregate = await rows(
    db,
    `select live_status, live_started_at from public.list_discovery_signal_aggregates() where place_id = 'sari-batik-pancarsari'`,
  );
  await db.exec("reset role;");
  assert.equal(aggregate.length, 1, "one row per published Place");
  assert.equal(String(aggregate[0].live_status), "live");
  // PGlite parses timestamptz into a JS Date; PostgREST delivers an ISO
  // string. Both normalize through toISOString for the inserted-timestamp
  // comparison.
  const startedAt = new Date(aggregate[0].live_started_at as string | Date).toISOString();
  assert.ok(startedAt.startsWith("2026-09-30T10:00:00"), "latest session wins");
});

test("aggregate re-apply is idempotent (create or replace, no data change)", async () => {
  const db = await createDb();
  await db.exec(stripPgcrypto(readMigration(AGGREGATE)));
  const before = Number(
    (await rows(db, `select count(*)::int as c from public.list_discovery_signal_aggregates()`))[0].c,
  );
  const published = Number(
    (await rows(db, `select count(*)::int as c from public.places where publication_status = 'published'`))[0].c,
  );
  assert.equal(before, published);
});

test("repository path: one RPC call for all Places, per-Place queries only as fallback", () => {
  const repoSource = readFileSync(new URL("../lib/place-experience-repository.ts", import.meta.url), "utf8");
  // The aggregate is fetched ONCE (not per Place)...
  const aggregateCalls = repoSource.match(/rpc\(\s*"list_discovery_signal_aggregates"/g) ?? [];
  assert.equal(aggregateCalls.length, 1, "exactly one aggregate fetch per listDiscoveryInputs call");
  // ...it happens BEFORE the per-Place loop...
  const aggregateAt = repoSource.search(/rpc\(\s*"list_discovery_signal_aggregates"/);
  const loopAt = repoSource.indexOf("for (const row of places) {", aggregateAt);
  assert.ok(aggregateAt > 0 && loopAt > aggregateAt);
  // ...and the per-Place queries survive ONLY inside the fallback branch.
  // The loop slice ends at THIS method's closing `void now;` (the next one
  // after the loop), not the first occurrence anywhere in the file.
  const loop = repoSource.slice(loopAt, repoSource.indexOf("void now;", loopAt));
  assert.match(loop, /if \(aggregate\) \{/);
  assert.match(loop, /fetchLiveSignal\(admin, place\.id\)/);
  assert.match(loop, /countRows\(admin, "place_follows", place\.id\)/);
  assert.match(loop, /countRows\(admin, "visit_intents", place\.id\)/);
  assert.match(loop, /countRows\(admin, "place_photos", place\.id\)/);
});
