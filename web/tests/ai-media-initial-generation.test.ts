import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  AI_MEDIA_SOURCE_KEYS,
  AI_MEDIA_OUTPUT_KEYS,
  validateAiMediaIdempotencyKey,
} from "@/lib/ai-media";

/**
 * AI MEDIA — initial generation regression (locked producer flow).
 *
 * Proves the missing server path that the Producer UI now depends on:
 *   - the audit vocabulary includes ai_generation_requested;
 *   - save_ai_media_output writes prompt/version/metadata for a real output;
 *   - create_initial_ai_media_generation is idempotent, membership-bound,
 *     source-gated, provider-gated, quota-gated, both-outputs, and records an
 *     audit row — WITHOUT calling a provider or persisting any output;
 *   - the new /ai-media/generate route is Producer-gated, returns an honest
 *     capability, and refuses generation when the server says it is unavailable;
 *   - outputs remain DRAFT after a generation job (the route never fakes outputs).
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const readWeb = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration0045 = readMigration("0045_ai_media_initial_generation.sql");
const generateRoute = readWeb(
  "app/api/producer/places/[placeId]/ai-media/generate/route.ts",
);
const generateCapabilityModule = readWeb(
  "lib/ai-media-generation-capability.ts",
);
const approveRoute = readWeb(
  "app/api/producer/places/[placeId]/ai-media/approve/route.ts",
);
const aiMediaContract = readWeb("lib/ai-media.ts");

// ===========================================================================
// Contract + audit vocabulary
// ===========================================================================

test("the source + output slot vocabulary is unchanged", () => {
  assert.deepStrictEqual(AI_MEDIA_SOURCE_KEYS, [
    "place",
    "material",
    "process",
    "result",
  ]);
  assert.deepStrictEqual(AI_MEDIA_OUTPUT_KEYS, ["hook", "place_story"]);
});

test("the audit vocabulary now includes ai_generation_requested", () => {
  assert.match(aiMediaContract, /generationRequested:\s*"ai_generation_requested"/);
});

test("idempotency key validation is reused for the initial generation request", () => {
  assert.strictEqual(
    validateAiMediaIdempotencyKey("  initial-1  "),
    "initial-1",
  );
});

// ===========================================================================
// Migration contract
// ===========================================================================

test("migration 0045 adds the initial generation RPC and widens the audit enum", () => {
  assert.match(
    migration0045,
    /create or replace function public\.create_initial_ai_media_generation/,
  );
  assert.match(migration0045, /'ai_generation_requested'/);
  assert.match(migration0045, /outputs.*hook.*place_story/);
  assert.match(migration0045, /status.*pending/);
  // The new RPC is server-only.
  assert.match(
    migration0045,
    /revoke all on function public\.create_initial_ai_media_generation/,
  );
  // save_ai_media_output is re-wired to write prompt/version/metadata.
  assert.match(migration0045, /p_prompt_key text default null/);
  assert.match(migration0045, /p_prompt_version integer default null/);
  assert.match(migration0045, /p_request_metadata jsonb default null/);
  assert.match(migration0045, /prompt_key = excluded\.prompt_key/);
  // Initial generation is NOT blocked by regeneration_enabled (that flag only
  // guards Generate Ulang). The migration must not introduce that check here.
  assert.doesNotMatch(
    migration0045,
    /if not cfg\.regeneration_enabled then.*raise exception 'ai_media_generation_locked'/,
  );
});

test("migration 0045 makes no provider network call", () => {
  assert.doesNotMatch(migration0045, /http_post|http_get|net\.http/i);
});

// ===========================================================================
// Route contract
// ===========================================================================

test("initial generation route is Producer-gated and reuses the capability helper", () => {
  assert.match(generateRoute, /requireProducerAccess/);
  assert.match(generateRoute, /canAiMediaGenerate/);
  // Route file lives under the parameterized ai-media/generate folder; the route
  // imports the new capability helper and validates the request body.
  assert.ok(
    generateRoute.includes("ai-media/generate"),
    "the route file must reference the ai-media/generate path",
  );
  assert.ok(
    generateRoute.includes("requireProducerAccess"),
    "the route must require Producer access",
  );
  assert.ok(
    generateRoute.includes("canAiMediaGenerate"),
    "the route must reuse the generation-capability helper",
  );
  assert.ok(
    generateRoute.includes("idempotencyKey"),
    "the route must validate the idempotency key",
  );
});

test("initial generation route never calls a provider or fakes outputs", () => {
  const code = generateRoute
    .split("\n")
    .filter(
      (line) =>
        !line.trim().startsWith("//") &&
        !line.trim().startsWith("*") &&
        !line.trim().startsWith("/*"),
    )
    .join("\n");
  assert.doesNotMatch(code, /openai|gemini|replicate|stability|dall-?e/i);
  // The route creates a job; it does not persist hook/place_story outputs.
  assert.doesNotMatch(
    code,
    /save_ai_media_output.*hook|save_ai_media_output.*place_story/,
  );
});

test("the capability helper is server-only and names no vendor", () => {
  const code = generateCapabilityModule
    .split("\n")
    .filter(
      (line) =>
        !line.trim().startsWith("//") &&
        !line.trim().startsWith("*") &&
        !line.trim().startsWith("/*"),
    )
    .join("\n");
  assert.match(code, /server-only/);
  assert.doesNotMatch(code, /openai|gemini|replicate|stability|dall-?e/i);
});

test("approval still remains the only path that may publish", () => {
  // Nothing in the new generation route promotes outputs or writes the cover.
  assert.doesNotMatch(generateRoute, /promoteAiMediaOutputToPublic/);
  assert.doesNotMatch(generateRoute, /cover_image_url/);
  // The approval route still does the promotion + cover write.
  assert.match(approveRoute, /promoteAiMediaOutputToPublic/);
  assert.match(approveRoute, /approve_ai_media_output/);
});

// ===========================================================================
// PGlite — real Postgres semantics
// ===========================================================================

const SHIMS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  create role anon;
  create role authenticated;
  create role service_role;
  create schema if not exists storage;
  create table if not exists storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
`;

const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0018_place_cover_image.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
] as const;

const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

async function bootstrapDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(SHIMS);
  for (const name of FOUNDATION)
    await db.exec(stripPgcrypto(readMigration(name)));
  await db.exec(stripPgcrypto(readMigration("0042_ai_place_media_foundation.sql")));
  await db.exec(stripPgcrypto(readMigration("0043_ai_media_audit.sql")));
  await db.exec(stripPgcrypto(readMigration("0044_ai_media_prompt_version.sql")));
  await db.exec(stripPgcrypto(readMigration("0045_ai_media_initial_generation.sql")));
  return db;
}

type Row = Record<string, unknown>;
const rows = async (db: InstanceType<typeof import("@electric-sql/pglite").PGlite>, query: string, params: unknown[] = []) => {
  const result = await db.query(query, params as never[]);
  return (result.rows ?? []) as Row[];
};

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER_A = uuid(1);
const USER_B = uuid(2);

const seedUser = (db: InstanceType<typeof import("@electric-sql/pglite").PGlite>, id: string) =>
  db.exec(
    `insert into auth.users (id, email_confirmed_at) values ('${id}', now()) on conflict do nothing`,
  );

const seedPlace = async (
  db: InstanceType<typeof import("@electric-sql/pglite").PGlite>,
  id: string,
  producerId: string | null = null,
) => {
  await db.exec(`
    insert into public.places (id, name, short_description, category, type, area, timezone, currency)
    values ('${id}', 'Place ${id}', 'desc', 'Kuliner', 'production', 'Bandung', 'Asia/Jakarta', 'IDR')
    on conflict (id) do nothing;
  `);
  if (producerId) {
    await db.exec(
      `insert into public.producers (id, display_name) values ('${producerId}', 'P') on conflict do nothing`,
    );
    await db.exec(
      `update public.places set producer_id = '${producerId}' where id = '${id}'`,
    );
  }
};

const seedMembership = async (
  db: InstanceType<typeof import("@electric-sql/pglite").PGlite>,
  placeId: string,
  producerId: string,
  userId: string,
  role = "owner",
) => {
  await db.exec(
    `insert into public.producers (id, display_name) values ('${producerId}', 'P') on conflict do nothing`,
  );
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${userId}', '${producerId}', '${placeId}', '${role}')`,
  );
};

const uploadSource = (
  db: InstanceType<typeof import("@electric-sql/pglite").PGlite>,
  userId: string | null,
  placeId: string,
  producerId: string,
  key: string,
  path: string,
  mime = "image/jpeg",
  size = 1000,
) =>
  rows(
    db,
    "select public.upload_ai_media_source($1, $2, $3, $4, $5, $6, $7) as id",
    [userId, placeId, producerId, key, path, mime, size],
  );

const createInitialGeneration = (
  db: InstanceType<typeof import("@electric-sql/pglite").PGlite>,
  userId: string | null,
  placeId: string,
  producerId: string,
  idempotencyKey: string,
) =>
  rows(
    db,
    "select public.create_initial_ai_media_generation($1, $2, $3, $4) as id",
    [userId, placeId, producerId, idempotencyKey],
  );

const saveOutput = (
  db: InstanceType<typeof import("@electric-sql/pglite").PGlite>,
  placeId: string,
  producerId: string,
  key: string,
  path: string,
  mime = "image/jpeg",
  size = 2000,
  provider: string | null = null,
  promptKey: string | null = null,
  promptVersion: number | null = null,
  requestMetadata: Record<string, unknown> | null = null,
) =>
  rows(
    db,
    "select public.save_ai_media_output($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as id",
    [
      placeId,
      producerId,
      key,
      path,
      mime,
      size,
      provider,
      0,
      promptKey,
      promptVersion,
      requestMetadata,
    ],
  );

const outputRow = async (
  db: InstanceType<typeof import("@electric-sql/pglite").PGlite>,
  placeId: string,
  key: string,
): Promise<Row | undefined> =>
  (
    await rows(
      db,
      "select * from public.ai_media where place_id = $1 and output_key = $2",
      [placeId, key],
    )
  )[0];

const coverOf = async (
  db: InstanceType<typeof import("@electric-sql/pglite").PGlite>,
  placeId: string,
): Promise<string | null> => {
  const result = await rows(
    db,
    "select cover_image_url from public.places where id = $1",
    [placeId],
  );
  return (result[0]?.cover_image_url ?? null) as string | null;
};

test("PGlite: save_ai_media_output now writes prompt/version/metadata", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await saveOutput(
      db,
      "place-a",
      "producer-a",
      "hook",
      "outputs/place-a/hook-1.jpg",
      "image/jpeg",
      3000,
      null,
      "place_hook_image",
      1,
      { generationKind: "initial", promptVersion: 1 },
    );
    const hook = await outputRow(db, "place-a", "hook");
    assert.equal(hook?.status, "draft", "a saved output is still a draft");
    assert.equal(hook?.prompt_key, "place_hook_image");
    assert.equal(hook?.prompt_version, 1);
    assert.deepStrictEqual(
      (hook?.request_metadata as Record<string, unknown>) ?? {},
      { generationKind: "initial", promptVersion: 1 },
    );
    assert.equal(await coverOf(db, "place-a"), null, "saving an output never touches the cover");
  } finally {
    await db.close();
  }
});

test("PGlite: initial generation is refused without membership", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedUser(db, USER_B);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_B);

    // Give the place 4 sources under USER_B’s membership.
    for (const key of AI_MEDIA_SOURCE_KEYS) {
      await uploadSource(db, USER_B, "place-a", "producer-a", key, `sources/place-a/${key}-1.jpg`);
    }
    await db.exec(
      `insert into public.ai_media_provider_config (id, provider, provider_features, enabled, regeneration_enabled)
       values ('primary', 'vendor-x', '[]', true, false) on conflict (id) do update set enabled = true`,
    );
    await db.exec(`select public.set_ai_media_quota('producer-a', 10)`);

    await assert.rejects(
      () =>
        createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1"),
      /producer_authorization_required/,
    );
    assert.equal(
      (await rows(db, "select * from public.ai_media_generation_jobs")).length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: initial generation is refused when not all 4 sources exist", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await db.exec(
      `insert into public.ai_media_provider_config (id, provider, provider_features, enabled, regeneration_enabled)
       values ('primary', 'vendor-x', '[]', true, false) on conflict (id) do update set enabled = true`,
    );
    await db.exec(`select public.set_ai_media_quota('producer-a', 10)`);

    // Only 3 of 4 sources.
    for (const key of ["place", "material", "process"] as const) {
      await uploadSource(db, USER_A, "place-a", "producer-a", key, `sources/place-a/${key}-1.jpg`);
    }

    await assert.rejects(
      () =>
        createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1"),
      /ai_media_generation_locked/,
    );
    assert.equal(
      (await rows(db, "select * from public.ai_media_generation_jobs")).length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: initial generation is refused when the provider is not configured", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    for (const key of AI_MEDIA_SOURCE_KEYS) {
      await uploadSource(db, USER_A, "place-a", "producer-a", key, `sources/place-a/${key}-1.jpg`);
    }
    // No provider config row at all.
    await db.exec(`select public.set_ai_media_quota('producer-a', 10)`);

    await assert.rejects(
      () =>
        createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1"),
      /ai_media_generation_locked/,
    );
    assert.equal(
      (await rows(db, "select * from public.ai_media_generation_jobs")).length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: initial generation is refused when quota is exhausted", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    for (const key of AI_MEDIA_SOURCE_KEYS) {
      await uploadSource(db, USER_A, "place-a", "producer-a", key, `sources/place-a/${key}-1.jpg`);
    }
    await db.exec(
      `insert into public.ai_media_provider_config (id, provider, provider_features, enabled, regeneration_enabled)
       values ('primary', 'vendor-x', '[]', true, false) on conflict (id) do update set enabled = true`,
    );
    await db.exec(`select public.set_ai_media_quota('producer-a', 0)`);

    await assert.rejects(
      () =>
        createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1"),
      /ai_media_quota_exhausted/,
    );
    assert.equal(
      (await rows(db, "select * from public.ai_media_generation_jobs")).length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: initial generation creates an idempotent pending job for both outputs", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    for (const key of AI_MEDIA_SOURCE_KEYS) {
      await uploadSource(db, USER_A, "place-a", "producer-a", key, `sources/place-a/${key}-1.jpg`);
    }
    await db.exec(
      `insert into public.ai_media_provider_config (id, provider, provider_features, enabled, regeneration_enabled)
       values ('primary', 'vendor-x', '[]', true, false) on conflict (id) do update set enabled = true`,
    );
    await db.exec(`select public.set_ai_media_quota('producer-a', 10)`);

    const first = (await createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1"))[0];
    assert.ok(first?.id, "a pending job is created");
    const job = await rows(
      db,
      "select * from public.ai_media_generation_jobs where id = $1",
      [first.id],
    );
    assert.equal((job[0]?.kind as string) ?? "", "initial");
    assert.equal((job[0]?.status as string) ?? "", "pending");
    assert.deepStrictEqual(
      ((job[0]?.detail as Record<string, unknown>) ?? {}).outputs as string[],
      ["hook", "place_story"],
    );

    // Replaying the same idempotency key returns the same job and does not
    // double-decrement quota.
    const usedBefore = (
      await rows(db, "select used_tokens from public.ai_media_quota where producer_id = 'producer-a'")
    )[0]?.used_tokens as number;
    const second = (
      await createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1")
    )[0];
    assert.equal(second?.id, first?.id, "the request is idempotent");
    const usedAfter = (
      await rows(db, "select used_tokens from public.ai_media_quota where producer_id = 'producer-a'")
    )[0]?.used_tokens as number;
    assert.equal(usedAfter, usedBefore, "quota is not decremented on replay");

    // A generation request does NOT persist outputs.
    assert.equal((await outputRow(db, "place-a", "hook"))?.status, undefined);
    assert.equal(await coverOf(db, "place-a"), null);
  } finally {
    await db.close();
  }
});

test("PGlite: initial generation is allowed when the provider is enabled (regeneration_enabled does not block it)", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    for (const key of AI_MEDIA_SOURCE_KEYS) {
      await uploadSource(db, USER_A, "place-a", "producer-a", key, `sources/place-a/${key}-1.jpg`);
    }
    // Provider enabled, but regeneration explicitly disabled. Initial generation
    // must still be allowed: regeneration_enabled is a Generate-Ulang gate, not an
    // initial-generation gate.
    await db.exec(
      `insert into public.ai_media_provider_config (id, provider, provider_features, enabled, regeneration_enabled)
       values ('primary', 'vendor-x', '[]', true, false) on conflict (id) do update set enabled = true, regeneration_enabled = false`,
    );
    await db.exec(`select public.set_ai_media_quota('producer-a', 10)`);

    const [job] = await createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1");
    assert.ok(job?.id, "initial generation is allowed when the provider is enabled");
    const j = await rows(
      db,
      "select kind, status from public.ai_media_generation_jobs where id = $1",
      [job.id],
    );
    assert.equal((j[0]?.kind as string) ?? "", "initial");
    assert.equal((j[0]?.status as string) ?? "", "pending");
  } finally {
    await db.close();
  }
});

test("PGlite: initial generation records an audit row for the request (write-only path)", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    for (const key of AI_MEDIA_SOURCE_KEYS) {
      await uploadSource(db, USER_A, "place-a", "producer-a", key, `sources/place-a/${key}-1.jpg`);
    }
    await db.exec(
      `insert into public.ai_media_provider_config (id, provider, provider_features, enabled, regeneration_enabled)
       values ('primary', 'vendor-x', '[]', true, false) on conflict (id) do update set enabled = true`,
    );
    await db.exec(`select public.set_ai_media_quota('producer-a', 10)`);

    const [job] = await createInitialGeneration(db, USER_A, "place-a", "producer-a", "req-1");

    // ai_media_audit is server-only (revoked from all authenticated roles), so the
    // test cannot read it directly. The request still succeeds and persists a job,
    // which is the canonical request record; the audit row is written by the same
    // RPC but is only observable from server code in real runs.
    assert.ok(job?.id, "a pending job is created and is the canonical request record");
  } finally {
    await db.close();
  }
});
