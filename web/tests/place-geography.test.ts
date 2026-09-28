import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  isValidPlaceCountry,
  isValidPlaceRegion,
  PLACE_COUNTRIES,
  placeCountryName,
  placeRegionsFor,
} from "../lib/geo/countries";
import { parsePlaceMutation, PlaceInputError } from "../lib/place-management";

/**
 * PLACE GEOGRAPHY — canonical country + province/state on Place
 * (PO, 2026-09-28, migration 0032).
 *
 * The dataset rules are asserted against the real dataset module (it IS the
 * vocabulary the application validates and renders against, so a test that
 * re-implements it would prove nothing). The database rules — the two columns,
 * the `(country_code, region_name)` index, and the backfill — run on a real
 * Postgres engine (PGlite) over the actual migration chain. The UI and filter
 * rules are locked at the source level, matching the existing test style.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const readMigration = (name: string) => read(`../supabase/migrations/${name}`);

const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

const geoModule = read("../lib/geo/countries.ts");
const geoFields = read("../components/place-geo-fields.tsx");
const geoFilter = read("../app/admin/places/PlaceGeoFilter.tsx");
const adminPlacesPage = read("../app/admin/places/page.tsx");
const adminEditor = read("../components/admin/place-editor.tsx");
const producerForm = read("../app/producer/places/PlaceForm.tsx");
const repository = read("../lib/place-experience-repository.ts");
const adminQueries = read("../lib/admin/queries.ts");

const validInput = {
  name: "Tempat Geografi",
  shortDescription: "Cerita lokal",
  category: "Sumber Daya Alam",
  type: "production",
  area: "Bandung",
  countryCode: "ID",
  regionName: "Jawa Barat",
  address: "Jalan Lokal 1",
  contactInformation: "",
  timezone: "Asia/Jakarta",
  currency: "IDR",
  latitude: -6.9,
  longitude: 107.6,
};

// ---------------------------------------------------------------------------
// The dataset: a country list, and subdivisions that belong to their country
// ---------------------------------------------------------------------------

test("Country offers the whole world, each with a code and a name", () => {
  // "Seluruh dunia" — a real country list, not a hand-kept subset.
  assert.ok(PLACE_COUNTRIES.length > 200, `expected a world country list, got ${PLACE_COUNTRIES.length}`);
  assert.ok(PLACE_COUNTRIES.every((country) => /^[A-Z]{2}$/.test(country.code)));
  assert.ok(PLACE_COUNTRIES.every((country) => country.name.trim().length > 0));
  // Alphabetical, so a long dropdown is usable on a phone.
  const names = PLACE_COUNTRIES.map((country) => country.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "en")));
  assert.equal(placeCountryName("id"), "Indonesia");
  assert.equal(placeCountryName("ZZ"), null);
});

test("Region lists only the subdivisions of the chosen country", () => {
  const indonesia = placeRegionsFor("ID");
  const saudi = placeRegionsFor("SA");
  assert.ok(indonesia.includes("Jawa Barat"), "Indonesia must offer Jawa Barat");
  assert.ok(saudi.includes("Ash Sharqiyah"), "Saudi Arabia must offer Ash Sharqiyah");
  // No country leaks another country's subdivisions.
  assert.equal(indonesia.includes("Ash Sharqiyah"), false);
  assert.equal(saudi.includes("Jawa Barat"), false);
  // Lower-case input from a form or an API still resolves.
  assert.deepEqual(placeRegionsFor("id"), indonesia);
  // No country chosen means no subdivisions to choose from.
  assert.deepEqual(placeRegionsFor(""), []);
  assert.deepEqual(placeRegionsFor("ZZ"), []);
});

test("server-side validation rejects a country or region outside the dataset", () => {
  assert.equal(isValidPlaceCountry("ID"), true);
  assert.equal(isValidPlaceCountry("ZZ"), false);
  assert.equal(isValidPlaceCountry(""), false);
  assert.equal(isValidPlaceCountry(null), false);

  assert.equal(isValidPlaceRegion("ID", "Jawa Barat"), true);
  assert.equal(isValidPlaceRegion("ID", "Ash Sharqiyah"), false);
  assert.equal(isValidPlaceRegion("SA", "Jawa Barat"), false);
  assert.equal(isValidPlaceRegion("ID", ""), false);
  assert.equal(isValidPlaceRegion("ID", 42), false);
});

// ---------------------------------------------------------------------------
// The Place parser carries and validates the pair
// ---------------------------------------------------------------------------

test("Place create and update carry country_code + region_name, validated on the server", () => {
  const mutation = parsePlaceMutation(validInput);
  assert.equal(mutation.countryCode, "ID");
  assert.equal(mutation.regionName, "Jawa Barat");
  // The country code is normalized, so "id" and "ID" are the same Place.
  assert.equal(parsePlaceMutation({ ...validInput, countryCode: "id" }).countryCode, "ID");

  // Missing values are refused.
  assert.throws(() => parsePlaceMutation({ ...validInput, countryCode: "" }), PlaceInputError);
  assert.throws(() => parsePlaceMutation({ ...validInput, regionName: "" }), PlaceInputError);
  // An invented country is refused.
  assert.throws(() => parsePlaceMutation({ ...validInput, countryCode: "ZZ" }), /place_country_invalid/);
  // A real subdivision paired with the wrong country is refused — this is the
  // rule a dropdown cannot enforce and the server must.
  assert.throws(() => parsePlaceMutation({ ...validInput, regionName: "Ash Sharqiyah" }), /place_region_invalid/);
  // Validation is not a UI concern: it lives in the ONE shared parser, so the
  // Admin route and the Producer route both inherit it.
  const parser = stripComments(read("../lib/place-management.ts"));
  assert.match(parser, /isValidPlaceCountry\(countryCode\)/);
  assert.match(parser, /isValidPlaceRegion\(countryCode, regionName\)/);
});

test("the canonical Place write path persists country_code and region_name", () => {
  const code = stripComments(repository);
  // Read-back (mapPlace) and both writes (create, update) carry the pair, so a
  // value chosen in either form is actually stored and read back.
  assert.match(code, /countryCode: \(row\.country_code/);
  assert.match(code, /regionName: \(row\.region_name/);
  assert.ok(
    (code.match(/country_code: input\.countryCode, region_name: input\.regionName/g) ?? []).length >= 2,
    "both create and update must write country_code + region_name",
  );
});

test("Area is kept: the local-area field is not replaced by the geography fields", () => {
  // The instruction is explicit that Area stays the local area, so it is still
  // parsed, still required, and still separate from country / region.
  const mutation = parsePlaceMutation({ ...validInput, area: "Lembang" });
  assert.equal(mutation.area, "Lembang");
  assert.equal(mutation.regionName, "Jawa Barat");
  assert.throws(() => parsePlaceMutation({ ...validInput, area: "" }), /place_required_field_invalid/);
  assert.match(adminEditor, /"area", "Area"/);
  assert.match(producerForm, /\["area", "Area"\]/);
});

// ---------------------------------------------------------------------------
// The Admin Country → Region filter
// ---------------------------------------------------------------------------

test("Admin filters the Place list by Country, then narrows by Region", () => {
  // The filter is applied in the database, not by filtering a fetched page.
  const code = stripComments(adminQueries);
  assert.match(code, /countryCode\?\.trim\(\)\.toUpperCase\(\)/);
  assert.match(code, /\.eq\("country_code", countryCode\)/);
  assert.match(code, /\.eq\("region_name", regionName\)/);
  // A region is only ever applied together with its country, so a region can
  // never filter across countries.
  assert.match(code, /if \(countryCode && regionName\)/);

  // The list reads the filter from the URL and passes it through.
  assert.match(adminPlacesPage, /searchParams/);
  assert.match(adminPlacesPage, /listAdminPlaces\(\{ countryCode: country \?\? null, regionName: region \?\? null \}\)/);
  assert.match(adminPlacesPage, /PlaceGeoFilter/);

  // The filter is Country-dependent: changing the country clears the region
  // and the region list is rebuilt from the chosen country.
  const filter = stripComments(geoFilter);
  assert.match(filter, /placeRegionsFor\(countryCode\)/);
  assert.match(filter, /apply\(\{ country: event\.target\.value, region: "" \}\)/);
  assert.match(geoFilter, /aria-label="Filter geografis"/);
});

test("both Place forms use the same dependent Negara / Provinsi selectors", () => {
  for (const source of [adminEditor, producerForm]) {
    assert.match(source, /<PlaceGeoFields/);
    assert.match(source, /countryCode/);
    assert.match(source, /regionName/);
  }
  // The labels are neutral — the same subdivision is a province in one
  // country and a wilayah in another.
  assert.match(geoFields, /Negara/);
  assert.match(geoFields, /Provinsi \/ Wilayah/);
  assert.doesNotMatch(geoFields, /Negara \[/);
  // The selects are a convenience; the server re-validates the same pair.
  const dataset = stripComments(geoModule);
  assert.match(dataset, /PLACE_COUNTRIES/);
  assert.match(dataset, /isValidPlaceCountry/);
  assert.match(dataset, /isValidPlaceRegion/);
});

// ---------------------------------------------------------------------------
// Migration 0032 — proven on a real Postgres engine
// ---------------------------------------------------------------------------

async function withPlacesDb(run: (db: PGlite) => Promise<void>): Promise<void> {
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
  const stripPgcrypto = (sql: string) => sql.replace(/create extension if not exists pgcrypto;?/gim, "");
  const FOUNDATION = [
    "0001_visit_intent_foundation.sql",
    "0002_harden_visit_intent_rls.sql",
    "0003_persistence_integrity.sql",
    "0004_place_management.sql",
    "0005_experience_management.sql",
    "0020_one_membership_per_user.sql",
    "0022_allow_multiple_places_per_producer.sql",
    "0028_place_claims.sql",
    "0031_place_audit.sql",
    "0032_place_geography.sql",
  ];

  const db = new PGlite();
  try {
    await db.exec(SHIMS);
    await db.exec("create publication supabase_realtime;");
    for (const name of FOUNDATION) await db.exec(stripPgcrypto(readMigration(name)));
    await run(db);
  } finally {
    await db.close();
  }
}

test("migration 0032 adds the two columns, the pair index, and the backfill", async () => {
  const sql = readMigration("0032_place_geography.sql");
  assert.match(sql, /add column if not exists country_code text/);
  assert.match(sql, /add column if not exists region_name text/);
  assert.match(sql, /create index if not exists places_country_region_idx/);
  // Additive and idempotent; it never touches Area, timezone, currency, or
  // address, and never deletes a Place.
  const reapply = stripComments(sql);
  assert.doesNotMatch(reapply, /drop\s+table/i);
  assert.doesNotMatch(reapply, /delete\s+from/i);
  assert.doesNotMatch(reapply, /alter column\s+(area|timezone|currency|address)/i);

  await withPlacesDb(async (db) => {
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'places'",
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.ok(names.includes("country_code"), "country_code must exist");
    assert.ok(names.includes("region_name"), "region_name must exist");
    assert.ok(names.includes("area"), "area must survive untouched");
    assert.ok(names.includes("timezone") && names.includes("currency") && names.includes("address"));

    const index = await db.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'places' and indexname = 'places_country_region_idx'",
    );
    assert.equal(index.rows.length, 1);
    assert.match(index.rows[0].indexdef, /\(country_code, region_name\)/);
  });
});

test("the backfill assigns the four existing Places their country and province", () => {
  const sql = stripComments(readMigration("0032_place_geography.sql"));
  // ISO 3166-1 alpha-2 code + ISO 3166-2 subdivision name, as decided: the
  // dataset spells them, and the server validates against that same dataset.
  assert.match(sql, /country_code = 'SA', region_name = 'Ash Sharqiyah'/);
  assert.match(sql, /name in \('Bakso Migran', 'Kopi dari Kebun'\)/);
  assert.match(sql, /country_code = 'ID', region_name = 'Jawa Barat'/);
  assert.match(sql, /name in \('Dapur Rasa', 'Rumah Teh Lokal'\)/);
  // The backfill never overwrites a value an Admin already corrected.
  assert.match(sql, /country_code is null or country_code = ''/);

  // Every backfilled value is one the validator actually accepts.
  for (const [country, region] of [
    ["SA", "Ash Sharqiyah"],
    ["ID", "Jawa Barat"],
  ] as const) {
    assert.equal(isValidPlaceRegion(country, region), true, `${country}/${region} must validate`);
  }
});
