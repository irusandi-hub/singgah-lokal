import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Migration syntax/execution validity (SQL-Editor apply path).
 *
 * Verifies that every migration — including 0008_live_sessions.sql — is valid
 * PostgreSQL that applies cleanly, in order, on a real Postgres engine
 * (PGlite = WASM build of the actual Postgres server), exactly as the
 * DEVELOPMENT apply runbook executes it (single whole-file paste).
 *
 * This is the regression guard the apply runbook (docs/runbooks/
 * LIVE_MIGRATION_APPLY_CHECKLIST.md) depends on: a migration that cannot
 * parse/execute must fail here, never in the Supabase SQL Editor.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const MIGRATIONS = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0013_live_rpc_privilege_lockdown.sql",
  "0015_creator_session_lease.sql",
];

const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");

// PGlite does not bundle the pgcrypto extension (on Supabase, 0001 creates it);
// the only symbol the migrations take from pgcrypto is gen_random_uuid(),
// which is core PostgreSQL since 13.
const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

// ---------------------------------------------------------------------------
// Dollar-quote-aware lexical scan (no engine needed).
// Tracks: line comments, nested block comments, single/double quotes with
// doubling, and $tag$ ... $tag$ dollar-quoted regions (PG lexical rules).
// ---------------------------------------------------------------------------
type DollarRegion = { tag: string; openIndex: number; closeIndex: number };

function scanDollarQuotes(sql: string): { regions: DollarRegion[]; unterminated: number | null } {
  const regions: DollarRegion[] = [];
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let blockDepth = 0;
  let dollarTag: string | null = null;
  let dollarOpen = -1;
  const isTagChar = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === "/" && next === "*") { blockDepth++; i += 2; continue; }
      if (c === "*" && next === "/") {
        blockDepth--;
        i += 2;
        if (blockDepth === 0) inBlockComment = false;
        continue;
      }
      i++;
      continue;
    }
    if (inSingle) {
      if (c === "'") {
        if (next === "'") { i += 2; continue; }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        if (next === '"') { i += 2; continue; }
        inDouble = false;
      }
      i++;
      continue;
    }
    if (dollarTag !== null) {
      if (c === "$") {
        let j = i + 1;
        let tag = "";
        while (j < sql.length && isTagChar(sql[j])) { tag += sql[j]; j++; }
        if (j < sql.length && sql[j] === "$" && tag === dollarTag) {
          regions.push({ tag: dollarTag, openIndex: dollarOpen, closeIndex: j });
          dollarTag = null;
          i = j + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === "-" && next === "-") { inLineComment = true; i += 2; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; blockDepth = 1; i += 2; continue; }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === "$") {
      let j = i + 1;
      let tag = "";
      while (j < sql.length && isTagChar(sql[j])) { tag += sql[j]; j++; }
      if (j < sql.length && sql[j] === "$") {
        dollarTag = tag;
        dollarOpen = i;
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { regions, unterminated: dollarTag !== null ? dollarOpen : null };
}

// Top-level statement boundaries: split on ';' outside quotes/comments/dollar
// regions, then verify parentheses balance per statement (outside those same
// regions). Catches the classic SQL-Editor failure modes: an unterminated
// $$ body swallowing every later statement, or an unbalanced paren.
function topLevelStatementTexts(sql: string): string[] {
  const statements: string[] = [];
  let stmtStart = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let blockDepth = 0;
  let dollarTag: string | null = null;
  const isTagChar = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) { if (c === "\n") inLineComment = false; i++; continue; }
    if (inBlockComment) {
      if (c === "/" && next === "*") { blockDepth++; i += 2; continue; }
      if (c === "*" && next === "/") { blockDepth--; i += 2; if (blockDepth === 0) inBlockComment = false; continue; }
      i++;
      continue;
    }
    if (inSingle) {
      if (c === "'") { if (next === "'") { i += 2; continue; } inSingle = false; }
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '"') { if (next === '"') { i += 2; continue; } inDouble = false; }
      i++;
      continue;
    }
    if (dollarTag !== null) {
      if (c === "$") {
        let j = i + 1;
        let tag = "";
        while (j < sql.length && isTagChar(sql[j])) { tag += sql[j]; j++; }
        if (j < sql.length && sql[j] === "$" && tag === dollarTag) { dollarTag = null; i = j + 1; continue; }
      }
      i++;
      continue;
    }
    if (c === "-" && next === "-") { inLineComment = true; i += 2; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; blockDepth = 1; i += 2; continue; }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === "$") {
      let j = i + 1;
      let tag = "";
      while (j < sql.length && isTagChar(sql[j])) { tag += sql[j]; j++; }
      if (j < sql.length && sql[j] === "$") { dollarTag = tag; i = j + 1; continue; }
      i++;
      continue;
    }
    if (c === ";") {
      statements.push(sql.slice(stmtStart, i + 1));
      i++;
      stmtStart = i;
      continue;
    }
    i++;
  }
  const tail = sql.slice(stmtStart);
  const stripped = tail.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (stripped.length > 0) statements.push(tail);
  return statements;
}

function countTopLevelParens(statement: string): { open: number; close: number } {
  let i = 0;
  let open = 0;
  let close = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let blockDepth = 0;
  let dollarTag: string | null = null;
  const isTagChar = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < statement.length) {
    const c = statement[i];
    const next = statement[i + 1];

    if (inLineComment) { if (c === "\n") inLineComment = false; i++; continue; }
    if (inBlockComment) {
      if (c === "/" && next === "*") { blockDepth++; i += 2; continue; }
      if (c === "*" && next === "/") { blockDepth--; i += 2; if (blockDepth === 0) inBlockComment = false; continue; }
      i++;
      continue;
    }
    if (inSingle) {
      if (c === "'") { if (next === "'") { i += 2; continue; } inSingle = false; }
      i++;
      continue;
    }
    if (inDouble) {
      if (c === '"') { if (next === '"') { i += 2; continue; } inDouble = false; }
      i++;
      continue;
    }
    if (dollarTag !== null) {
      if (c === "$") {
        let j = i + 1;
        let tag = "";
        while (j < statement.length && isTagChar(statement[j])) { tag += statement[j]; j++; }
        if (j < statement.length && statement[j] === "$" && tag === dollarTag) { dollarTag = null; i = j + 1; continue; }
      }
      i++;
      continue;
    }
    if (c === "-" && next === "-") { inLineComment = true; i += 2; continue; }
    if (c === "/" && next === "*") { inBlockComment = true; blockDepth = 1; i += 2; continue; }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === "$") {
      let j = i + 1;
      let tag = "";
      while (j < statement.length && isTagChar(statement[j])) { tag += statement[j]; j++; }
      if (j < statement.length && statement[j] === "$") { dollarTag = tag; i = j + 1; continue; }
      i++;
      continue;
    }
    if (c === "(") open++;
    if (c === ")") close++;
    i++;
  }
  return { open, close };
}

// ---------------------------------------------------------------------------

test("Dollar-quoted blocks are balanced in every migration (no unterminated $$)", () => {
  for (const name of MIGRATIONS) {
    const sql = readMigration(name);
    const { regions, unterminated } = scanDollarQuotes(sql);
    assert.equal(
      unterminated,
      null,
      `${name}: unterminated dollar-quoted body starting at offset ${unterminated}`
    );
    if (name.startsWith("0008")) {
      // 0008 is PL/pgSQL-heavy: DO blocks + function bodies must all be paired.
      assert.ok(regions.length >= 20, `0008 expected >=20 dollar-quoted regions, got ${regions.length}`);
    }
  }
});

test("Every top-level statement has balanced parentheses outside quotes/comments", () => {
  for (const name of MIGRATIONS) {
    const sql = readMigration(name);
    const statements = topLevelStatementTexts(sql);
    assert.ok(statements.length > 0, `${name}: no statements found`);
    statements.forEach((stmt, idx) => {
      const { open, close } = countTopLevelParens(stmt);
      assert.equal(open, close, `${name}: statement #${idx + 1} has unbalanced parens (${open} open / ${close} close): ${stmt.slice(0, 80)}`);
    });
  }
});

test("BEGIN/END blocks inside PL/pgSQL bodies are balanced (BEGIN vs END count)", () => {
  // Word-boundary count of BEGIN and END inside every dollar-quoted body of
  // 0008. plpgsql requires each BEGIN to be closed by END; imbalance here is
  // exactly the failure mode that breaks a whole-file SQL-Editor paste.
  const sql = readMigration("0008_live_sessions.sql");
  const { regions } = scanDollarQuotes(sql);
  assert.ok(regions.length > 0);
  for (const { tag, openIndex, closeIndex } of regions) {
    const body = sql.slice(openIndex, closeIndex);
    // Strip comments and string literals first — words like "end" appear in
    // prose comments and would otherwise poison the count.
    const bare = body
      .replace(/--[^\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/'(?:[^']|'')*'/g, " ");
    const begins = (bare.match(/\bbegin\b/gi) || []).length;
    // Block-terminating END only — `end if`, `end loop`, `end case` are
    // companion keywords, not BEGIN closers.
    const ends = (bare.match(/\bend\b(?!\s+(if|loop|case))/gi) || []).length;
    // A bare `begin ... end` body or DO wrapper has equal counts; SQL-language
    // function bodies (none in 0008) may legitimately differ — all 0008 bodies
    // are plpgsql or DO plpgsql wrappers.
    assert.equal(begins, ends, `0008: $${tag}$ body at offset ${openIndex} has ${begins} BEGIN vs ${ends} END`);
  }
});

test("All migrations apply in order on real Postgres, 0008 as a single paste", async () => {
  const db = new PGlite();

  // Supabase environment shims: objects/roles that exist on Supabase but not
  // on stock Postgres. These are harness-only; the migration files are not
  // modified. pgcrypto is compiled out for this harness because PGlite does
  // not bundle the extension (on Supabase, 0001 creates it); the only symbol
  // the migrations take from pgcrypto is gen_random_uuid(), which is core
  // PostgreSQL since 13.
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

  for (const name of MIGRATIONS) {
    const sql = stripPgcrypto(readMigration(name));
    // Whole-file exec — same shape as pasting the file into the SQL Editor.
    await db.exec(sql);
  }

  const rows = async (query: string) =>
    ((await db.query(query)).rows ?? []) as { c?: number; tablename?: string }[];

  // 0008 created every locked object.
  const tables = (
    await rows("select tablename from pg_tables where schemaname='public' and tablename like 'live_%' order by 1")
  ).map((r) => r.tablename ?? "");
  assert.deepEqual(tables, ["live_audit", "live_eligibility", "live_reports", "live_sessions", "live_viewers"]);

  const rlsCount = (
    await rows("select count(*)::int as c from pg_tables where schemaname='public' and tablename like 'live_%' and rowsecurity")
  )[0].c ?? 0;
  assert.equal(rlsCount, 5, "RLS must be enabled on all five Live tables");

  const rpcs = [
    "assert_viewer_eligible", "admit_live_viewer", "post_live_comment",
    "submit_live_report", "grant_live_eligibility", "revoke_live_eligibility",
    "start_live_session", "end_live_session", "apply_live_duration_cap",
    "moderate_live", "heal_live_duration_caps", "release_live_input",
    "list_ended_live_inputs",
  ];
  const rpcCount = (
    await rows(
      `select count(*)::int as c from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and proname = any(array['${rpcs.join("','")}'])`
    )
  )[0].c ?? 0;
  assert.equal(rpcCount, rpcs.length, "all 13 Live RPCs must exist after apply");

  // Locked security posture survives execution (moderator-only transport grant).
  const modGrant = (
    await rows(
      `select count(*)::int as c from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
       aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a join pg_roles r on r.oid=a.grantee
       where n.nspname='public' and p.proname='moderate_live' and r.rolname='authenticated' and a.privilege_type='EXECUTE'`
    )
  )[0].c ?? 0;
  assert.equal(modGrant, 1, "moderate_live must be executable by authenticated (in-function role check is the authz layer)");

  const triggerCount = (
    await rows(
      "select count(*)::int as c from pg_trigger where tgname in ('live_stage_guard_trigger','live_audit_block_mutation') and not tgisinternal"
    )
  )[0].c ?? 0;
  assert.equal(triggerCount, 2, "stage auto-end + audit append-only triggers must exist");

  const pubCount = (
    await rows(
      "select count(*)::int as c from pg_publication_tables where pubname='supabase_realtime' and tablename in ('live_sessions','live_reports')"
    )
  )[0].c ?? 0;
  assert.equal(pubCount, 2, "live_sessions and live_reports must be in the realtime publication");

  await db.close();
});

test("0013 lockdown applies cleanly and locks EXECUTE on internal Live helpers", async () => {
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
  // Full migration chain (0008 depends on 0001–0007 schema; 0009–0012 need
  // the Supabase realtime schema, which is out of this harness's scope).
  for (const name of ["0001_visit_intent_foundation.sql", "0002_harden_visit_intent_rls.sql", "0003_persistence_integrity.sql", "0004_place_management.sql", "0005_experience_management.sql", "0006_production_story.sql", "0007_production_story_atomic_persistence.sql", "0008_live_sessions.sql"]) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  await db.exec(stripPgcrypto(readMigration("0013_live_rpc_privilege_lockdown.sql")));

  const rows = async (query: string) =>
    ((await db.query(query)).rows ?? []) as { rolname?: string; c?: number }[];

  const execGrants = async (fn: string) =>
    (
      await rows(
        `select r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
         aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a join pg_roles r on r.oid=a.grantee
         where n.nspname='public' and p.proname='${fn}' and a.privilege_type='EXECUTE' order by 1`,
      )
    ).map((r) => r.rolname ?? "");

  // The object owner (the role that ran the migrations — postgres/supabase_admin)
  // always retains its implicit full privileges, so the security contract is:
  // PUBLIC/anon must hold NO EXECUTE, and authenticated must hold it.
  const assertLockedFromPublicAnon = async (fn: string) => {
    const grantees = await execGrants(fn);
    assert.ok(
      !grantees.includes("public") && !grantees.includes("anon"),
      `${fn}: public/anon must not hold EXECUTE (got ${grantees.join(", ")})`,
    );
  };

  // Internal helpers: PUBLIC/anon EXECUTE revoked, authenticated kept.
  for (const fn of ["assert_viewer_eligible", "heal_live_duration_caps", "release_live_input", "list_ended_live_inputs"]) {
    await assertLockedFromPublicAnon(fn);
    assert.ok((await execGrants(fn)).includes("authenticated"), `${fn}: authenticated must hold EXECUTE`);
  }

  // Trigger functions: no EXECUTE for any login-capable role (trigger-called only).
  for (const fn of ["block_live_audit_mutation", "live_stage_guard"]) {
    const grantees = await execGrants(fn);
    assert.ok(
      !grantees.some((r) => ["public", "anon", "authenticated"].includes(r)),
      `${fn}: no direct EXECUTE expected (got ${grantees.join(", ")})`,
    );
  }

  // Client-facing cleanup RPCs keep their authenticated grant (0008/0012).
  for (const fn of ["start_live_session", "end_live_session"]) {
    await assertLockedFromPublicAnon(fn);
    assert.ok((await execGrants(fn)).includes("authenticated"), `${fn}: authenticated must hold EXECUTE`);
  }

  await db.close();
});

test("Live service layer only calls RPCs that migration 0008 actually defines", () => {
  // Contract guard: an RPC rename in the service layer without a matching
  // migration update (or vice versa) breaks at runtime, not compile time.
  const migration = readMigration("0008_live_sessions.sql");
  const defined = new Set(
    [...migration.matchAll(/create or replace function public\.([a-z_]+)\(/gi)].map((m) => m[1])
  );

  const service = readFileSync(new URL("../lib/live/session-service.ts", import.meta.url), "utf8");
  const cap = readFileSync(new URL("../lib/live/session-service-cap.ts", import.meta.url), "utf8");
  const callers = service + cap;
  const called = [...callers.matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]);

  assert.ok(called.length > 0, "expected Live service RPC calls");
  for (const name of called) {
    assert.ok(
      defined.has(name),
      `service calls public.${name}(...) but 0008 never defines it`
    );
  }
});
