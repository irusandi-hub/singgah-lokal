import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/0008_live_sessions.sql", import.meta.url), "utf8");

test("Live schema creates canonical Live tables with locked constraints", () => {
  assert.match(migration, /create table if not exists public\.live_eligibility/);
  assert.match(migration, /create table if not exists public\.live_sessions/);
  assert.match(migration, /create table if not exists public\.live_viewers/);
  assert.match(migration, /create table if not exists public\.live_reports/);
  assert.match(migration, /create table if not exists public\.live_audit/);

  assert.match(migration, /primary key \(producer_id, path\)/);
  assert.match(migration, /live_sessions_status_check/);
  assert.match(migration, /'scheduled', 'live', 'ended'/);
  assert.match(migration, /live_sessions_ended_reason_check/);
  assert.match(migration, /'producer_ended', 'duration_cap', 'source_stage_unpublished', 'moderation'/);
  assert.match(migration, /live_sessions_viewer_peak_check/);
  assert.match(migration, /viewer_peak between 0 and 100/);
  assert.match(migration, /live_sessions_idempotency_key_not_blank/);
  assert.match(migration, /unique \(live_session_id, reporter_id, category\)/);
});

test("Live per-Place cap of one active session is enforced by partial unique index", () => {
  assert.match(migration, /create unique index if not exists live_sessions_one_active_per_place/);
  assert.match(migration, /on public\.live_sessions \(place_id\)/);
  assert.match(migration, /where status <> 'ended'/);
});

test("Live RLS is enabled on every Live table and direct DML is revoked", () => {
  for (const table of ["live_eligibility", "live_sessions", "live_viewers", "live_reports", "live_audit"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from authenticated`));
  }
  assert.match(migration, /create policy live_sessions_public_read on public\.live_sessions/);
  assert.match(migration, /create policy live_sessions_producer_read on public\.live_sessions/);
  assert.match(migration, /create policy live_viewers_own_read on public\.live_viewers/);
  assert.match(migration, /create policy live_reports_reporter_read on public\.live_reports/);
  assert.match(migration, /create policy live_reports_producer_read on public\.live_reports/);
  assert.match(migration, /create policy live_eligibility_producer_read on public\.live_eligibility/);
});

test("Audit is append-only via trigger and carries the locked action enum", () => {
  assert.match(migration, /block_live_audit_mutation/);
  assert.match(migration, /raise exception 'live_audit is append-only'/);
  assert.match(migration, /'session_started', 'session_ended', 'report_submitted', 'moderation_warn'/);
  assert.match(migration, /'comment_removed'/);
  assert.match(migration, /comment_ref/);
  assert.match(migration, /on delete set null/);
  assert.doesNotMatch(migration, /create policy live_audit_\w+ on public\.live_audit/);
});

test("Composite FK keeps the Process in the broadcasting Place", () => {
  assert.match(migration, /production_stages_id_place_id_key unique \(id, place_id\)/);
  assert.match(migration, /foreign key \(stage_id, place_id\) references public\.production_stages \(id, place_id\)/);
  assert.match(migration, /live_sessions_stage_place_fkey/);
});

test("Platform Admin/Moderator role exists and guards moderation", () => {
  assert.match(migration, /add column if not exists platform_role text/);
  assert.match(migration, /platform_role_check/);
  assert.match(migration, /'platform_moderator'/);
  assert.match(migration, /where id = auth\.uid\(\) and platform_role = 'platform_moderator'/);
});

test("start_live_session enforces authorization, eligibility, published stage, and caps idempotently", () => {
  assert.match(migration, /create or replace function public\.start_live_session/);
  assert.match(migration, /security definer set search_path = public/);
  assert.match(migration, /pg_try_advisory_xact_lock\(hashtext\('live_global_start_lock'\)\)/);
  assert.match(migration, /role in \('owner', 'manager'\)/);
  assert.match(migration, /from public\.live_eligibility\s+where producer_id = v_membership and active/);
  assert.match(migration, /v_stage_status <> 'published'/);
  assert.match(migration, /v_global_count >= 5/);
  assert.match(migration, /live_cap_denied/);
  assert.match(migration, /live_not_eligible/);
  assert.match(migration, /live_stage_not_published/);
  // MR1: explicit per-Place cap signal plus unique-violation backstop
  assert.match(migration, /live_place_busy/);
  assert.match(migration, /where place_id = p_place_id and status <> 'ended'/);
  assert.match(migration, /when unique_violation then\s+raise exception 'live_place_busy'/);
  assert.match(migration, /on conflict \(idempotency_key\) do nothing/);
  assert.match(migration, /'session_started'/);
});

test("end_live_session is idempotent and records the locked end reasons", () => {
  assert.match(migration, /create or replace function public\.end_live_session/);
  assert.match(migration, /p_reason text default 'producer_ended'/);
  assert.match(migration, /if not found or v_session\.status <> 'live' then/);
  assert.match(migration, /return false/);
  assert.match(migration, /'session_ended'/);
  assert.match(migration, /for update/);
  // CR2: every end reason is verified against current state
  assert.match(migration, /elsif p_reason = 'moderation' then/);
  assert.match(migration, /platform_role = 'platform_moderator'/);
  assert.match(migration, /elsif p_reason = 'duration_cap' then/);
  assert.match(migration, /v_session\.started_at \+ interval '60 minutes' <= now\(\)/);
  assert.match(migration, /elsif p_reason = 'source_stage_unpublished' then/);
  assert.match(migration, /live_stage_still_published/);
  assert.match(migration, /live_duration_cap_not_due/);
  assert.match(migration, /live_end_reason_invalid/);
});

test("apply_live_duration_cap self-heals expired sessions at the locked 60 minutes", () => {
  assert.match(migration, /create or replace function public\.apply_live_duration_cap/);
  assert.match(migration, /interval '60 minutes'/);
  assert.match(migration, /'duration_cap'/);
});

test("live_stage_guard auto-ends sessions when the Process leaves published", () => {
  assert.match(migration, /create or replace function public\.live_stage_guard/);
  assert.match(migration, /after update on public\.production_stages/);
  assert.match(migration, /old\.status = 'published' and new\.status in \('paused', 'archived'\)/);
  assert.match(migration, /'source_stage_unpublished'/);
});

test("Viewer admission and comments fail closed; capacity is concurrent within the presence window", () => {
  assert.match(migration, /create or replace function public\.admit_live_viewer/);
  assert.match(migration, /create or replace function public\.post_live_comment/);
  assert.match(migration, /v_concurrent >= 100/);
  assert.match(migration, /admitted_at > now\(\) - interval '5 minutes'/);
  assert.match(migration, /'admission_denied'/);
  assert.match(migration, /live_capacity_full/);
  assert.match(migration, /email_confirmed_at is null/);
  assert.match(migration, /live_viewer_denied/);
  assert.match(migration, /live_session_not_live/);
  assert.match(migration, /live_comment_too_long/);
  assert.match(migration, /length\(p_body\) > 300/);
  // MR2: viewer peak is persisted from the concurrent count
  assert.match(migration, /set viewer_peak = greatest\(viewer_peak, v_concurrent \+ 1\)/);
  // CR1: reports run the same fail-closed gate as all Live participation
  assert.match(migration, /perform public\.assert_viewer_eligible\(p_session_id\);/);
  assert.doesNotMatch(migration, /create or replace function public\.submit_live_report[\s\S]*?perform public\.assert_viewer_eligible[\s\S]*?live_session_not_live[\s\S]*?raise exception 'live_viewer_denied' using errcode = 'P0001';\s*\n\s*-- B1/);
});

test("Moderation is restricted to Platform Admin/Moderator with the locked ladder", () => {
  assert.match(migration, /create or replace function public\.moderate_live/);
  assert.match(migration, /platform_moderator_required/);
  assert.match(migration, /'warn', 'end', 'suspend'/);
  assert.match(migration, /'moderation_warn'/);
  assert.match(migration, /'moderation_end'/);
  assert.match(migration, /'moderation_suspend'/);
  assert.match(migration, /set active = false/);
});

test("Eligibility grants and revokes require the platform role and are audited", () => {
  assert.match(migration, /create or replace function public\.grant_live_eligibility/);
  assert.match(migration, /create or replace function public\.revoke_live_eligibility/);
  assert.match(migration, /platform_moderator_required/);
  assert.match(migration, /on conflict \(producer_id, path\) do update/);
  assert.match(migration, /'eligibility_granted'/);
  // B2: revoke path completes the eligibility_revoked audit action
  assert.match(migration, /set active = false\s+where producer_id = p_producer_id and path = p_path/);
  assert.match(migration, /'eligibility_revoked'/);
  assert.match(migration, /live_eligibility_not_found/);
});

test("B5: opportunistic duration-cap self-heal exists with no scheduler invented", () => {
  assert.match(migration, /create or replace function public\.heal_live_duration_caps/);
  assert.match(migration, /perform public\.heal_live_duration_caps\(\);/);
  assert.match(migration, /perform public\.apply_live_duration_cap\(p_session_id\);/);
  // No cron/pg_cron/scheduler objects are created by this migration.
  assert.doesNotMatch(migration, /pg_cron|cron\.schedule|pgagent|create schedule/);
});

test("Reports map 1:1 to policy §4 prohibitions and are idempotent per reporter", () => {
  assert.match(migration, /'sexual_content', 'graphic_violence', 'illegal_activity', 'prohibited_product'/);
  assert.match(migration, /'smoking', 'unsafe_activity', 'minor_as_subject', 'private_data', 'other'/);
  assert.match(migration, /on conflict \(live_session_id, reporter_id, category\) do nothing/);
  assert.match(migration, /'report_submitted'/);
});

test("Realtime publication carries only status/report payloads; never video", () => {
  assert.match(migration, /alter publication supabase_realtime add table public\.live_sessions/);
  assert.match(migration, /alter publication supabase_realtime add table public\.live_reports/);
  // No video-bearing table or column exists anywhere in the schema.
  assert.doesNotMatch(migration, /create table if not exists public\.\w*video/);
  assert.doesNotMatch(migration, /\bvideo\w* (text|integer|uuid|timestamptz|jsonb|boolean)/);
});

test("Hardening: invented schema removed and RPC privileges restricted", () => {
  // MR6: no undocumented columns on live_sessions
  assert.doesNotMatch(migration, /processed_stage_ids/);
  // CR3: EXECUTE revoked from public/anon, granted to authenticated
  assert.match(migration, /revoke execute on function public\.start_live_session\(text, text, text, text\) from public, anon/);
  assert.match(migration, /revoke execute on function public\.end_live_session\(text, text, text\) from public, anon/);
  assert.match(migration, /revoke execute on function public\.moderate_live\(text, text, text\) from public, anon/);
  assert.match(migration, /revoke execute on function public\.grant_live_eligibility\(text, text, numeric, integer\) from public, anon/);
  assert.match(migration, /revoke execute on function public\.revoke_live_eligibility\(text, text\) from public, anon/);
  assert.match(migration, /grant execute on function public\.apply_live_duration_cap\(text\) to authenticated/);
});
