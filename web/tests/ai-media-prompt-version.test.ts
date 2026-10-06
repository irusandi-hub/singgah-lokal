import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

import {
  AI_MEDIA_CURRENT_PROMPT_VERSION,
  AI_MEDIA_GENERATION_KINDS,
  AI_MEDIA_PROMPT_KEYS,
  AI_MEDIA_PROMPT_KEYS_BY_OUTPUT,
  PLACE_AI_REGENERATE_UNLOCKED,
  buildAiMediaRequestMetadata,
  isAiMediaRegenerationUnlocked,
  validateAiMediaPromptKey,
  validateAiMediaPromptVersion,
} from "@/lib/ai-media";

/**
 * AI PLACE MEDIA — prompt/version tracking + request metadata (migration 0044).
 *
 * A generated image is only explainable if the record says WHICH prompt
 * revision produced it. This suite proves that record at three levels:
 *  1. DATABASE (real Postgres via PGlite over the actual chain): the columns and
 *     their bounds exist on both the artifact and the request, and the
 *     server-only worker RPC annotates them without being client-reachable.
 *  2. CONTRACT: the prompt vocabulary/version validators and the request
 *     metadata builder, plus the LOCKED regeneration constant named by the
 *     locked product design.
 *  3. WIRING: the worker writer is server-only and performs no generation.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const readWeb = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = readMigration("0044_ai_media_prompt_version.sql");
const generationModule = readWeb("lib/ai-media-generation.ts");
const contractModule = readWeb("lib/ai-media.ts");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// PGlite harness — the real chain through 0044.
// ---------------------------------------------------------------------------

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
  "0042_ai_place_media_foundation.sql",
  "0043_ai_media_audit.sql",
  "0044_ai_media_prompt_version.sql",
] as const;

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  for (const name of FOUNDATION) await db.exec(stripPgcrypto(readMigration(name)));
  return db;
}

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> => {
  const result = await db.query(query);
  return (result.rows ?? []) as Row[];
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOB_ID = uuid(11);
const ACTOR = uuid(12);

async function seedFixture(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email_confirmed_at) values ('${ACTOR}', now());
    insert into public.users (id) values ('${ACTOR}') on conflict do nothing;
    insert into public.producers (id, display_name) values ('pv-producer', 'PV Producer');
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id, publication_status)
    values ('pv-place', 'Tempat Prompt Version', 'd', 'Kuliner', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', 'pv-producer', 'draft');
    insert into public.ai_media_generation_jobs (id, place_id, producer_id, idempotency_key, kind, status)
    values ('${JOB_ID}', 'pv-place', 'pv-producer', 'idem-pv', 'regeneration', 'queued');
    insert into public.ai_media (place_id, producer_id, output_key, storage_path, mime_type, byte_size, status)
    values ('pv-place', 'pv-producer', 'hook', 'outputs/pv-place/hook-1.png', 'image/png', 1024, 'draft');
  `);
}

// ---------------------------------------------------------------------------
// 1. Database semantics
// ---------------------------------------------------------------------------

test("migration 0044 adds prompt/version + request metadata to both records", async () => {
  const db = await bootstrapDb();
  try {
    for (const table of ["ai_media", "ai_media_generation_jobs"]) {
      const columns = await rows(
        db,
        `select column_name, is_nullable, data_type, column_default from information_schema.columns where table_schema='public' and table_name='${table}'`,
      );
      const byName = Object.fromEntries(columns.map((c) => [String(c.column_name), c]));
      for (const required of ["prompt_key", "prompt_version", "request_metadata"]) {
        assert.ok(byName[required], `${table} must have a ${required} column`);
      }
      assert.equal(byName.request_metadata.is_nullable, "NO", `${table}.request_metadata must be NOT NULL`);
      assert.equal(byName.request_metadata.data_type, "jsonb");
      assert.match(String(byName.request_metadata.column_default), /'\{\}'/);
      // A prompt revision is optional until a real generation exists.
      assert.equal(byName.prompt_key.is_nullable, "YES");
      assert.equal(byName.prompt_version.is_nullable, "YES");
    }
  } finally {
    await db.close();
  }
});

test("the prompt_key and prompt_version bounds are enforced by the database", async () => {
  const db = await bootstrapDb();
  try {
    await seedFixture(db);
    await assert.rejects(
      () => db.exec(`update public.ai_media set prompt_version = 0 where place_id = 'pv-place'`),
      /violates check constraint/,
    );
    await assert.rejects(
      () => db.exec(`update public.ai_media set prompt_version = -3 where place_id = 'pv-place'`),
      /violates check constraint/,
    );
    await assert.rejects(
      () => db.exec(`update public.ai_media set prompt_key = '' where place_id = 'pv-place'`),
      /violates check constraint/,
    );
    await assert.rejects(
      () => db.exec(`update public.ai_media_generation_jobs set prompt_key = '${"a".repeat(81)}' where id = '${JOB_ID}'`),
      /violates check constraint/,
    );
    // A valid revision and a null revision are both acceptable.
    await db.exec(`update public.ai_media set prompt_key = 'place_hook_image', prompt_version = 1 where place_id = 'pv-place'`);
    const stored = await rows(db, `select prompt_key, prompt_version, request_metadata from public.ai_media where place_id = 'pv-place'`);
    assert.equal(stored[0].prompt_key, "place_hook_image");
    assert.equal(Number(stored[0].prompt_version), 1);
    assert.deepEqual(stored[0].request_metadata, {});
  } finally {
    await db.close();
  }
});

test("the server-only worker RPC annotates a job and/or an output", async () => {
  const db = await bootstrapDb();
  try {
    await seedFixture(db);

    await db.exec(
      `select public.record_ai_media_generation_metadata('${JOB_ID}', null, null, null, 'place_story_image', 1, '{"generationKind":"regeneration"}')`,
    );
    const job = await rows(db, `select prompt_key, prompt_version, request_metadata from public.ai_media_generation_jobs where id = '${JOB_ID}'`);
    assert.equal(job[0].prompt_key, "place_story_image");
    assert.equal(Number(job[0].prompt_version), 1);
    assert.deepEqual(job[0].request_metadata, { generationKind: "regeneration" });

    await db.exec(
      `select public.record_ai_media_generation_metadata(null, 'pv-place', 'pv-producer', 'hook', 'place_hook_image', 2, '{"generationKind":"initial"}')`,
    );
    const output = await rows(db, `select prompt_key, prompt_version, request_metadata from public.ai_media where place_id = 'pv-place' and output_key = 'hook'`);
    assert.equal(output[0].prompt_key, "place_hook_image");
    assert.equal(Number(output[0].prompt_version), 2);
    assert.deepEqual(output[0].request_metadata, { generationKind: "initial" });

    // Fail-closed guards.
    await assert.rejects(
      () => db.exec("select public.record_ai_media_generation_metadata(null, null, null, null, null, null, '{}')"),
      /ai_media_generation_metadata_target_required/,
    );
    await assert.rejects(
      () => db.exec(`select public.record_ai_media_generation_metadata('${JOB_ID}', null, null, null, 'x', 0, '{}')`),
      /ai_media_prompt_version_invalid/,
    );
    await assert.rejects(
      () => db.exec(`select public.record_ai_media_generation_metadata(null, 'pv-place', 'pv-producer', 'cover', 'x', 1, '{}')`),
      /ai_media_output_key_invalid/,
    );
    await assert.rejects(
      () => db.exec(`select public.record_ai_media_generation_metadata('${uuid(77)}', null, null, null, 'x', 1, '{}')`),
      /ai_media_generation_metadata_job_not_found/,
    );
    await assert.rejects(
      () => db.exec(`select public.record_ai_media_generation_metadata(null, 'pv-place', 'pv-producer', 'place_story', 'x', 1, '{}')`),
      /ai_media_generation_metadata_output_not_found/,
    );

    // Server-only: no client role may execute it.
    for (const role of ["anon", "authenticated"]) {
      const check = await rows(
        db,
        `select has_function_privilege('${role}', 'public.record_ai_media_generation_metadata(uuid, text, text, text, text, integer, jsonb)', 'execute') as ok`,
      );
      assert.equal(check[0].ok, false, `${role} must not execute record_ai_media_generation_metadata`);
    }
  } finally {
    await db.close();
  }
});

test("migration 0044 is idempotent and additive", async () => {
  const bare = stripComments(migration);
  assert.match(migration, /alter table public\.ai_media\s+add column if not exists prompt_key/);
  assert.match(migration, /alter table public\.ai_media_generation_jobs\s+add column if not exists request_metadata/);
  assert.match(migration, /create or replace function public\.record_ai_media_generation_metadata/);
  assert.match(migration, /revoke all on function public\.record_ai_media_generation_metadata[\s\S]*from public, anon, authenticated/);
  // Additive only: no table is dropped, no existing function is replaced, no row
  // is deleted, and the existing prompt-free columns are untouched.
  assert.doesNotMatch(bare, /\bdrop\s+table\b/i);
  assert.doesNotMatch(bare, /\bdelete\s+from\b/i);
  for (const fn of ["save_ai_media_output", "approve_ai_media_output", "regenerate_ai_media", "upload_ai_media_source"]) {
    assert.doesNotMatch(bare, new RegExp(`create or replace function public\\.${fn}\\b`, "i"));
  }

  const db = await bootstrapDb();
  try {
    await db.exec(stripPgcrypto(migration));
    const count = await rows(
      db,
      "select count(*)::int as c from information_schema.columns where table_schema='public' and table_name='ai_media' and column_name in ('prompt_key','prompt_version','request_metadata')",
    );
    assert.equal(count[0].c, 3);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Contract
// ---------------------------------------------------------------------------

test("the regeneration lock constant is named and LOCKED by default", () => {
  assert.equal(PLACE_AI_REGENERATE_UNLOCKED, false);
  assert.equal(isAiMediaRegenerationUnlocked(), PLACE_AI_REGENERATE_UNLOCKED);
  assert.match(stripComments(contractModule), /PLACE_AI_REGENERATE_UNLOCKED = false;/);
  assert.doesNotMatch(stripComments(contractModule), /PLACE_AI_REGENERATE_UNLOCKED = true/);
});

test("the prompt vocabulary maps 1:1 to the two outputs and validators are bounded", () => {
  assert.deepEqual(Object.keys(AI_MEDIA_PROMPT_KEYS_BY_OUTPUT).sort(), ["hook", "place_story"]);
  assert.equal(AI_MEDIA_PROMPT_KEYS_BY_OUTPUT.hook, AI_MEDIA_PROMPT_KEYS.hook);
  assert.equal(AI_MEDIA_PROMPT_KEYS_BY_OUTPUT.place_story, AI_MEDIA_PROMPT_KEYS.placeStory);
  assert.ok(validateAiMediaPromptKey("place_hook_image"));
  assert.equal(validateAiMediaPromptKey(""), false);
  assert.equal(validateAiMediaPromptKey("a".repeat(81)), false);
  assert.ok(validateAiMediaPromptVersion(AI_MEDIA_CURRENT_PROMPT_VERSION));
  assert.equal(validateAiMediaPromptVersion(0), false);
  assert.equal(validateAiMediaPromptVersion(1.5), false);
  assert.deepEqual([...AI_MEDIA_GENERATION_KINDS], ["initial", "regeneration"]);
});

test("the request metadata builder is provider-neutral and names no facts", () => {
  const metadata = buildAiMediaRequestMetadata({
    generationKind: "regeneration",
    outputKeys: ["hook", "place_story"],
    promptVersion: 1,
    requestedAt: "2026-10-06T00:00:00.000Z",
  });
  assert.deepEqual(metadata, {
    generationKind: "regeneration",
    outputKeys: ["hook", "place_story"],
    promptKeys: ["place_hook_image", "place_story_image"],
    promptVersion: 1,
    requestedAt: "2026-10-06T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(metadata), /openai|anthropic|gemini|replicate|stability/i);
  assert.throws(
    () => buildAiMediaRequestMetadata({ generationKind: "initial", outputKeys: ["hook"], promptVersion: 0, requestedAt: "x" }),
    /ai_media_prompt_version_invalid/,
  );
});

// ---------------------------------------------------------------------------
// 3. Server wiring
// ---------------------------------------------------------------------------

test("the generation metadata writer is server-only and performs no generation", () => {
  assert.match(generationModule, /^import "server-only";/m);
  const code = stripComments(generationModule);
  assert.match(code, /\.rpc\("record_ai_media_generation_metadata"/);
  // No provider call and no fake generation anywhere in this writer.
  assert.doesNotMatch(code, /fetch\(|generate\(|provider/i);
  // Invalid input is refused, never persisted.
  assert.match(code, /recorded: false/);
  assert.doesNotMatch(code, /throw new Error\("ai_media_generation_metadata/);
});
