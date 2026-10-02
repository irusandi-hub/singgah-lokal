import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  DEVELOPER_PLACE_OPERATIONS,
  DEVELOPER_PLACE_REFUSALS,
  decideDeveloperPlaceMutation,
  developerAuditAction,
  developerFlagColumn,
  developerFlagPatch,
  developerRevertPatch,
  isPermittedOperation,
  isValidDeveloperReason,
  MAX_DEVELOPER_REASON_LENGTH,
  normalizeDeveloperReason,
  RIYADH_DUMMY_PLACE_IDS,
} from "../lib/developer/dummy-places-core";
import { clearCitySearch, narrowToViewport, resolveActiveCenter } from "../lib/live/ui";
import { isValidPlaceRegion, placeRegionsFor } from "../lib/geo/countries";

/**
 * DUMMY PLACE + DEVELOPER AUTHORITY (migrations 0039 / 0040).
 *
 * Master: MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0.
 *
 * The database half runs against a REAL Postgres engine over the migration
 * chain — semantics, not SQL reading. Each locked rule is stated as the attack
 * it prevents:
 *   - `is_dummy` is writable ONLY by the service-role Creator path; anon,
 *     authenticated, Producer and Platform Admin are all refused, so no client
 *     can promote a Place to Dummy through the generic UPDATE paths;
 *   - the guard is an allowlist of ONE role, not a denylist;
 *   - a non-Dummy Place is outside the Developer Authority's curation scope;
 *   - `place_audit` stays append-only and its vocabulary is extended, never
 *     replaced;
 *   - the Dummy flag is never inferred from free text.
 */

/** The constants live in a separate module so this test stays executable. */
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

const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0019_bakso_migran_demo_place.sql",
  "0020_one_membership_per_user.sql",
  "0021_place_photos.sql",
  "0022_allow_multiple_places_per_producer.sql",
  "0023_place_follows.sql",
  "0028_place_claims.sql",
  "0031_place_audit.sql",
  "0032_place_geography.sql",
  "0033_place_category_currency.sql",
  "0035_place_curated_flag.sql",
  "0036_place_curated_admin.sql",
  "0037_dev_demo_discovery_dataset.sql",
] as const;

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of FOUNDATION) await db.exec(stripPgcrypto(readMigration(name)));
  return db;
}

async function withDb(run: (db: PGlite) => Promise<void>): Promise<void> {
  const db = await bootstrapDb();
  try {
    await db.exec(stripPgcrypto(readMigration("0039_dummy_place_developer_authority.sql")));
    await db.exec(stripPgcrypto(readMigration("0040_dev_dummy_riyadh_dataset.sql")));
    await db.exec(stripPgcrypto(readMigration("0041_dev_dummy_riyadh_region.sql")));
    // supabase_admin is the platform's real superuser path (RLS-bypassing),
    // exactly as the 0036 migration test sets it up. Giving it BYPASSRLS and
    // full grants means it REACHES the guard trigger — without this a plain
    // `permission denied` from the 0004 membership RLS would mask the trigger
    // and the guard would never actually be exercised.
    await db.exec(`
      alter role service_role bypassrls;
      alter role supabase_admin bypassrls;
      grant all on all tables in schema public to supabase_admin, service_role;
    `);
    await run(db);
  } finally {
    await db.close();
  }
}

const rows = async (db: PGlite, query: string): Promise<Record<string, unknown>[]> =>
  ((await db.query(query)).rows ?? []) as Record<string, unknown>[];

const fails = async (db: PGlite, sql: string): Promise<string> => {
  try {
    await db.exec(sql);
  } catch (error) {
    return String((error as Error).message);
  }
  return "";
};

// ---------------------------------------------------------------------------
// A. The canonical flag
// ---------------------------------------------------------------------------

test("the flag defaults to false and only 0037's named demo ids are marked", async () => {
  await withDb(async (db) => {
    const all = await rows(db, "select id, is_dummy from public.places order by id");
    const dummy = all.filter((r) => r.is_dummy === true).map((r) => String(r.id));
    // Exactly the ten 0037 demo Places, named explicitly — never derived from
    // text — plus the ten 0040 Riyadh fixtures.
    assert.equal(dummy.filter((id) => id.startsWith("sari-")).length, 10);
    assert.equal(dummy.filter((id) => id.startsWith("dummy-riyadh-")).length, 10);
    // Every real Place stays false: the Indonesian seeds, the four 0001/0019
    // Places, and everything else in the chain.
    for (const row of all) {
      const id = String(row.id);
      if (id.startsWith("sari-") || id.startsWith("dummy-riyadh-")) continue;
      assert.equal(row.is_dummy, false, `${id} must not be marked Dummy`);
    }
  });
});

test("the Dummy flag is NEVER inferred from free text", async () => {
  await withDb(async (db) => {
    // A Place whose name/description literally says "Dummy" is still NOT a
    // Dummy Place until the Creator marks it. This is the rule that stops the
    // flag from being forgeable by anyone who can edit a description.
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, latitude, longitude, claim_status, publication_status)
      values ('looks-dummy', 'Dummybut pretending', 'Dummy Place test data only', 'Perdagangan & Jasa',
        'experience', 'Bandung', 'Alamat Dummy', '', 'Asia/Jakarta', 'IDR', -6.9, 107.6, 'unverified', 'published');
    `);
    const row = await rows(db, "select is_dummy from public.places where id = 'looks-dummy'");
    assert.equal(row[0]?.is_dummy, false, "text must never confer the Dummy flag");
  });
});

// ---------------------------------------------------------------------------
// B. SECURITY — the trusted path
// ---------------------------------------------------------------------------

test("a bypassing writer can NEVER change is_dummy — only the service role may", async () => {
  await withDb(async (db) => {
    // Seed a plain non-Dummy Place to try to promote.
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, latitude, longitude, claim_status, publication_status)
      values ('victim', 'Victim', 'd', 'Perdagangan & Jasa', 'experience', 'Bandung', 'Jl',
        '', 'Asia/Jakarta', 'IDR', -6.9, 107.6, 'unverified', 'published');
    `);

    // supabase_admin is the platform's superuser path — the strongest possible
    // NON-service writer, i.e. anything that could bypass RLS. It is still
    // refused, which is the property under test.
    await db.exec("set role supabase_admin;");
    await assert.rejects(
      db.exec(`update public.places set is_dummy = true where id = 'victim';`),
      /place_is_dummy_locked/,
      "no non-service writer may mark a Place Dummy",
    );
    await db.exec("reset role;");

    // Nothing landed.
    const row = await rows(db, "select is_dummy from public.places where id = 'victim'");
    assert.equal(row[0]?.is_dummy, false, "the refused write must not have landed");
  });
});

test("session roles cannot promote a Place to Dummy either", async () => {
  await withDb(async (db) => {
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, latitude, longitude, claim_status, publication_status)
      values ('anon-victim', 'Anon Victim', 'd', 'Perdagangan & Jasa', 'experience', 'Bandung', 'Jl',
        '', 'Asia/Jakarta', 'IDR', -6.9, 107.6, 'unverified', 'published');
    `);
    // anon/authenticated are stopped by the 0004 membership RLS before the
    // trigger is even reached. Either refusal is a refusal: a client cannot
    // promote a Place to Dummy by any route.
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role};`);
      await assert.rejects(
        db.exec(`update public.places set is_dummy = true where id = 'anon-victim';`),
        `${role} must not be able to mark a Place Dummy`,
      );
      await db.exec("reset role;");
    }
    const row = await rows(db, "select is_dummy from public.places where id = 'anon-victim'");
    assert.equal(row[0]?.is_dummy, false);
  });
});

test("the guard is a ONE-ROLE allowlist: service_role is the only writer", async () => {
  await withDb(async (db) => {
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, latitude, longitude, claim_status, publication_status)
      values ('promotable', 'Promotable', 'd', 'Perdagangan & Jasa', 'experience', 'Bandung', 'Jl',
        '', 'Asia/Jakarta', 'IDR', -6.9, 107.6, 'unverified', 'published');
    `);
    // The Creator path succeeds.
    await db.exec("set role service_role;");
    await db.exec(`update public.places set is_dummy = true where id = 'promotable';`);
    await db.exec(`update public.places set is_dummy = false where id = 'promotable';`);
    await db.exec("reset role;");
    const row = await rows(db, "select is_dummy from public.places where id = 'promotable'");
    assert.equal(row[0]?.is_dummy, false, "service-role writes are idempotent and unlocked");

    // An update that does NOT touch is_dummy passes the guard for any writer:
    // the lockdown is scoped to the flag, not to the Place.
    await db.exec(`update public.places set short_description = 'desc' where id = 'promotable';`);
    const check = await rows(db, "select short_description from public.places where id = 'promotable'");
    assert.equal(check[0]?.short_description, "desc", "non-flag columns are untouched by the lockdown");
  });
});

test("0036's is_curated lockdown and the append-only audit are NOT widened", async () => {
  await withDb(async (db) => {
    // is_curated still refuses a bypassing writer, exactly as before 0039.
    await db.exec("set role supabase_admin;");
    await assert.rejects(
      db.exec(`update public.places set is_curated = true where id = 'dummy-riyadh-olaya';`),
      /place_is_curated_locked/,
      "the curation lockdown must survive the Dummy migration untouched",
    );
    await db.exec("reset role;");

    // The append-only trigger needs a ROW to fire on.
    await db.exec(`
      insert into auth.users (id, email_confirmed_at) values ('00000000-0000-4000-8000-000000000090', now());
    `);
    await db.exec(`
      insert into public.place_audit (place_id, actor_id, action, detail)
      values ('dummy-riyadh-olaya', '00000000-0000-4000-8000-000000000090',
              'developer_place_curated', '{"reason":"r"}');
    `);
    await assert.rejects(
      db.exec("update public.place_audit set action = 'admin_place_curated'"),
      "place_audit must stay append-only against UPDATE",
    );
    await assert.rejects(
      db.exec("delete from public.place_audit"),
      "place_audit must stay append-only against DELETE",
    );
    const rowsLeft = await rows(db, "select action from public.place_audit");
    assert.equal(rowsLeft.length, 1, "the audit row survived both attempts");
  });
});

// ---------------------------------------------------------------------------
// C. AUDIT
// ---------------------------------------------------------------------------

test("the audit vocabulary is EXTENDED, never replaced", async () => {
  const sql = stripComments(readMigration("0039_dummy_place_developer_authority.sql"));
  // Every pre-existing key survives.
  for (const action of [
    "admin_place_created",
    "admin_place_updated",
    "admin_place_published",
    "admin_place_paused",
    "admin_place_archived",
    "admin_place_restored",
    "place_claim_approved",
    "place_claim_rejected",
    "admin_place_curated",
    "admin_place_uncurated",
  ]) {
    assert.match(sql, new RegExp(action), `${action} must remain a valid action`);
  }
  // The Developer keys are additive.
  for (const action of [
    "developer_place_dummy_marked",
    "developer_place_dummy_cleared",
    "developer_place_curated",
    "developer_place_uncurated",
  ]) {
    assert.match(sql, new RegExp(action), `${action} must be a valid action`);
  }
});

test("an audit row can be written with a Developer action and stays append-only", async () => {
  await withDb(async (db) => {
    await db.exec(`
      insert into auth.users (id, email_confirmed_at) values ('00000000-0000-4000-8000-000000000090', now());
    `);
    await db.exec(`
      insert into public.place_audit (place_id, actor_id, action, detail)
      values ('dummy-riyadh-olaya', '00000000-0000-4000-8000-000000000090',
              'developer_place_curated', '{"reason":"Riyadh DEV test"}');
    `);
    const stored = await rows(db, "select action, detail from public.place_audit");
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.action, "developer_place_curated");
    // Append-only holds for the extended vocabulary too.
    assert.ok((await fails(db, "update public.place_audit set action = 'admin_place_curated'")).length > 0);
  });
});

// ---------------------------------------------------------------------------
// D. Idempotency — AGENTS.md
// ---------------------------------------------------------------------------

test("0039 and 0040 are safe to re-apply", async () => {
  await withDb(async (db) => {
    const before = await rows(db, "select count(*)::int as n from public.places");
    // Re-apply both files, exactly as an operator re-running a migration would.
    await db.exec(stripPgcrypto(readMigration("0039_dummy_place_developer_authority.sql")));
    await db.exec(stripPgcrypto(readMigration("0040_dev_dummy_riyadh_dataset.sql")));
    const after = await rows(db, "select count(*)::int as n from public.places");
    assert.equal(after[0]?.n, before[0]?.n, "re-apply must not duplicate or destroy rows");
    const dummy = await rows(db, "select id from public.places where is_dummy");
    assert.equal(dummy.length, 20, "10 demo + 10 Riyadh, still exactly one set");
  });
});

// ---------------------------------------------------------------------------
// E. The Riyadh DEV dataset
// ---------------------------------------------------------------------------

test("0040 seeds exactly ten Riyadh Dummy Places, honestly marked and geo-valid", async () => {
  await withDb(async (db) => {
    const riyadh = await rows(
      db,
      `select id, name, short_description, category, type, address, country_code, region_name,
              timezone, currency, latitude, longitude, is_dummy, claim_status,
              publication_status, producer_id
         from public.places where id like 'dummy-riyadh-%' order by id`,
    );
    assert.equal(riyadh.length, 10);
    assert.deepEqual(
      riyadh.map((r) => String(r.id)),
      [...RIYADH_DUMMY_PLACE_IDS].sort(),
    );
    for (const row of riyadh) {
      // Flagged, not merely labelled.
      assert.equal(row.is_dummy, true);
      // Obviously test data: the name can never be read as a real Producer.
      assert.match(String(row.name), /^Dummy Riyadh — /, `${row.id} must be self-evidently test data`);
      assert.match(String(row.short_description ?? ""), /^Dummy Place \(test data only\)/);
      // Honest geography — currency and timezone follow the Place (Master 01).
      assert.equal(row.country_code, "SA");
      assert.equal(row.currency, "SAR");
      assert.equal(row.timezone, "Asia/Riyadh");
      // Real Riyadh coordinates, inside the city bounding box, DB-checked.
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      assert.ok(lat > 24.6 && lat < 24.9, `${row.id} latitude must be Riyadh`);
      assert.ok(lng > 46.5 && lng < 46.9, `${row.id} longitude must be Riyadh`);
      // Fixtures are owned by nobody and claimed by nobody.
      assert.equal(row.producer_id, null);
      assert.equal(row.claim_status, "unverified");
      assert.equal(row.publication_status, "published");
      // Canonical category only — no new category introduced.
      assert.ok(
        ["Sumber Daya Alam", "Industri & Pengolahan", "Perdagangan & Jasa"].includes(String(row.category)),
      );
    }
  });
});

test("SAR is accepted for the Riyadh fixtures while the currency CHECK still rejects junk", async () => {
  await withDb(async (db) => {
    // SAR landed (the seed would have failed otherwise).
    const sar = await rows(db, "select count(*)::int as n from public.places where currency = 'SAR'");
    assert.equal(sar[0]?.n, 10);
    // The widened vocabulary is still closed.
    assert.ok(
      (await fails(
        db,
        `insert into public.places (id, name, short_description, category, type, area, address,
          contact_information, timezone, currency, claim_status, publication_status)
         values ('bad-cur', 'Bad', 'd', 'Perdagangan & Jasa', 'experience', 'Bandung', 'Jl',
          '', 'Asia/Jakarta', 'JPY', 'unverified', 'published')`,
      )).length > 0,
      "an unknown currency must still be refused",
    );
    // IDR and USD rows were not disturbed.
    const idr = await rows(db, "select count(*)::int as n from public.places where currency = 'IDR'");
    assert.ok(Number(idr[0]?.n) > 0, "existing IDR rows must survive the widened vocabulary");
  });
});

test("0040 never touches a production or non-Dummy Place", async () => {
  const sql = stripComments(readMigration("0040_dev_dummy_riyadh_dataset.sql"));
  // Insert-only, and idempotent.
  assert.doesNotMatch(sql, /delete\s+from/i);
  assert.doesNotMatch(sql, /update\s+public\.places/i);
  assert.doesNotMatch(sql, /drop\s+/i);
  assert.match(sql, /on conflict \(id\) do nothing/);
  // Every seeded row carries the canonical flag in the same insert.
  const inserts = sql.match(/true\)/g) ?? [];
  assert.equal(inserts.length, 10, "all ten rows set is_dummy in the insert itself");
});

// ---------------------------------------------------------------------------
// E2. The corrective geography migration (0041)
// ---------------------------------------------------------------------------

/** The ten fixtures, with exactly the columns this section is about. */
const regionRows = (db: PGlite) =>
  rows(
    db,
    `select id, country_code, region_name, is_dummy, is_curated, currency
       from public.places where id like 'dummy-riyadh-%' order by id`,
  );

test("the Riyadh fixtures are filed under Ar Riyad (SA-01), not the Eastern Province", async () => {
  await withDb(async (db) => {
    const fixtures = await regionRows(db);
    assert.equal(fixtures.length, 10);
    for (const row of fixtures) {
      // THE DEFECT: these Places sit in Riyadh but were filed under
      // 'Ash Sharqiyah', the Eastern Province (SA-04) — a real subdivision,
      // just the wrong one, so no validation error ever surfaced it.
      assert.equal(row.country_code, "SA", `${row.id} country`);
      assert.equal(row.region_name, "Ar Riyad", `${row.id} must be in the Riyadh Region`);
      assert.notEqual(row.region_name, "Ash Sharqiyah", `${row.id} must not claim the Eastern Province`);
      // One region for the whole fixture set — never a per-row mix.
    }
    const regions = new Set(fixtures.map((r) => String(r.region_name)));
    assert.deepEqual([...regions], ["Ar Riyad"]);
  });
});

test("0041 is what corrects them — 0040 on its own still seeds the wrong subdivision", async () => {
  // 0040 is an applied migration and is left byte-for-byte as it was; the fix
  // is a SEPARATE corrective step. If this test ever fails with 0041 already
  // applied at seed time, the seed was rewritten and the audit trail of the
  // correction is gone.
  const db = await bootstrapDb();
  try {
    await db.exec(stripPgcrypto(readMigration("0039_dummy_place_developer_authority.sql")));
    await db.exec(stripPgcrypto(readMigration("0040_dev_dummy_riyadh_dataset.sql")));
    const seeded = await regionRows(db);
    assert.equal(seeded.length, 10);
    for (const row of seeded) {
      assert.equal(row.region_name, "Ash Sharqiyah", `${row.id} must still carry 0040's original value here`);
    }

    // The corrective migration moves every one of them to the Riyadh Region.
    await db.exec(stripPgcrypto(readMigration("0041_dev_dummy_riyadh_region.sql")));
    for (const row of await regionRows(db)) {
      assert.equal(row.region_name, "Ar Riyad", `${row.id} must be corrected by 0041`);
    }

    // ...and the post-condition is LOUD, not decorative: run it against a
    // database that still carries the defect and it must abort the apply.
    const db2 = await bootstrapDb();
    try {
      await db2.exec(stripPgcrypto(readMigration("0039_dummy_place_developer_authority.sql")));
      await db2.exec(stripPgcrypto(readMigration("0040_dev_dummy_riyadh_dataset.sql")));
      const postCondition = readMigration("0041_dev_dummy_riyadh_region.sql").match(/do \$\$[\s\S]*\$\$;/);
      assert.ok(postCondition, "0041 must carry its post-condition");
      const error = await fails(db2, stripPgcrypto(postCondition[0]));
      assert.match(error, /dev_dummy_riyadh_region_not_corrected/);
    } finally {
      await db2.close();
    }
  } finally {
    await db.close();
  }
});

test("0041 changes ONLY region_name — never the flag, the curation, or the currency", async () => {
  const db = await bootstrapDb();
  try {
    await db.exec(stripPgcrypto(readMigration("0039_dummy_place_developer_authority.sql")));
    await db.exec(stripPgcrypto(readMigration("0040_dev_dummy_riyadh_dataset.sql")));
    const before = await rows(
      db,
      `select id, name, short_description, category, type, area, address, country_code, timezone,
              currency, latitude, longitude, is_dummy, is_curated, claim_status,
              publication_status, producer_id
         from public.places where id like 'dummy-riyadh-%' order by id`,
    );
    await db.exec(stripPgcrypto(readMigration("0041_dev_dummy_riyadh_region.sql")));
    const after = await rows(
      db,
      `select id, name, short_description, category, type, area, address, country_code, timezone,
              currency, latitude, longitude, is_dummy, is_curated, claim_status,
              publication_status, producer_id
         from public.places where id like 'dummy-riyadh-%' order by id`,
    );

    // Everything except region_name is byte-identical. Nothing is promoted:
    // curation stays exactly where 0040 left it (Master §4/§6 — only the
    // audited Developer Authority path may move is_curated).
    assert.equal(before.length, 10);
    assert.deepEqual(after, before);
    for (const row of after) {
      assert.equal(row.is_dummy, true);
      assert.equal(row.is_curated, false, `${row.id} must NOT be promoted to Tempat Pilihan`);
      assert.equal(row.currency, "SAR");
    }
  } finally {
    await db.close();
  }
});

test("0041 touches ONLY the ten fixtures and never another Place", async () => {
  const db = await bootstrapDb();
  try {
    await db.exec(stripPgcrypto(readMigration("0039_dummy_place_developer_authority.sql")));
    await db.exec(stripPgcrypto(readMigration("0040_dev_dummy_riyadh_dataset.sql")));
    // The 0032 backfill put a NON-dummy Saudi DEV seed under 'Ash Sharqiyah'.
    // It is out of 0041's enumerated scope and must survive untouched — which
    // is also the proof that 0041 is id-scoped rather than predicate-scoped.
    const others = await rows(
      db,
      `select id, country_code, region_name from public.places
        where id not like 'dummy-riyadh-%' and country_code is not null order by id`,
    );
    assert.ok(others.length > 0, "the foundation must seed non-fixture Places");
    const saOthers = others.filter((r) => r.country_code === "SA");
    assert.ok(saOthers.length > 0, "expected a non-fixture Saudi Place to exist");

    await db.exec(stripPgcrypto(readMigration("0041_dev_dummy_riyadh_region.sql")));

    const after = await rows(
      db,
      `select id, country_code, region_name from public.places
        where id not like 'dummy-riyadh-%' and country_code is not null order by id`,
    );
    assert.deepEqual(after, others, "no non-fixture Place may change");
    // And no fixture id was created or dropped by the correction.
    const count = await rows(db, "select count(*)::int as n from public.places where id like 'dummy-riyadh-%'");
    assert.equal(count[0]?.n, 10);
  } finally {
    await db.close();
  }
});

test("0041 is idempotent, and never overwrites a later Admin correction", async () => {
  await withDb(async (db) => {
    // Re-applying changes nothing at all.
    await db.exec(stripPgcrypto(readMigration("0041_dev_dummy_riyadh_region.sql")));
    await db.exec(stripPgcrypto(readMigration("0041_dev_dummy_riyadh_region.sql")));
    for (const row of await regionRows(db)) {
      assert.equal(row.region_name, "Ar Riyad");
    }

    // An Admin who later re-assigns a DEV fixture to another REAL Saudi
    // subdivision keeps that value: the update is guarded on the exact wrong
    // value, not on "not already Ar Riyad". (Region is a canonical Place column
    // both Admin and Producer may edit, so a corrective migration must not be a
    // ratchet that reverts them.)
    await db.exec(`update public.places set region_name = 'Al Qasim' where id = 'dummy-riyadh-tahlia'`);
    await db.exec(stripPgcrypto(readMigration("0041_dev_dummy_riyadh_region.sql")));
    const corrected = await rows(db, "select region_name from public.places where id = 'dummy-riyadh-tahlia'");
    assert.equal(corrected[0]?.region_name, "Al Qasim");
  });
});

test("0041 is scoped to an enumerated id list and widens nothing", async () => {
  const sql = stripComments(readMigration("0041_dev_dummy_riyadh_region.sql"));
  // Enumerated ids only — never a name/prefix/free-text predicate (Master §3).
  assert.doesNotMatch(sql, /where\s+name\s/i);
  assert.doesNotMatch(sql, /like\s+'/i);
  assert.doesNotMatch(sql, /similar to/i);
  assert.doesNotMatch(sql, /ilike/i);
  // Its target list is EXACTLY the Riyadh fixture set the core module knows,
  // so the migration and the acceptance helper cannot drift apart.
  const ids = [...sql.matchAll(/'(dummy-riyadh-[a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [...RIYADH_DUMMY_PLACE_IDS].sort());
  // One column is written; the flags are never touched.
  assert.match(sql, /set region_name = 'Ar Riyad',\s*updated_at = now\(\)/);
  assert.doesNotMatch(sql, /is_dummy\s*=/);
  assert.doesNotMatch(sql, /is_curated\s*=/);
  assert.doesNotMatch(sql, /insert\s+into/i);
  // Nothing is destroyed and no protection is changed.
  assert.doesNotMatch(sql, /delete\s+from/i);
  assert.doesNotMatch(sql, /drop\s+/i);
  assert.doesNotMatch(sql, /truncate/i);
  assert.doesNotMatch(sql, /disable row level security/i);
  assert.doesNotMatch(sql, /block_place_audit_mutation|block_place_is_curated_update|block_place_is_dummy_update/);
  // Idempotency + a loud post-condition, both stated in SQL. The update guard
  // names the exact wrong value, so it is a no-op on re-apply AND never a
  // ratchet over a value an Admin chose later.
  assert.match(sql, /region_name = 'Ash Sharqiyah'/);
  assert.match(sql, /raise exception/);
});

test("Ar Riyad is the value this codebase can actually store and validate", async () => {
  // The stored spelling must be the canonical one: `lib/geo/countries.ts`
  // validates `region_name` against the ISO 3166-2 dataset on every write and
  // fills the Admin/Producer dropdowns from it. Nominatim's own spelling of the
  // same region is NOT in the list, so storing it would make these Places
  // un-editable through the one shared Place validator.
  const saRegions = placeRegionsFor("SA");
  assert.equal(isValidPlaceRegion("SA", "Ar Riyad"), true);
  assert.equal(isValidPlaceRegion("SA", "Riyadh Region"), false);
  assert.equal(isValidPlaceRegion("SA", "Riyadh"), false);
  // Two DIFFERENT subdivisions — the whole point of the correction. The
  // Eastern Province is the one the fixtures were wrongly filed under.
  assert.ok(saRegions.includes("Ash Sharqiyah"));
  assert.ok(saRegions.includes("Ar Riyad"));
  // Distinct entries in the one canonical list — two different real regions,
  // which is exactly why swapping one for the other was a silent, valid-looking
  // mistake rather than a rejected value.
  assert.equal(saRegions.filter((r) => r === "Ar Riyad").length, 1);
  assert.equal(saRegions.filter((r) => r === "Ash Sharqiyah").length, 1);
  assert.notEqual(saRegions.indexOf("Ar Riyad"), saRegions.indexOf("Ash Sharqiyah"));
});

test("the Riyadh geography is unchanged by the correction — only the label was wrong", async () => {
  await withDb(async (db) => {
    const fixtures = await rows(
      db,
      `select id, latitude, longitude from public.places where id like 'dummy-riyadh-%'`,
    );
    for (const row of fixtures) {
      const lat = Number(row.latitude);
      const lng = Number(row.longitude);
      // The coordinates were always Riyadh; only the subdivision label was not.
      // The Eastern Province starts well east of this box (Dammam/Khobar sit
      // around 26.4 N / 50.1 E), so the corrected subdivision and the existing
      // coordinates now agree.
      assert.ok(lat > 24.6 && lat < 24.9, `${row.id} latitude must be Riyadh`);
      assert.ok(lng > 46.5 && lng < 46.9, `${row.id} longitude must be Riyadh`);
    }
  });
});

// ---------------------------------------------------------------------------
// F. The pure authorization core (executable, no database)
// ---------------------------------------------------------------------------

test("the Developer Authority may perform exactly two operations", () => {
  assert.deepEqual([...DEVELOPER_PLACE_OPERATIONS], ["set_dummy", "set_curated"]);
  assert.equal(isPermittedOperation("set_dummy"), true);
  assert.equal(isPermittedOperation("set_curated"), true);
  for (const op of ["delete_place", "set_publication_status", "approve_claim", "", null, undefined, 42]) {
    assert.equal(isPermittedOperation(op), false, `${String(op)} must not be permitted`);
  }
});

test("curation authority is refused for a NON-Dummy Place", () => {
  const target = { id: "real-place", isDummy: false, isCurated: false };
  const refused = decideDeveloperPlaceMutation({
    operation: "set_curated",
    target,
    desiredValue: true,
    reason: "Riyadh DEV test",
  });
  assert.deepEqual(refused, { ok: false, reason: DEVELOPER_PLACE_REFUSALS.target_not_dummy });
});

test("a validated Dummy Place IS mutable, and the audit key follows the operation", () => {
  const dummy = { id: "dummy-riyadh-olaya", isDummy: true, isCurated: false };
  assert.deepEqual(
    decideDeveloperPlaceMutation({ operation: "set_curated", target: dummy, desiredValue: true, reason: "ok" }),
    { ok: true },
  );
  assert.equal(developerAuditAction({ operation: "set_curated", desiredValue: true }), "developer_place_curated");
  assert.equal(developerAuditAction({ operation: "set_curated", desiredValue: false }), "developer_place_uncurated");
  assert.equal(developerAuditAction({ operation: "set_dummy", desiredValue: true }), "developer_place_dummy_marked");
  assert.equal(developerAuditAction({ operation: "set_dummy", desiredValue: false }), "developer_place_dummy_cleared");
});

test("marking Dummy is allowed on a non-Dummy Place — that is how the scope is established", () => {
  const target = { id: "new-fixture", isDummy: false, isCurated: false };
  assert.deepEqual(
    decideDeveloperPlaceMutation({ operation: "set_dummy", target, desiredValue: true, reason: "seed fixture" }),
    { ok: true },
  );
});

test("every refusal path is reachable and total", () => {
  const dummy = { id: "d", isDummy: true, isCurated: false };
  // Missing Place.
  assert.deepEqual(
    decideDeveloperPlaceMutation({ operation: "set_dummy", target: null, desiredValue: true, reason: "r" }),
    { ok: false, reason: DEVELOPER_PLACE_REFUSALS.place_not_found },
  );
  // Non-boolean flag.
  assert.equal(
    decideDeveloperPlaceMutation({ operation: "set_dummy", target: dummy, desiredValue: "yes", reason: "r" }).ok,
    false,
  );
  // Missing / blank / over-long reason.
  for (const reason of [undefined, null, "", "   ", "x".repeat(MAX_DEVELOPER_REASON_LENGTH + 1)]) {
    assert.equal(
      decideDeveloperPlaceMutation({ operation: "set_dummy", target: { ...dummy, isDummy: false }, desiredValue: true, reason }).ok,
      false,
      `reason ${String(reason).slice(0, 12)} must be refused`,
    );
  }
  assert.equal(isValidDeveloperReason("  Riyadh DEV test  "), true);
  assert.equal(normalizeDeveloperReason("  Riyadh DEV test  "), "Riyadh DEV test");
  // Idempotent no-op writes nothing.
  assert.deepEqual(
    decideDeveloperPlaceMutation({ operation: "set_curated", target: { ...dummy, isCurated: true }, desiredValue: true, reason: "r" }),
    { ok: false, reason: DEVELOPER_PLACE_REFUSALS.no_op },
  );
});

test("scope is checked BEFORE the reason, so a refusal cannot be used to probe Places", () => {
  // A non-Dummy target with a bad reason still reports target_not_dummy: the
  // refusal reason never leaks "this Place exists but is out of scope".
  const decision = decideDeveloperPlaceMutation({
    operation: "set_curated",
    target: { id: "real", isDummy: false, isCurated: false },
    desiredValue: true,
    reason: "",
  });
  assert.equal(decision.ok, false);
  assert.equal((decision as { reason: string }).reason, DEVELOPER_PLACE_REFUSALS.target_not_dummy);
});

// ---------------------------------------------------------------------------
// F2. The ROLLBACK patch (regression: the audit-failure rollback)
// ---------------------------------------------------------------------------

test("the rollback patch restores the ORIGINAL value, not the requested one", () => {
  // THE REGRESSION. A previous build reused the forward patch in the audit
  // failure handler, so "rolling back" re-applied the value the audit had just
  // refused to record: the flag stayed flipped with no trail. The revert is
  // derived from the pre-write target and has no parameter a caller could fill
  // with `desiredValue`.
  const target = { id: "dummy-riyadh-olaya", isDummy: true, isCurated: false };

  // set_dummy: the Place was NOT dummy, the Creator asked for true.
  const dummyTarget = { id: "real-place", isDummy: false, isCurated: false };
  const revert = developerRevertPatch("set_dummy", dummyTarget);
  assert.deepEqual(revert, { is_dummy: false }, "rollback must restore is_dummy = false");
  assert.notDeepEqual(revert, developerFlagPatch("set_dummy", true), "the revert must not be the forward patch");

  // set_curated: the Place was NOT curated, the Creator asked for true.
  const curatedTarget = { id: "dummy-riyadh-malaz", isDummy: true, isCurated: false };
  const curatedRevert = developerRevertPatch("set_curated", curatedTarget);
  assert.deepEqual(curatedRevert, { is_curated: false }, "rollback must restore is_curated = false");
  assert.notDeepEqual(curatedRevert, developerFlagPatch("set_curated", true), "the revert must not be the forward patch");

  // And the reverse direction: unmarking / uncurating rolls the flag back up.
  assert.deepEqual(developerRevertPatch("set_dummy", target), { is_dummy: true });
  assert.deepEqual(developerRevertPatch("set_curated", { ...target, isCurated: true }), { is_curated: true });

  // The revert touches ONLY the operated column, so a rollback can never touch
  // the other flag as a side effect.
  for (const operation of DEVELOPER_PLACE_OPERATIONS) {
    const patch = developerRevertPatch(operation, { id: "p", isDummy: true, isCurated: true });
    assert.deepEqual(Object.keys(patch), [developerFlagColumn(operation)]);
    assert.equal(Object.keys(patch).length, 1);
  }
});

test("the rollback patch agrees with the audit's own 'before' snapshot", () => {
  // Master §5: the rollback must leave the row in the state the audit recorded
  // as `before`. If the two ever disagreed, a failed audit would leave data
  // that no trail describes — so they are derived from the same original.
  for (const operation of DEVELOPER_PLACE_OPERATIONS) {
    for (const original of [false, true]) {
      const target = {
        id: "dummy-riyadh-kafd",
        isDummy: operation === "set_dummy" ? original : true,
        isCurated: operation === "set_curated" ? original : false,
      };
      const revert = developerRevertPatch(operation, target);
      const before = { ...target, is_dummy: target.isDummy, is_curated: target.isCurated };
      assert.equal(revert[developerFlagColumn(operation)], before[developerFlagColumn(operation)]);
      // The requested value is always the opposite, so the two patches differ.
      const forward = developerFlagPatch(operation, !original);
      assert.notDeepEqual(revert, forward);
    }
  }
});

test("the forward patch carries the requested value for the same single column", () => {
  assert.equal(developerFlagColumn("set_dummy"), "is_dummy");
  assert.equal(developerFlagColumn("set_curated"), "is_curated");
  assert.deepEqual(developerFlagPatch("set_dummy", true), { is_dummy: true });
  assert.deepEqual(developerFlagPatch("set_dummy", false), { is_dummy: false });
  assert.deepEqual(developerFlagPatch("set_curated", true), { is_curated: true });
  assert.deepEqual(developerFlagPatch("set_curated", false), { is_curated: false });
});
// ---------------------------------------------------------------------------
// G. The point of the dataset: a Riyadh search from Dammam
// ---------------------------------------------------------------------------

test("a Riyadh search from Dammam covers RIYADH, not the viewer's city", async () => {
  await withDb(async (db) => {
    const fetched = await rows(
      db,
      `select id, latitude, longitude from public.places where id like 'dummy-riyadh-%'`,
    );
    const riyadh = fetched.map((r) => ({
      id: String(r.id),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
    }));
    assert.equal(riyadh.length, 10);

    // The viewer's device fix is Dammam — ~850 km away.
    const DAMMAM = { lat: 26.4207, lng: 50.0888 };
    const searchCenter = { lat: riyadh[0]!.latitude, lng: riyadh[0]!.longitude };

    // The active center is the SEARCH, not the device.
    const { mode, center } = resolveActiveCenter({ searchCenter, viewerPosition: DAMMAM });
    assert.equal(mode, "city_search");
    assert.deepEqual(center, searchCenter);

    // Coverage follows the search center. The window here is a CITY-scale one
    // (±0.15° ≈ 16 km), i.e. what the user actually sees after the map
    // recenters on the geocoded city centre — wider than the transient ±0.05°
    // bridge box the Home filter uses only before Leaflet reports its bounds.
    const viewport = {
      north: center!.lat + 0.15,
      south: center!.lat - 0.15,
      east: center!.lng + 0.15,
      west: center!.lng - 0.15,
    };
    const covered = narrowToViewport(riyadh, viewport);
    assert.equal(covered.length, 10, "all ten Riyadh fixtures are in the searched area");

    // And the Dammam device area contains NONE of them — proof the list is
    // following Riyadh rather than the viewer.
    const dammamCityViewport = {
      north: DAMMAM.lat + 0.15,
      south: DAMMAM.lat - 0.15,
      east: DAMMAM.lng + 0.15,
      west: DAMMAM.lng - 0.15,
    };
    assert.equal(
      narrowToViewport(riyadh, dammamCityViewport).length,
      0,
      "no Riyadh Place is anywhere near the viewer's own city",
    );
  });
});

test("\"Lokasi Saya\" moves the center back to Dammam and empties the Riyadh coverage", () => {
  const DAMMAM = { lat: 26.4207, lng: 50.0888 };
  const riyadh = { id: "dummy-riyadh-olaya", latitude: 24.6937, longitude: 46.6853 };
  const after = resolveActiveCenter({ searchCenter: clearCitySearch().center, viewerPosition: DAMMAM });
  assert.equal(after.mode, "device_location");
  assert.deepEqual(after.center, DAMMAM);
  assert.equal(
    narrowToViewport([riyadh], {
      north: DAMMAM.lat + 0.05,
      south: DAMMAM.lat - 0.05,
      east: DAMMAM.lng + 0.05,
      west: DAMMAM.lng - 0.05,
    }).length,
    0,
    "the Riyadh Place is no longer in the Dammam area",
  );
});
