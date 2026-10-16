import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/0008_live_sessions.sql", import.meta.url), "utf8");
const columnPrivilegesMigration = readFileSync(
  new URL("../supabase/migrations/0052_live_session_column_privileges.sql", import.meta.url),
  "utf8",
);

test("Blanket revoke-all does not strip RLS-governed SELECT from discovery surfaces", () => {
  // The blanket revoke (write-lockout) exists...
  for (const table of ["live_eligibility", "live_sessions", "live_viewers", "live_reports", "live_audit"]) {
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from authenticated`));
  }
  // ...but SELECT is explicitly restored for the RLS-governed read paths
  // (anon + authenticated) — otherwise signed-in discovery/status/Place reads fail.
  //
  // EXPLICIT CHANGE FOR A-02 (Tahap C, migration 0052): 0008 restored SELECT at
  // TABLE level, which also exposed live_input_id / idempotency_key. That grant
  // is now superseded for live_sessions by migration 0052 (table-level SELECT
  // revoked for anon/authenticated, re-granted per SAFE COLUMN only). The 0008
  // statement is kept as historical evidence and asserted as such; the other
  // Live tables keep their table-level SELECT unchanged.
  for (const table of ["live_viewers", "live_reports", "live_eligibility"]) {
    assert.match(migration, new RegExp(`grant select on public\\.${table} to anon, authenticated`));
  }
  assert.match(
    migration,
    /grant select on public\.live_sessions to anon, authenticated;/,
    "0008 granted table-level SELECT on live_sessions (append-only history; superseded by 0052)",
  );
  // A-02 supersession: table-level SELECT off, safe columns only.
  assert.match(
    columnPrivilegesMigration,
    /revoke select on public\.live_sessions from anon, authenticated;/,
  );
  assert.doesNotMatch(
    columnPrivilegesMigration,
    /grant select on public\.live_sessions to anon, authenticated/,
    "A-02 must not restore the table-level grant",
  );
  const grantedColumns = columnPrivilegesMigration.slice(
    columnPrivilegesMigration.indexOf("grant select ("),
    columnPrivilegesMigration.indexOf(") on public.live_sessions to anon, authenticated;"),
  );
  for (const column of ["live_input_id", "idempotency_key"]) {
    assert.equal(
      grantedColumns.includes(column),
      false,
      `${column} must stay out of the client column grant`,
    );
  }
  // live_audit stays dark: no grant for anon/authenticated, explicit PUBLIC revoke.
  assert.match(migration, /revoke all on public\.live_audit from public, anon, authenticated;/);
  assert.doesNotMatch(migration, /grant select on public\.live_audit/);
  // The implicit PUBLIC default is revoked on every Live table (fail closed).
  for (const table of ["live_eligibility", "live_sessions", "live_viewers", "live_reports"]) {
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from public;`));
  }
  // Writes remain RPC-only: explicit DML revocation for anon AND authenticated.
  assert.match(migration, /revoke insert, update, delete, truncate on public\.live_sessions from anon, authenticated;/);
  assert.match(migration, /revoke insert, update, delete, truncate on public\.live_audit from anon, authenticated;/);
});

test("Realtime publication registration is re-apply safe", () => {
  // alter publication on an already-registered table raises duplicate_object;
  // the migration must tolerate re-runs instead of failing mid-apply.
  assert.match(migration, /alter publication supabase_realtime add table public\.live_sessions;\s*exception\s+when duplicate_object then null;/);
  assert.match(migration, /alter publication supabase_realtime add table public\.live_reports;\s*exception\s+when duplicate_object then null;/);
});

test("Development DB regression suite exists and covers all locked behaviors", () => {
  const suitePath = new URL("../tests/db-regression/live-regression.sql", import.meta.url);
  assert.equal(existsSync(suitePath), true, "db-regression/live-regression.sql missing");
  const suite = readFileSync(suitePath, "utf8");
  // Every locked behavior has a check.
  for (const marker of [
    "check_producer_authorization",
    "check_eligibility_required",
    "check_start_end_idempotency",
    "check_caps",
    "check_viewer_admission_b1",
    "check_moderation",
    // Decoupled 2026-10-16: informational Process changes must NOT end or
    // block a Live (was check_stage_auto_end).
    "check_stage_decoupled",
    "check_rls_baseline",
  ]) {
    assert.match(suite, new RegExp(marker));
  }
  // The suite is development-only and leaves no data behind.
  assert.match(suite, /DEVELOPMENT project ONLY\. NEVER production/);
  assert.match(suite, /rollback to sp_check/);
  assert.match(suite, /rollback; -- everything above is a dry run against the DEVELOPMENT database/);
  // Idempotent end must not duplicate audit rows.
  assert.match(suite, /repeated end duplicated the audit trail/);
});

test("DEVELOPMENT apply checklist exists and fences production out", () => {
  const checklist = readFileSync(new URL("../../docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md", import.meta.url), "utf8");
  assert.match(checklist, /Supabase DEVELOPMENT project only/);
  assert.match(checklist, /Never run any step of this checklist against production/);
  assert.match(checklist, /LIVE REGRESSION SUITE: ALL CHECKS PASSED/);
  // No Cloudflare configuration belongs in the apply checklist.
  assert.match(checklist, /No Cloudflare configuration is part of this checklist/);
});
