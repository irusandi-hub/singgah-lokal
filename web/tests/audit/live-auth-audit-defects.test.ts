import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * CHARACTERISATION TESTS — LIVE_AUTH_AUDIT_v1 (docs/audits/LIVE_AUTH_AUDIT_v1.md).
 *
 * Every test named "KNOWN DEFECT A-xx" DOCUMENTS A DEFECT that the audit found.
 * They reproduce it against the current source and assert the CURRENT
 * behaviour, so the suite stays green and the defect is recorded instead of
 * silently fixed. The defects themselves are NOT repaired here — they are
 * scheduled for Tahap B–D using the IDs from the audit document.
 *
 * The tests labelled "AUDIT PROPERTY" lock the fail-closed properties the
 * policy requires, so a later change that weakens them fails loudly.
 */

// --- helpers ---------------------------------------------------------------

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function readMigration(name: string): string {
  return read(`../../supabase/migrations/${name}`);
}

/** Body of `create [or replace] function public.<name>(` up to its closing `$$;`. */
function sqlFunctionBody(sql: string, name: string): string {
  const start = sql.indexOf(`function public.${name}`);
  assert.notEqual(start, -1, `function public.${name} not found`);
  const end = sql.indexOf("$$;", start);
  assert.notEqual(end, -1, `function public.${name} has no closing $$;`);
  return sql.slice(start, end);
}

const live0008 = readMigration("0008_live_sessions.sql");
const cap0027 = readMigration("0027_live_viewer_cap_race_guard.sql");

// --- A-01 (FIXED 2026-10-11, Tahap B/LIVE-B) --------------------------------
// The audit originally found the confirmation link landing on /auth, which
// never exchanges `code` (A-01, HIGH). The sign-up route now targets the
// existing /auth/callback handler with a sanitized `next`. These assertions
// were FLIPPED from the original defect characterization: they now lock the
// FIX, so a regression back to /auth fails loudly.

test("A-01 FIXED: the sign-up email-confirmation target is the code-exchange handler", () => {
  const signUpRoute = read("../../app/api/auth/sign-up/route.ts");
  const callbackRoute = read("../../app/auth/callback/route.ts");

  // The confirmation link returns to /auth/callback (the only exchange
  // handler), carrying an internal `next` destination.
  assert.match(
    signUpRoute,
    /emailRedirectTo: `\$\{new URL\(request\.url\)\.origin\}\/auth\/callback\?next=\/auth`/,
    "A-01 regression: confirmation must land on /auth/callback, not /auth",
  );

  // The target swaps the code for a session with the project's SSR client,
  // and the `next` destination is re-sanitized (no open redirect).
  assert.match(callbackRoute, /exchangeCodeForSession\(code\)/);
  assert.match(callbackRoute, /sanitizeReturnTo\(searchParams\.get\("next"\)\)/);
  assert.match(callbackRoute, /NextResponse\.redirect\(new URL\(next, origin\)\)/);
});

// --- A-02 ------------------------------------------------------------------

test("KNOWN DEFECT A-02: anon/authenticated SELECT on live_sessions is row-scoped only, exposing live_input_id and idempotency_key", () => {
  // Table-level SELECT for anon + authenticated (RLS restricts ROWS, not columns).
  assert.match(live0008, /grant select on public\.live_sessions to anon, authenticated;/);

  // The row filter is the public-read policy (status live + published Place).
  assert.match(
    live0008,
    /create policy live_sessions_public_read on public\.live_sessions for select using \(\s*status = 'live'/,
  );

  // The columns the table carries — including the provider input UID and the
  // producer idempotency key, which MASTER_LIVE_TECH §1.2/§5 keep server-side.
  assert.match(live0008, /live_input_id text null,/);
  assert.match(live0008, /idempotency_key text not null unique/);

  // No column-level SELECT restriction exists anywhere in the Live migrations.
  assert.doesNotMatch(
    live0008,
    /grant select \([^)]+\) on public\.live_sessions/,
    "if a column-scoped grant lands, A-02 may be fixed — update the audit document",
  );
});

// --- A-03 (FIXED 2026-10-11, Tahap B/LIVE-B) --------------------------------
// Original defect: release_live_input / list_ended_live_inputs verified only
// the SESSION STATE and were EXECUTE-granted to every authenticated account,
// so any signed-in user could null another tenant's live_input_id and
// enumerate ended sessions' provider input UIDs. Migration 0051 locks both
// RPCs to the service role (the only callers are the server cleanup paths),
// and the callers now open a service connection.

test("A-03 FIXED: the cleanup RPCs are service-role only and every caller is server-side", () => {
  const migration0051 = readMigration("0051_live_auth_integrity.sql");

  // EXECUTE is revoked from every client-reachable grantee and granted only
  // to the infrastructure role.
  assert.match(
    migration0051,
    /revoke execute on function public\.release_live_input\(text\) from public, anon, authenticated;/,
  );
  assert.match(
    migration0051,
    /revoke execute on function public\.list_ended_live_inputs\(\) from public, anon, authenticated;/,
  );
  assert.match(migration0051, /grant execute on function public\.release_live_input\(text\) to service_role;/);
  assert.match(migration0051, /grant execute on function public\.list_ended_live_inputs\(\) to service_role;/);
  assert.doesNotMatch(migration0051, /grant execute[^;]* to (anon|authenticated|public)/);

  // The only code callers open a service-role connection for these two RPCs.
  const service = read("../../lib/live/session-service.ts");
  const cap = read("../../lib/live/session-service-cap.ts");
  assert.match(service, /createSupabaseServiceClient\(\)\.rpc\("release_live_input"/);
  assert.match(cap, /const supabase = createSupabaseServiceClient\(\);/);
  assert.match(cap, /supabase\.rpc\("list_ended_live_inputs"\)/);
  assert.match(cap, /supabase\.rpc\("release_live_input"/);
});

// --- A-04 ------------------------------------------------------------------

test("KNOWN DEFECT A-04: the 100-concurrent cap counts only admissions inside a 5-minute window", () => {
  const admit = sqlFunctionBody(cap0027, "admit_live_viewer");

  assert.match(
    admit,
    /select count\(\*\) into v_concurrent\s*from public\.live_viewers\s*where live_session_id = p_session_id\s*and admitted_at > now\(\) - interval '5 minutes';/,
  );
  assert.match(admit, /if v_concurrent >= 100 then/);

  // A real presence signal (the tech master's §6 model) is not used: nothing in
  // the body re-counts long-lived viewers or reads Realtime presence.
  assert.doesNotMatch(admit, /realtime\.presence|presence_state|presence_count/);
  assert.doesNotMatch(admit, /heartbeat|lease/);
});

// --- AUDIT PROPERTIES ------------------------------------------------------

test("AUDIT PROPERTY: the viewer gate stays fail-closed (deny-all until Phase 2.1)", () => {
  const gate = sqlFunctionBody(live0008, "assert_viewer_eligible");

  // Email verification is checked from the database, not from client input.
  assert.match(gate, /from auth\.users\s*where id = auth\.uid\(\) and email_confirmed_at is null/);
  // Content gate before participation.
  assert.match(gate, /if v_session\.content_status <> 'ok' then/);
  // The unconditional B1 denial — the last statement of the function.
  assert.match(
    gate,
    /-- B1 \(blocked\): verified-age mechanism is Phase 2\.1; until then deny all\.\s*raise exception 'live_viewer_denied' using errcode = 'P0001';\s*end;/,
  );
  // No migration after 0008 redefines the gate.
  for (const name of ["0013_live_rpc_privilege_lockdown.sql", "0027_live_viewer_cap_race_guard.sql"]) {
    assert.doesNotMatch(readMigration(name), /create or replace function public\.assert_viewer_eligible/);
  }

  // Every participation path still runs the gate first.
  assert.match(sqlFunctionBody(cap0027, "admit_live_viewer"), /perform public\.assert_viewer_eligible\(p_session_id\);/);
  assert.match(sqlFunctionBody(live0008, "post_live_comment"), /perform public\.assert_viewer_eligible\(p_session_id\);/);
  assert.match(sqlFunctionBody(live0008, "submit_live_report"), /perform public\.assert_viewer_eligible\(p_session_id\);/);
});

test("AUDIT PROPERTY: date_of_birth and phone verification are never read by the Live path", () => {
  for (const relative of [
    "../../lib/live/session-service.ts",
    "../../lib/live/session-service-cap.ts",
    "../../lib/live/operator-authorization.ts",
    "../../lib/live/platform.ts",
    "../../lib/live/stream-token.ts",
    "../../app/api/live/playback/route.ts",
    "../../app/api/live/comments/route.ts",
    "../../app/api/live/reports/route.ts",
    "../../app/api/live/start/route.ts",
    "../../app/api/live/end/route.ts",
  ]) {
    const source = read(relative);
    assert.doesNotMatch(source, /date_of_birth/, `${relative} must not treat date of birth as proof`);
    assert.doesNotMatch(source, /phone_verified/, `${relative} must not treat a phone as age/eligibility proof`);
  }

  // The pure age module states the policy gap explicitly (no eligibility).
  const age = read("../../lib/account/age.ts");
  assert.match(age, /nothing here grants eligibility/);
  assert.match(age, /no Master defines a minimum ACCOUNT age/);
});
