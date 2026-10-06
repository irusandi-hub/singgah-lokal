import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  AI_MEDIA_SOURCE_KEYS,
  AI_MEDIA_OUTPUT_KEYS,
  AI_MEDIA_MAX_BYTES,
  AI_MEDIA_ACCEPTED_TYPES,
  AiMediaError,
  REGENERATION_OUTPUT_KEYS,
  isAiMediaRegenerationUnlocked,
  mapAiMediaOutputRow,
  validateAiMediaGenerationJobStatus,
  validateAiMediaIdempotencyKey,
  validateAiMediaOutputKey,
  validateAiMediaSourceFile,
  validateAiMediaSourceKey,
  validateAiMediaStatus,
} from "@/lib/ai-media";

/**
 * AI PLACE MEDIA regression (locked planning).
 *
 * Proves the foundation at two levels:
 *  - the pure contract (keys, limits, validators, locked regeneration);
 *  - a REAL Postgres engine (PGlite) applying migration 0042, so the locked
 *    rules are proven SEMANTICALLY: draft-until-approval, approval-only cover,
 *    regeneration lock, quota fail-closed, private buckets, server-only RPCs.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const readWeb = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = readMigration("0042_ai_place_media_foundation.sql");
const storageModule = readWeb("lib/ai-media-storage.ts");
const sourcesListRoute = readWeb("app/api/producer/places/[placeId]/ai-media/route.ts");
const sourceUploadRoute = readWeb("app/api/producer/places/[placeId]/ai-media/sources/[sourceKey]/route.ts");
const outputsRoute = readWeb("app/api/producer/places/[placeId]/ai-media/outputs/route.ts");
const approveRoute = readWeb("app/api/producer/places/[placeId]/ai-media/approve/route.ts");
const generateRoute = readWeb("app/api/producer/places/[placeId]/ai-media/generate-ulg/route.ts");
const quotaRoute = readWeb("app/api/producer/places/[placeId]/ai-media/quota/route.ts");
const genjobsRoute = readWeb("app/api/producer/places/[placeId]/ai-media/genjobs/route.ts");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");
}

// ===========================================================================
// Pure contract
// ===========================================================================

test("source keys are exactly place, material, process, result", () => {
  assert.deepStrictEqual(AI_MEDIA_SOURCE_KEYS, ["place", "material", "process", "result"]);
});

test("output keys are exactly hook and place_story", () => {
  assert.deepStrictEqual(AI_MEDIA_OUTPUT_KEYS, ["hook", "place_story"]);
});

test("source max size is 5 MB with the locked accepted types", () => {
  assert.strictEqual(AI_MEDIA_MAX_BYTES, 5 * 1024 * 1024);
  assert.deepStrictEqual(Array.from(AI_MEDIA_ACCEPTED_TYPES), [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
  ]);
});

test("regeneration covers both outputs", () => {
  assert.deepStrictEqual(REGENERATION_OUTPUT_KEYS, ["hook", "place_story"]);
});

test("regeneration is LOCKED by default", () => {
  assert.strictEqual(isAiMediaRegenerationUnlocked(), false);
});

test("source file validation rejects invalid type/size", () => {
  assert.throws(() => validateAiMediaSourceFile({ type: "image/gif", size: 1000 }), /ai_media_source_type_invalid/);
  assert.throws(
    () => validateAiMediaSourceFile({ type: "image/jpeg", size: AI_MEDIA_MAX_BYTES + 1 }),
    /ai_media_source_size_invalid/,
  );
  assert.throws(() => validateAiMediaSourceFile({ type: "image/png", size: 0 }), /ai_media_source_size_invalid/);
});

test("key/status validators accept only the locked values", () => {
  for (const key of AI_MEDIA_SOURCE_KEYS) assert.strictEqual(validateAiMediaSourceKey(key), true);
  assert.strictEqual(validateAiMediaSourceKey("hook"), false);
  assert.strictEqual(validateAiMediaOutputKey("hook"), true);
  assert.strictEqual(validateAiMediaOutputKey("place_story"), true);
  assert.strictEqual(validateAiMediaOutputKey("process"), false);
  assert.strictEqual(validateAiMediaStatus("draft"), true);
  assert.strictEqual(validateAiMediaStatus("published"), false);
  assert.strictEqual(validateAiMediaGenerationJobStatus("locked"), true);
  assert.strictEqual(validateAiMediaGenerationJobStatus("published"), false);
});

test("idempotency key validation refuses empty and over-long keys", () => {
  assert.strictEqual(validateAiMediaIdempotencyKey("  abc  "), "abc");
  assert.throws(() => validateAiMediaIdempotencyKey(""), /ai_media_idempotency_key_invalid/);
  assert.throws(() => validateAiMediaIdempotencyKey("x".repeat(201)), /ai_media_idempotency_key_invalid/);
});

test("AiMediaError exposes a stable code", () => {
  const error = new AiMediaError("ai_media_regeneration_locked");
  assert.strictEqual(error.code, "ai_media_regeneration_locked");
});

test("mapAiMediaOutputRow maps the canonical row shape", () => {
  const mapped = mapAiMediaOutputRow({
    id: "abc",
    place_id: "place-1",
    producer_id: "producer-1",
    output_key: "hook",
    storage_path: "outputs/place-1/hook-xyz.jpg",
    mime_type: "image/jpeg",
    byte_size: 1234,
    status: "draft",
    provider: "vendor-x",
    generated_at: "2026-10-06T00:00:00.000Z",
    approved_at: null,
    approved_by: null,
    approved_public_url: null,
  });
  assert.strictEqual(mapped.outputKey, "hook");
  assert.strictEqual(mapped.status, "draft");
  assert.strictEqual(mapped.byteSize, 1234);
  assert.strictEqual(mapped.provider, "vendor-x");
  assert.strictEqual(mapped.approvedPublicUrl, null);
});

// ===========================================================================
// Source contract — no fake generation, server-side authz, private media
// ===========================================================================

test("there is no client endpoint that persists a generated output", () => {
  // The outputs route is READ-ONLY: no POST/PUT exports.
  assert.doesNotMatch(outputsRoute, /export async function POST/);
  assert.doesNotMatch(outputsRoute, /export async function PUT/);
});

test("every AI media route is Producer-gated server-side", () => {
  for (const route of [sourcesListRoute, sourceUploadRoute, approveRoute, generateRoute, quotaRoute, genjobsRoute]) {
    assert.match(route, /requireProducerAccess/, "route must gate on Producer access");
  }
});

test("Generate Ulang is present but locked and not client-bypassable", () => {
  const code = stripComments(generateRoute);
  assert.match(code, /isAiMediaRegenerationUnlocked/);
  assert.match(code, /ai_media_regeneration_locked/);
  assert.match(code, /REGENERATION_OUTPUT_KEYS/);
  // The locked branch returns BEFORE any job insert.
  const lockedIndex = code.indexOf("ai_media_regeneration_locked");
  const rpcIndex = code.indexOf('rpc("regenerate_ai_media"');
  assert.ok(lockedIndex !== -1 && rpcIndex !== -1 && lockedIndex < rpcIndex, "locked check precedes the RPC");
});

test("no route hardcodes a provider or claims generation succeeded", () => {
  const all = [sourcesListRoute, sourceUploadRoute, outputsRoute, approveRoute, generateRoute].map(stripComments).join("\n");
  assert.doesNotMatch(all, /openai|gemini|replicate|stability|dall-?e/i);
  assert.doesNotMatch(all, /generated successfully/i);
});

test("source media is accessed only via signed URLs (never a public URL)", () => {
  assert.match(sourcesListRoute, /getSignedAiMediaUrl/);
  assert.doesNotMatch(sourcesListRoute, /object\/public\/ai-media-sources/);
  assert.match(storageModule, /createSignedUrl/);
  assert.match(storageModule, /ai-media-sources/);
});

test("approval promotes into the public bucket; generation never touches the cover", () => {
  assert.match(approveRoute, /promoteAiMediaOutputToPublic/);
  assert.match(approveRoute, /approve_ai_media_output/);
  // The outputs listing never writes cover_image_url.
  assert.doesNotMatch(outputsRoute, /cover_image_url/);
});

test("original source photos and outputs use separate tables/buckets", () => {
  assert.match(storageModule, /ai-media-sources/);
  assert.match(storageModule, /ai-media-outputs/);
  // The canonical photo slots bucket is never used for source media.
  assert.doesNotMatch(storageModule, /from\(PLACE_MEDIA_BUCKET\)\.upload/);
});

// ===========================================================================
// Migration source contract
// ===========================================================================

test("migration pins the locked keys, limits and statuses", () => {
  assert.match(migration, /source_key in \('place', 'material', 'process', 'result'\)/);
  assert.match(migration, /output_key in \('hook', 'place_story'\)/);
  assert.match(migration, /mime_type in \('image\/jpeg', 'image\/png', 'image\/webp', 'image\/avif'\)/);
  assert.match(migration, /byte_size > 0 and byte_size <= 5 \* 1024 \* 1024/);
  assert.match(migration, /status in \('draft', 'approved', 'rejected'\)/);
  assert.match(migration, /status in \('pending', 'queued', 'running', 'done', 'failed', 'locked'\)/);
});

test("migration keeps regeneration LOCKED by default", () => {
  assert.match(migration, /regeneration_enabled boolean not null default false/);
  assert.match(migration, /ai_media_regeneration_unlocked/);
  assert.match(migration, /raise exception 'ai_media_regeneration_locked'/);
  assert.match(migration, /'\{"outputs":\["hook","place_story"\],"regeneration":true\}'/);
});

test("migration creates private buckets for sources and outputs", () => {
  assert.match(migration, /'ai-media-sources',\s*'ai-media-sources',\s*false/);
  assert.match(migration, /'ai-media-outputs',\s*'ai-media-outputs',\s*false/);
});

test("migration locks every AI media table to server-only access", () => {
  for (const table of [
    "ai_media_sources",
    "ai_media",
    "ai_media_provider_config",
    "ai_media_quota",
    "ai_media_generation_jobs",
  ]) {
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from anon, authenticated`));
  }
});

test("migration revokes EXECUTE on all RPCs from clients", () => {
  for (const fn of [
    "upload_ai_media_source",
    "save_ai_media_output",
    "approve_ai_media_output",
    "regenerate_ai_media",
    "claim_ai_media_quota",
    "set_ai_media_quota",
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`),
    );
  }
});

test("migration makes no provider network call", () => {
  assert.doesNotMatch(migration, /http_post|http_get|net\.http/i);
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

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  for (const name of FOUNDATION) await db.exec(stripPgcrypto(readMigration(name)));
  await db.exec(stripPgcrypto(readMigration("0042_ai_place_media_foundation.sql")));
  return db;
}

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> => {
  const result = await db.query(query, params as never[]);
  return (result.rows ?? []) as Row[];
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER_A = uuid(1);
const USER_B = uuid(2);

const seedUser = (db: PGlite, id: string) =>
  db.exec(`insert into auth.users (id, email_confirmed_at) values ('${id}', now()) on conflict do nothing`);

const seedPlace = async (db: PGlite, id: string, producerId: string | null = null): Promise<void> => {
  await db.exec(`
    insert into public.places (id, name, short_description, category, type, area, timezone, currency)
    values ('${id}', 'Place ${id}', 'desc', 'Kuliner', 'production', 'Bandung', 'Asia/Jakarta', 'IDR')
    on conflict (id) do nothing;
  `);
  if (producerId) {
    await db.exec(`insert into public.producers (id, display_name) values ('${producerId}', 'P') on conflict do nothing`);
    await db.exec(`update public.places set producer_id = '${producerId}' where id = '${id}'`);
  }
};

const seedMembership = async (db: PGlite, placeId: string, producerId: string, userId: string, role = "owner") => {
  await db.exec(`insert into public.producers (id, display_name) values ('${producerId}', 'P') on conflict do nothing`);
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${userId}', '${producerId}', '${placeId}', '${role}')`,
  );
};

const uploadSource = (
  db: PGlite,
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

const saveOutput = (
  db: PGlite,
  placeId: string,
  producerId: string,
  key: string,
  path: string,
  mime = "image/jpeg",
  size = 2000,
) =>
  rows(db, "select public.save_ai_media_output($1, $2, $3, $4, $5, $6) as id", [
    placeId,
    producerId,
    key,
    path,
    mime,
    size,
  ]);

const approveOutput = (
  db: PGlite,
  userId: string | null,
  placeId: string,
  producerId: string,
  key: string,
  status: string,
  publicUrl: string | null = null,
) =>
  rows(db, "select public.approve_ai_media_output($1, $2, $3, $4, $5, $6) as ok", [
    userId,
    placeId,
    producerId,
    key,
    status,
    publicUrl,
  ]);

const coverOf = async (db: PGlite, placeId: string): Promise<string | null> => {
  const result = await rows(db, "select cover_image_url from public.places where id = $1", [placeId]);
  return (result[0]?.cover_image_url ?? null) as string | null;
};

const outputRow = async (db: PGlite, placeId: string, key: string): Promise<Row | undefined> =>
  (await rows(db, "select * from public.ai_media where place_id = $1 and output_key = $2", [placeId, key]))[0];

test("PGlite: a member can upload a source; it is keyed and idempotently replaced", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await uploadSource(db, USER_A, "place-a", "producer-a", "place", "sources/place-a/place-1.jpg");
    await uploadSource(db, USER_A, "place-a", "producer-a", "place", "sources/place-a/place-2.jpg");

    const all = await rows(db, "select * from public.ai_media_sources where place_id = 'place-a'");
    assert.equal(all.length, 1, "one row per (place, producer, source_key)");
    assert.equal(all[0].storage_path, "sources/place-a/place-2.jpg", "the slot was replaced");
  } finally {
    await db.close();
  }
});

test("PGlite: source upload is refused without membership (Producer-account bound)", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedUser(db, USER_B);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_B);

    await assert.rejects(
      () => uploadSource(db, USER_A, "place-a", "producer-a", "place", "sources/place-a/place-1.jpg"),
      /producer_authorization_required/,
    );
    assert.equal((await rows(db, "select * from public.ai_media_sources")).length, 0);
  } finally {
    await db.close();
  }
});

test("PGlite: source key / mime / size contract is enforced by the database", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await assert.rejects(
      () => uploadSource(db, USER_A, "place-a", "producer-a", "hook", "sources/place-a/x.jpg"),
      /ai_media_source_key_invalid/,
    );
    await assert.rejects(
      () => uploadSource(db, USER_A, "place-a", "producer-a", "place", "sources/place-a/x.gif", "image/gif"),
      /ai_media_source_type_invalid/,
    );
    await assert.rejects(
      () => uploadSource(db, USER_A, "place-a", "producer-a", "place", "sources/place-a/x.jpg", "image/jpeg", 6 * 1024 * 1024),
      /ai_media_source_size_invalid/,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: generated output is persisted as DRAFT and never self-publishes", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await saveOutput(db, "place-a", "producer-a", "hook", "outputs/place-a/hook-1.jpg", "image/jpeg", 3000);
    const hook = await outputRow(db, "place-a", "hook");
    assert.equal(hook?.status, "draft", "generation only ever produces a draft");
    assert.equal(await coverOf(db, "place-a"), null, "generation never touches the Place cover");
  } finally {
    await db.close();
  }
});

test("PGlite: re-saving an output resets it to draft and clears prior approval", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await saveOutput(db, "place-a", "producer-a", "hook", "outputs/place-a/hook-1.jpg");
    await approveOutput(db, USER_A, "place-a", "producer-a", "hook", "approved", "https://cdn.example.com/hook-1.jpg");

    await saveOutput(db, "place-a", "producer-a", "hook", "outputs/place-a/hook-2.jpg");
    const hook = await outputRow(db, "place-a", "hook");
    assert.equal(hook?.status, "draft");
    assert.equal(hook?.approved_public_url, null);
  } finally {
    await db.close();
  }
});

test("PGlite: approving the hook sets the canonical cover; place_story approval does not", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await saveOutput(db, "place-a", "producer-a", "place_story", "outputs/place-a/story-1.jpg");
    await approveOutput(db, USER_A, "place-a", "producer-a", "place_story", "approved", "https://cdn.example.com/story-1.jpg");
    assert.equal(await coverOf(db, "place-a"), null, "place_story approval never writes the cover");

    await saveOutput(db, "place-a", "producer-a", "hook", "outputs/place-a/hook-1.jpg");
    await approveOutput(db, USER_A, "place-a", "producer-a", "hook", "approved", "https://cdn.example.com/hook-1.jpg");
    assert.equal(await coverOf(db, "place-a"), "https://cdn.example.com/hook-1.jpg");
    const hook = await outputRow(db, "place-a", "hook");
    assert.equal(hook?.status, "approved");
    assert.equal(hook?.approved_public_url, "https://cdn.example.com/hook-1.jpg");
  } finally {
    await db.close();
  }
});

test("PGlite: approval requires a real https public URL and refuses non-draft", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await saveOutput(db, "place-a", "producer-a", "hook", "outputs/place-a/hook-1.jpg");
    await assert.rejects(
      () => approveOutput(db, USER_A, "place-a", "producer-a", "hook", "approved", "http://insecure.example.com/x.jpg"),
      /ai_media_output_public_url_invalid/,
    );
    await assert.rejects(
      () => approveOutput(db, USER_A, "place-a", "producer-a", "hook", "approved", null),
      /ai_media_output_public_url_invalid/,
    );
    assert.equal(await coverOf(db, "place-a"), null, "a refused approval never publishes");

    await approveOutput(db, USER_A, "place-a", "producer-a", "hook", "approved", "https://cdn.example.com/hook-1.jpg");
    await assert.rejects(
      () => approveOutput(db, USER_A, "place-a", "producer-a", "hook", "approved", "https://cdn.example.com/hook-2.jpg"),
      /ai_media_output_not_draft/,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: rejection never publishes and never touches the cover", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await saveOutput(db, "place-a", "producer-a", "hook", "outputs/place-a/hook-1.jpg");
    await approveOutput(db, USER_A, "place-a", "producer-a", "hook", "rejected");
    const hook = await outputRow(db, "place-a", "hook");
    assert.equal(hook?.status, "rejected");
    assert.equal(await coverOf(db, "place-a"), null);
  } finally {
    await db.close();
  }
});

test("PGlite: only owner/manager may approve (editor is refused)", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A, "editor");

    await saveOutput(db, "place-a", "producer-a", "hook", "outputs/place-a/hook-1.jpg");
    await assert.rejects(
      () => approveOutput(db, USER_A, "place-a", "producer-a", "hook", "approved", "https://cdn.example.com/hook-1.jpg"),
      /producer_authorization_required/,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: Generate Ulang is locked by server config and cannot be bypassed", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    const regenerate = () =>
      rows(db, "select public.regenerate_ai_media($1, $2, $3, $4) as id", [
        USER_A,
        "place-a",
        "producer-a",
        "req-1",
      ]);

    await assert.rejects(() => regenerate(), /ai_media_regeneration_locked/);
    assert.equal((await rows(db, "select * from public.ai_media_generation_jobs")).length, 0);

    // Admin unlocks via server-owned config.
    await db.exec(`
      insert into public.ai_media_provider_config (id, provider, regeneration_enabled)
      values ('primary', 'vendor-x', true)
      on conflict (id) do update set regeneration_enabled = true;
    `);

    await regenerate();
    const job = (await rows(db, "select * from public.ai_media_generation_jobs"))[0];
    assert.equal(job.kind, "regeneration");
    assert.deepStrictEqual((job.detail as { outputs: string[] }).outputs, ["hook", "place_story"]);
  } finally {
    await db.close();
  }
});

test("PGlite: quota is fail-closed and decrements on claim", async () => {
  const db = await bootstrapDb();
  try {
    await seedPlace(db, "place-a", "producer-a");

    // No quota row → refused.
    await assert.rejects(
      () => rows(db, "select public.claim_ai_media_quota($1, $2) as ok", ["producer-a", 10]),
      /ai_media_quota_exhausted/,
    );

    await db.exec("select public.set_ai_media_quota('producer-a', 25)");
    await rows(db, "select public.claim_ai_media_quota($1, $2) as ok", ["producer-a", 10]);
    const after = (await rows(db, "select * from public.ai_media_quota where producer_id = 'producer-a'"))[0];
    assert.equal(after.used_tokens, 10);

    await assert.rejects(
      () => rows(db, "select public.claim_ai_media_quota($1, $2) as ok", ["producer-a", 100]),
      /ai_media_quota_exhausted/,
    );
  } finally {
    await db.close();
  }
});

test("PGlite: both AI media buckets are private", async () => {
  const db = await bootstrapDb();
  try {
    const buckets = await rows(db, "select id, public from storage.buckets where id like 'ai-media-%' order by id");
    assert.deepStrictEqual(
      buckets.map((b) => ({ id: b.id, public: b.public })),
      [
        { id: "ai-media-outputs", public: false },
        { id: "ai-media-sources", public: false },
      ],
    );
  } finally {
    await db.close();
  }
});

test("PGlite: save_ai_media_output pins output objects to the Place folder", async () => {
  const db = await bootstrapDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-a", "producer-a");
    await seedMembership(db, "place-a", "producer-a", USER_A);

    await assert.rejects(
      () => saveOutput(db, "place-a", "producer-a", "hook", "outputs/other-place/hook-1.jpg"),
      /ai_media_output_upload_failed/,
    );
  } finally {
    await db.close();
  }
});
