import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

import {
  AI_MEDIA_AUDIT_ACTIONS,
  AI_MEDIA_AUDIT_TARGET_TYPES,
  validateAiMediaAuditAction,
  validateAiMediaAuditTargetType,
} from "@/lib/ai-media";

/**
 * AI PLACE MEDIA — append-only audit trail (migration 0043).
 *
 * 0042 gave AI Place Media its sources, drafts, quota and locked regeneration
 * gate, but left a Producer's ACTIONS with no durable, attributable record.
 * This suite proves the trail that closes that gap, at three levels:
 *  1. DATABASE (real Postgres via PGlite over the actual chain): the trail is
 *     append-only, also orphan-proof, and unreachable by any client role; the
 *     server-only RPC validates the action vocabulary and the actor.
 *  2. CONTRACT: the code vocabulary is exactly the database vocabulary.
 *  3. WIRING: every meaningful Producer action records an entry, attributed to
 *     the SESSION account, best-effort so it never rolls back a valid change.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const readWeb = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = readMigration("0043_ai_media_audit.sql");
const auditModule = readWeb("lib/ai-media-audit.ts");
const sourcesRoute = readWeb("app/api/producer/places/[placeId]/ai-media/sources/[sourceKey]/route.ts");
const approveRoute = readWeb("app/api/producer/places/[placeId]/ai-media/approve/route.ts");
const generateRoute = readWeb("app/api/producer/places/[placeId]/ai-media/generate-ulg/route.ts");

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
// PGlite harness — the real chain, plus 0042 then 0043.
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
const ACTOR = uuid(41);

async function seedFixture(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email_confirmed_at) values ('${ACTOR}', now());
    insert into public.users (id) values ('${ACTOR}') on conflict do nothing;
    insert into public.producers (id, display_name) values ('audit-producer', 'Audit Producer');
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id, publication_status)
    values ('audit-place', 'Tempat Audit AI', 'd', 'Kuliner', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', 'audit-producer', 'draft');
  `);
}

// ---------------------------------------------------------------------------
// 1. Database semantics
// ---------------------------------------------------------------------------

test("migration 0043 creates a server-only ai_media_audit table", async () => {
  const db = await bootstrapDb();
  try {
    const columns = await rows(
      db,
      "select column_name, is_nullable, data_type from information_schema.columns where table_schema='public' and table_name='ai_media_audit'",
    );
    const byName = Object.fromEntries(columns.map((c) => [String(c.column_name), c]));
    for (const required of ["place_id", "actor_id", "action", "target_type", "target_key", "job_id", "detail", "created_at"]) {
      assert.ok(byName[required], `ai_media_audit must have a ${required} column`);
    }
    assert.equal(byName.place_id.is_nullable, "NO");
    assert.equal(byName.actor_id.is_nullable, "NO");
    assert.equal(byName.action.is_nullable, "NO");
    assert.equal(byName.detail.data_type, "jsonb");

    const rls = await rows(db, "select relrowsecurity from pg_class where oid = 'public.ai_media_audit'::regclass");
    assert.equal(rls[0].relrowsecurity, true, "RLS must be enabled");
    const policies = await rows(
      db,
      "select count(*)::int as c from pg_policies where schemaname='public' and tablename='ai_media_audit'",
    );
    assert.equal(policies[0].c, 0, "the trail must have zero policies (fail closed)");
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const check = await rows(db, `select has_table_privilege('${role}', 'public.ai_media_audit', '${privilege}') as ok`);
        assert.equal(check[0].ok, false, `${role} must not have ${privilege} on ai_media_audit`);
      }
    }
  } finally {
    await db.close();
  }
});

test("the audit trail is append-only — UPDATE and DELETE are refused for every writer", async () => {
  const db = await bootstrapDb();
  try {
    await seedFixture(db);
    await db.exec(`
      insert into public.ai_media_audit (place_id, producer_id, actor_id, action)
      values ('audit-place', 'audit-producer', '${ACTOR}', 'ai_source_uploaded');
    `);
    await assert.rejects(db.exec(`update public.ai_media_audit set action = 'ai_output_approved'`), /append-only/);
    await assert.rejects(db.exec("delete from public.ai_media_audit"), /append-only/);
    const remaining = await rows(db, "select action from public.ai_media_audit");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].action, "ai_source_uploaded");
  } finally {
    await db.close();
  }
});

test("a trail entry cannot outlive or detach from its Place or its actor", async () => {
  const db = await bootstrapDb();
  try {
    await seedFixture(db);
    await assert.rejects(
      () =>
        db.exec(`insert into public.ai_media_audit (place_id, actor_id, action)
                 values ('tempat-hantu', '${ACTOR}', 'ai_source_uploaded')`),
      /violates foreign key constraint/,
    );
    await assert.rejects(
      () =>
        db.exec(`insert into public.ai_media_audit (place_id, actor_id, action)
                 values ('audit-place', '${uuid(99)}', 'ai_source_uploaded')`),
      /violates foreign key constraint/,
    );
    await assert.rejects(
      () =>
        db.exec(`insert into public.ai_media_audit (place_id, actor_id, action)
                 values ('audit-place', '${ACTOR}', 'ai_made_up_action')`),
      /violates check constraint/,
    );
    await db.exec(`insert into public.ai_media_audit (place_id, actor_id, action) values ('audit-place', '${ACTOR}', 'ai_output_approved')`);
    // The Place (and the actor) cannot be deleted out from under the trail.
    await assert.rejects(db.exec(`delete from public.places where id = 'audit-place'`), /ai_media_audit_place_id_fkey/);
    await assert.rejects(db.exec(`delete from public.users where id = '${ACTOR}'`), /ai_media_audit_actor_id_fkey/);
  } finally {
    await db.close();
  }
});

test("the server-only RPC validates the actor, the place and the action vocabulary", async () => {
  const db = await bootstrapDb();
  try {
    await seedFixture(db);
    const inserted = await rows(
      db,
      `select public.record_ai_media_audit('audit-place', '${ACTOR}', 'ai_output_approved') as id`,
    );
    assert.ok(inserted[0].id, "a valid audited action returns the new row id");

    await assert.rejects(
      () => db.exec(`select public.record_ai_media_audit('audit-place', null, 'ai_output_approved')`),
      /ai_media_audit_actor_required/,
    );
    await assert.rejects(
      () => db.exec(`select public.record_ai_media_audit('audit-place', '${ACTOR}', 'ai_not_a_real_action')`),
      /ai_media_audit_action_invalid/,
    );
    await assert.rejects(
      () => db.exec(`select public.record_ai_media_audit('tempat-hantu', '${ACTOR}', 'ai_output_approved')`),
      /ai_media_audit_place_not_found/,
    );
    // The RPC is server-only: no client role may execute it.
    for (const role of ["anon", "authenticated"]) {
      const check = await rows(
        db,
        `select has_function_privilege('${role}', 'public.record_ai_media_audit(text, uuid, text, text, text, text, uuid, jsonb)', 'execute') as ok`,
      );
      assert.equal(check[0].ok, false, `${role} must not execute record_ai_media_audit`);
    }
  } finally {
    await db.close();
  }
});

test("migration 0043 is idempotent and additive", async () => {
  const bare = stripComments(migration);
  assert.match(migration, /create table if not exists public\.ai_media_audit/);
  assert.match(migration, /create or replace function public\.record_ai_media_audit/);
  assert.match(migration, /drop trigger if exists ai_media_audit_block_mutation/);
  assert.match(migration, /alter table public\.ai_media_audit enable row level security/);
  assert.match(migration, /revoke all on public\.ai_media_audit from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.record_ai_media_audit[\s\S]*from public, anon, authenticated/);
  for (const table of ["places", "producers", "users", "producer_memberships", "ai_media", "ai_media_sources"]) {
    assert.doesNotMatch(bare, new RegExp(`alter\\s+table\\s+public\\.${table}\\b`, "i"));
  }
  assert.doesNotMatch(bare, /\bdrop\s+table\b/i);
  assert.doesNotMatch(bare, /\bdelete\s+from\b/i);

  // Re-applying the file is a no-op on the engine.
  const db = await bootstrapDb();
  try {
    await db.exec(stripPgcrypto(migration));
    const count = await rows(db, "select count(*)::int as c from information_schema.tables where table_schema='public' and table_name='ai_media_audit'");
    assert.equal(count[0].c, 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Vocabulary parity (code == database)
// ---------------------------------------------------------------------------

test("the code audit vocabulary is exactly the database CHECK vocabulary", () => {
  const codeActions = Object.values(AI_MEDIA_AUDIT_ACTIONS).sort();

  // The table CHECK and the RPC guard are the two places the vocabulary is
  // pinned in the database; both must match the code exactly.
  const checkStart = migration.indexOf("action text not null check (action in (");
  assert.ok(checkStart > -1, "the table must CHECK the action vocabulary");
  const checkBlock = migration.slice(checkStart, migration.indexOf("))", checkStart));
  const checkActions = [...checkBlock.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(checkActions, codeActions, "the table CHECK must match the code vocabulary");

  const rpcStart = migration.indexOf("if p_action is null or p_action not in (");
  assert.ok(rpcStart > -1, "the RPC must re-validate the action vocabulary");
  const rpcBlock = migration.slice(rpcStart, migration.indexOf(") then", rpcStart));
  const rpcActions = [...rpcBlock.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(rpcActions, codeActions, "the RPC guard must match the code vocabulary");

  for (const action of codeActions) assert.equal(validateAiMediaAuditAction(action), true);
  assert.equal(validateAiMediaAuditAction("ai_not_a_real_action"), false);
});

test("the audit target vocabulary matches the database CHECK", () => {
  for (const target of AI_MEDIA_AUDIT_TARGET_TYPES) {
    assert.match(migration, new RegExp(`'${target}'`), `migration must accept target ${target}`);
    assert.equal(validateAiMediaAuditTargetType(target), true);
  }
  assert.equal(validateAiMediaAuditTargetType("shopping-cart"), false);
});

// ---------------------------------------------------------------------------
// 3. Server wiring
// ---------------------------------------------------------------------------

test("the audit writer is server-only and never rolls back a valid action", () => {
  assert.match(auditModule, /^import "server-only";/m);
  const code = stripComments(auditModule);
  // Attribution can only come from the caller's session id.
  assert.match(code, /actorId: string/);
  // Best-effort: a failure is logged and reported, never thrown.
  assert.match(code, /console\.error/);
  assert.match(code, /recorded: false/);
  assert.doesNotMatch(code, /throw new Error\("ai_media_audit/);
  // It talks to the database only through the server-only RPC.
  assert.match(code, /\.rpc\("record_ai_media_audit"/);
  assert.doesNotMatch(code, /from\("ai_media_audit"\)/);
});

test("every meaningful Producer action writes an attributable audit entry", () => {
  const sources = stripComments(sourcesRoute);
  assert.match(sources, /recordAiMediaAudit\(\{/);
  assert.match(sources, /action: AI_MEDIA_AUDIT_ACTIONS\.sourceUploaded/);
  assert.match(sources, /actorId: actor\.userId/);
  assert.match(sources, /producerId: access\.producerId/);

  const approve = stripComments(approveRoute);
  assert.match(approve, /recordAiMediaAudit\(\{/);
  assert.match(approve, /AI_MEDIA_AUDIT_ACTIONS\.outputApproved/);
  assert.match(approve, /AI_MEDIA_AUDIT_ACTIONS\.outputRejected/);
  assert.match(approve, /actorId: actor\.userId/);

  const generate = stripComments(generateRoute);
  assert.match(generate, /recordAiMediaAudit\(\{/);
  assert.match(generate, /AI_MEDIA_AUDIT_ACTIONS\.regenerationBlocked/);
  assert.match(generate, /actorId: actor\.userId/);
  // The blocked attempt is recorded BEFORE the refusal is returned.
  const blocked = generate.indexOf("AI_MEDIA_AUDIT_ACTIONS.regenerationBlocked");
  const refuse = generate.indexOf('error: "ai_media_regeneration_locked"');
  assert.ok(blocked > -1 && refuse > blocked, "the blocked attempt must be recorded before the refusal");
});

test("the actor is never taken from the request body", () => {
  for (const source of [sourcesRoute, approveRoute, generateRoute]) {
    assert.doesNotMatch(stripComments(source), /body\.(actorId|userId|actor_id|user_id)/);
  }
});
