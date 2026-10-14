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

// --- A-01 ------------------------------------------------------------------

test("KNOWN DEFECT A-01: the sign-up email-confirmation redirect target has no code-exchange handler", () => {
  const signUpRoute = read("../../app/api/auth/sign-up/route.ts");
  const callbackRoute = read("../../app/auth/callback/route.ts");
  const authForm = read("../../app/auth/auth-form.tsx");

  // The confirmation link is told to return to /auth ...
  assert.match(
    signUpRoute,
    /emailRedirectTo: `\$\{new URL\(request\.url\)\.origin\}\/auth`/,
    "sign-up still redirects confirmation to /auth",
  );

  // ... but the ONLY code-exchange handler in the app is /auth/callback ...
  assert.match(callbackRoute, /exchangeCodeForSession\(code\)/);
  assert.doesNotMatch(authForm, /exchangeCodeForSession/);

  // ... and /auth never reads the `code` parameter it is handed.
  assert.doesNotMatch(
    authForm,
    /searchParams\.get\("code"\)/,
    "if /auth starts handling `code`, A-01 may be fixed — update the audit document",
  );
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

// --- A-03 ------------------------------------------------------------------

test("KNOWN DEFECT A-03: release_live_input and list_ended_live_inputs are authenticated-only by grant but have no caller-authority check", () => {
  const release = sqlFunctionBody(live0008, "release_live_input");
  const list = sqlFunctionBody(live0008, "list_ended_live_inputs");

  // The only precondition is the session state — never who is calling.
  assert.match(release, /where id = p_session_id and status = 'ended'/);
  for (const [name, body] of [
    ["release_live_input", release],
    ["list_ended_live_inputs", list],
  ] as const) {
    assert.doesNotMatch(body, /can_operate_live_for_place/, `${name} has no Place predicate`);
    assert.doesNotMatch(body, /producer_memberships/, `${name} has no membership predicate`);
    assert.doesNotMatch(body, /auth\.uid\(\)/, `${name} never inspects the caller`);
  }

  // The grant that makes them reachable by any signed-in account.
  assert.match(live0008, /grant execute on function public\.release_live_input\(text\) to authenticated;/);
  assert.match(live0008, /grant execute on function public\.list_ended_live_inputs\(\) to authenticated;/);

  // list_ended_live_inputs is SECURITY DEFINER, so it reads across tenants
  // regardless of the live_sessions RLS policies.
  assert.match(list, /security definer set search_path = public/);
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
