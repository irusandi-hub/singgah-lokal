-- ============================================================================
-- DB REGRESSION SUITE — Live (MASTER_LIVE_POLICY_v1.0 / MASTER_LIVE_TECH_v1.0)
-- Target: Supabase DEVELOPMENT project ONLY. NEVER production.
--
-- Run AFTER migrations 0001..0012 are applied, via Supabase SQL Editor or:
--   psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-regression.sql
--
-- Design (PostgreSQL-valid harness):
--   * Error expectations use plpgsql BEGIN...EXCEPTION blocks — a caught
--     exception IS a subtransaction, so partial writes of a failed RPC are
--     rolled back automatically. (SAVEPOINT inside a plpgsql function is
--     not valid PostgreSQL — transaction control is only allowed at the
--     top level, so the previous harness could never execute.)
--   * Fixture isolation per check: the psql runner wraps each check in a
--     top-level SAVEPOINT and ROLLBACKs to it after the check — the suite
--     leaves NO persistent Live data behind (fixtures rolled back too).
--   * Role switching uses SET LOCAL ROLE authenticated + request.jwt.claims
--     (set_config) so RPC authorization runs exactly as in production.
--   * A session-scoped custom GUC counts FAILs across per-check rollbacks;
--     the final verdict raises (suite exit non-zero) if any check failed.
-- ============================================================================
\set ON_ERROR_STOP on
begin;

create schema if not exists _live_regression;

-- Helpers are called from within authenticated context (after act_as), so the
-- role needs USAGE on this postgres-owned schema. Transactional grant: it
-- disappears with the suite's final ROLLBACK.
grant usage on schema _live_regression to authenticated;

create table _live_regression.results (
  id serial primary key,
  check_name text not null,
  outcome text not null
);

-- ---------------------------------------------------------------------------
-- Fixture (called inside a check's savepoint-protected transaction block).
-- Returns handles; inserts rows the check's rollback discards.
-- ---------------------------------------------------------------------------
create or replace function _live_regression.fixture()
returns table (
  user_a uuid,        -- producer owner
  user_b uuid,        -- unrelated authenticated viewer
  user_c uuid,        -- editor (can read, cannot start/end)
  moderator uuid,     -- platform_moderator
  producer_id text,
  place_id text,
  stage_id text,
  draft_stage_id text
)
language plpgsql
as $func$
declare
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_user_c uuid := gen_random_uuid();
  v_mod uuid := gen_random_uuid();
  v_producer text := 'reg_live_producer';
  v_place text := 'reg_live_place';
  v_stage text := 'reg_live_stage';
  v_draft text := 'reg_live_stage_draft';
begin
  insert into auth.users (id, email, email_confirmed_at, encrypted_password)
  values
    (v_user_a, 'reg-live-a@test.local', now(), 'x'),
    (v_user_b, 'reg-live-b@test.local', now(), 'x'),
    (v_user_c, 'reg-live-c@test.local', now(), 'x'),
    (v_mod,    'reg-live-mod@test.local', now(), 'x');

  -- on_auth_user_created trigger mirrors ids into public.users; set the role.
  update public.users set platform_role = 'platform_moderator' where id = v_mod;
  if not exists (select 1 from public.users where id = v_mod) then
    insert into public.users (id, platform_role) values (v_mod, 'platform_moderator');
  end if;

  insert into public.producers (id, display_name) values (v_producer, 'Regression Producer');

  insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id, publication_status)
  values (v_place, 'Regression Place', 'Test', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', v_producer, 'published');

  insert into public.production_stages (id, place_id, title, description, sort_order, status)
  values (v_stage, v_place, 'Regression Stage', 'Test', 0, 'published');

  insert into public.production_stages (id, place_id, title, description, sort_order, status)
  values (v_draft, v_place, 'Regression Draft Stage', 'Test', 1, 'draft');

  insert into public.producer_memberships (user_id, producer_id, place_id, role)
  values (v_user_a, v_producer, v_place, 'owner'),
         (v_user_c, v_producer, v_place, 'editor');

  insert into public.live_eligibility (producer_id, path, active, granted_by)
  values (v_producer, 'ADMIN_APPROVED', true, 'regression');

  return query select v_user_a, v_user_b, v_user_c, v_mod, v_producer, v_place, v_stage, v_draft;
end;
$func$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Expect a failing call: compares SQLSTATE; the BEGIN...EXCEPTION block is
-- itself a subtransaction, so partial writes of the failed call are rolled
-- back automatically when the exception is caught (no savepoint needed).
create or replace function _live_regression.expect_error(p_sql text, p_state text, p_msg_like text default null)
returns text
language plpgsql
as $func$
declare
  v_state text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    if v_state <> p_state then
      raise exception 'unexpected_sqlstate expected % got % (%): %', p_state, v_state, v_msg, p_sql;
    end if;
    if p_msg_like is not null and v_msg not like p_msg_like then
      raise exception 'unexpected_message expected like % got %', p_msg_like, v_msg;
    end if;
    return v_msg;
  end;
  raise exception 'assertion_failed: expected sqlstate % but call succeeded: %', p_state, p_sql;
end;
$func$;

-- Expect a successful call returning jsonb (start_live_session).
create or replace function _live_regression.expect_json(p_sql text)
returns jsonb
language plpgsql
as $func$
declare
  v_out jsonb;
begin
  execute p_sql into v_out;
  return v_out;
end;
$func$;

-- Expect a successful scalar call (boolean/void).
create or replace function _live_regression.expect_ok(p_sql text)
returns void
language plpgsql
as $func$
begin
  execute p_sql;
end;
$func$;

-- Act as an authenticated user (claims first, then role; caller resets).
create or replace function _live_regression.act_as(p_user uuid)
returns void
language plpgsql
as $func$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user::text)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$func$;

create or replace function _live_regression.reset_actor()
returns void
language plpgsql
as $func$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$func$;

-- Record + surface a check result (caller pattern below).
create or replace function _live_regression.record(p_name text, p_ok boolean, p_detail text default null)
returns void
language plpgsql
as $func$
begin
  insert into _live_regression.results (check_name, outcome)
  values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_detail, 'no detail') end);
  if not p_ok then
    raise exception 'REGRESSION_FAIL %: %', p_name, coalesce(p_detail, '');
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 1 — Producer authorization (policy §2.2, tech §4.2)
-- ===========================================================================
create or replace function _live_regression.check_producer_authorization()
returns void
language plpgsql
as $func$
declare f record; v_start jsonb; v_replay jsonb;
begin
  select * into f from _live_regression.fixture();

  -- Non-member (even verified) cannot start.
  perform _live_regression.act_as(f.user_b);
  perform _live_regression.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_unauth', 'input-unauth'),
    '42501', 'producer_authorization_required%');

  -- Editor cannot start (owner/manager only).
  perform _live_regression.act_as(f.user_c);
  perform _live_regression.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_editor', 'input-editor'),
    '42501', 'producer_authorization_required%');

  -- Owner can start; replay returns the same session marked replayed.
  perform _live_regression.act_as(f.user_a);
  v_start := _live_regression.expect_json(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_ok', 'input-owner'));
  if coalesce(v_start->>'sessionId', '') = '' or coalesce(v_start->>'replayed', 'false') <> 'false' then
    raise exception 'assertion_failed: owner start did not create a session: %', v_start;
  end if;
  v_replay := _live_regression.expect_json(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_ok', 'input-owner'));
  if v_replay->>'sessionId' <> v_start->>'sessionId' or v_replay->>'replayed' <> 'true' then
    raise exception 'assertion_failed: idempotent replay mismatch: % vs %', v_start, v_replay;
  end if;

  -- End is explicitly idempotent: same key replays success without another
  -- session_ended audit row.
  if not public.end_live_session(
    v_start->>'sessionId',
    'reg_end_key',
    'producer_ended',
    'regression'
  ) then
    raise exception 'assertion_failed: first end did not succeed';
  end if;

  if not public.end_live_session(
    v_start->>'sessionId',
    'reg_end_key',
    'producer_ended',
    'regression'
  ) then
    raise exception 'assertion_failed: end replay did not succeed';
  end if;

  if (
    select count(*)
    from public.live_audit
    where live_session_id = v_start->>'sessionId'
      and action = 'session_ended'
  ) <> 1 then
    raise exception 'assertion_failed: duplicate session_ended audit row';
  end if;

  if public.end_live_session(
    v_start->>'sessionId',
    'different_end_key',
    'producer_ended',
    'regression'
  ) then
    raise exception 'assertion_failed: different end key replayed success';
  end if;

  perform _live_regression.reset_actor();
  perform _live_regression.record('producer_authorization', true);
end;
$func$;

-- ===========================================================================
-- CHECK 2 — Eligibility gate (policy §2.4, §12.2): no active path => deny.
-- ===========================================================================
create or replace function _live_regression.check_eligibility_required()
returns void
language plpgsql
as $func$
declare f record;
begin
  select * into f from _live_regression.fixture();
  delete from public.live_eligibility where producer_id = f.producer_id;

  perform _live_regression.act_as(f.user_a);
  perform _live_regression.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_noelig', 'input-noelig'),
    'P0001', 'live_not_eligible%');

  -- Moderator grant via RPC unlocks the start (rolled back with the check).
  perform _live_regression.act_as(f.moderator);
  perform _live_regression.expect_ok(format(
    'select public.grant_live_eligibility(%L, %L, null::numeric, null::integer)', f.producer_id, 'ADMIN_APPROVED'));

  perform _live_regression.act_as(f.user_a);
  perform _live_regression.expect_ok(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_granted', 'input-granted'));

  -- Revocation closes the door again (audit B2).
  perform _live_regression.act_as(f.moderator);
  perform _live_regression.expect_ok(format(
    'select public.revoke_live_eligibility(%L, %L)', f.producer_id, 'ADMIN_APPROVED'));
  perform _live_regression.act_as(f.user_a);
  perform _live_regression.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_revoked', 'input-revoked'),
    'P0001', 'live_not_eligible%');

  -- Grant path is moderator-only (PO item: B2 authorization).
  perform _live_regression.act_as(f.user_a);
  perform _live_regression.expect_error(format(
    'select public.grant_live_eligibility(%L, %L, null::numeric, null::integer)', f.producer_id, 'CURATED'),
    '42501', 'platform_moderator_required%');

  perform _live_regression.reset_actor();
  perform _live_regression.record('eligibility_required', true);
end;
$func$;

-- ===========================================================================
-- CHECK 3 — Start/End lifecycle + idempotency (tech §4.2/§4.3)
-- ===========================================================================
create or replace function _live_regression.check_start_end_idempotency()
returns void
language plpgsql
as $func$
declare f record; v_sid text;
begin
  select * into f from _live_regression.fixture();
  perform _live_regression.act_as(f.user_a);
  v_sid := coalesce(_live_regression.expect_json(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_life', 'input-life'))->>'sessionId', '');

  -- Producer end succeeds and terminates the session exactly once.
  perform _live_regression.expect_ok(format(
    'select public.end_live_session(%L, %L, %L, %L)', v_sid, 'reg-end-' || v_sid, 'producer_ended', 'regression'));

  -- State assertions run as postgres: live_audit is dark to authenticated
  -- and the ended session leaves the public-read policy by design.
  perform _live_regression.reset_actor();
  if not exists (
    select 1 from public.live_sessions
    where id = v_sid and status = 'ended' and ended_reason = 'producer_ended' and ended_at is not null
  ) then
    raise exception 'assertion_failed: session not ended by producer path';
  end if;
  if exists (select 1 from public.live_sessions where idempotency_key = 'reg_key_life' and id <> v_sid) then
    raise exception 'assertion_failed: idempotency key produced a duplicate session';
  end if;

  -- Idempotent end: replaying end_live_session is a no-op that must not
  -- duplicate audit rows or change state.
  perform _live_regression.act_as(f.user_a);
  perform _live_regression.expect_ok(format(
    'select public.end_live_session(%L, %L, %L, %L)', v_sid, 'reg-end-' || v_sid, 'producer_ended', 'regression'));
  perform _live_regression.reset_actor();
  if 1 <> (select count(*) from public.live_audit
           where live_session_id = v_sid and action = 'session_ended') then
    raise exception 'assertion_failed: repeated end duplicated the audit trail';
  end if;

  perform _live_regression.record('start_end_idempotency', true);
end;
$func$;

-- ===========================================================================
-- CHECK 4 — Caps: per-Place 1, global 5, stage must be published (tech §7)
-- ===========================================================================
create or replace function _live_regression.check_caps()
returns void
language plpgsql
as $func$
declare f record; i int; v_p text; v_s text; v_u uuid; v_pd text;
begin
  select * into f from _live_regression.fixture();

  -- Per-Place: a second active session for the same Place is denied.
  perform _live_regression.act_as(f.user_a);
  perform _live_regression.expect_ok(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_cap_1', 'input-1'));
  perform _live_regression.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_cap_2', 'input-2'),
    'P0001', 'live_place_busy%');

  -- Stage must be published.
  perform _live_regression.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.draft_stage_id, 'reg_cap_draft', 'input-draft'),
    'P0001', 'live_stage_not_published%');

  -- Global: 5 concurrent lives allowed, the 6th denied. The fixture Place
  -- session above is live #1; build 4 more independent producer/place/stage
  -- sets (live #2..#5) committed within this check, rolled back by the
  -- runner. Fixture writes run as postgres — authenticated inserts are
  -- RLS-blocked by design.
  perform _live_regression.reset_actor();
  for i in 1..4 loop
    v_pd := 'reg_cap_prod_' || i;
    v_p := 'reg_cap_place_' || i;
    v_s := 'reg_cap_stage_' || i;
    insert into public.producers (id, display_name) values (v_pd, 'Cap Producer ' || i)
      on conflict (id) do nothing;
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id, publication_status)
    values (v_p, 'Cap Place ' || i, 'Test', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', v_pd, 'published')
      on conflict (id) do nothing;
    insert into public.production_stages (id, place_id, title, description, sort_order, status)
    values (v_s, v_p, 'Cap Stage', 'Test', 0, 'published')
      on conflict (id) do nothing;
    insert into public.live_eligibility (producer_id, path, active, granted_by)
    values (v_pd, 'ADMIN_APPROVED', true, 'regression')
      on conflict (producer_id, path) do update set active = true;
    -- Reuse user_a as owner of every cap Place (memberships are per-Place).
    insert into public.producer_memberships (user_id, producer_id, place_id, role)
    values (f.user_a, v_pd, v_p, 'owner')
      on conflict (user_id, place_id) do nothing;
    -- Start as the owner, then return to postgres so the NEXT iteration's
    -- fixture inserts are not RLS-blocked.
    perform _live_regression.act_as(f.user_a);
    perform _live_regression.expect_ok(format(
      'select public.start_live_session(%L, %L, %L, %L)', v_p, v_s, 'reg_cap_key_' || i, 'input-cap-' || i));
    perform _live_regression.reset_actor();
  end loop;
  -- Now 5 concurrent live (fixture Place + 4 cap places) — the 6th start
  -- must hit the global cap.
  perform _live_regression.act_as(f.user_a);
  perform _live_regression.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_cap_6', 'input-6'),
    'P0001', 'live_cap_denied%');

  perform _live_regression.reset_actor();
  perform _live_regression.record('caps', true);
end;
$func$;

-- ===========================================================================
-- CHECK 5 — Viewer admission: B1 fail-closed DENY (PO 2026-09-18)
-- ===========================================================================
create or replace function _live_regression.check_viewer_admission_b1()
returns void
language plpgsql
as $func$
declare f record; v_sid text;
begin
  select * into f from _live_regression.fixture();
  perform _live_regression.act_as(f.user_a);
  v_sid := coalesce(_live_regression.expect_json(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_b1', 'input-b1'))->>'sessionId', '');

  -- Verified email + live session + public Place still DENIED (no age mechanism).
  perform _live_regression.act_as(f.user_b);
  perform _live_regression.expect_error(format('select public.admit_live_viewer(%L)', v_sid),
    'P0001', 'live_viewer_denied%');
  perform _live_regression.expect_error(format('select public.post_live_comment(%L, %L)', v_sid, 'halo'),
    'P0001', 'live_viewer_denied%');
  perform _live_regression.expect_error(format(
    'select public.submit_live_report(%L, %L, %L, null::text)', v_sid, 'off_platform_meetup', 'regression'),
    'P0001', 'live_viewer_denied%');

  -- Anonymous cannot participate either.
  perform _live_regression.reset_actor();
  perform _live_regression.expect_error(format('select public.admit_live_viewer(%L)', v_sid),
    'P0001', 'live_viewer_denied%');

  perform _live_regression.record('viewer_admission_b1_fail_closed', true);
end;
$func$;

-- ===========================================================================
-- CHECK 6 — Moderation: role gate, end/suspend/review actions (tech §4.4)
-- ===========================================================================
create or replace function _live_regression.check_moderation()
returns void
language plpgsql
as $func$
declare f record; v_sid text; v_state text;
begin
  select * into f from _live_regression.fixture();
  perform _live_regression.act_as(f.user_a);
  v_sid := coalesce(_live_regression.expect_json(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_mod', 'input-mod'))->>'sessionId', '');

  -- Non-moderator cannot moderate.
  perform _live_regression.act_as(f.user_b);
  perform _live_regression.expect_error(format('select public.moderate_live(%L, %L, null::text)', v_sid, 'end'),
    '42501', 'platform_moderator_required%');

  -- Moderator end terminates the session with the moderation reason.
  perform _live_regression.act_as(f.moderator);
  perform _live_regression.expect_ok(format('select public.moderate_live(%L, %L, %L)', v_sid, 'end', 'regression'));
  -- Ended sessions leave the public-read policy; assert as postgres.
  perform _live_regression.reset_actor();
  if not exists (select 1 from public.live_sessions
                 where id = v_sid and status = 'ended' and ended_reason = 'moderation') then
    raise exception 'assertion_failed: moderation end did not terminate the session';
  end if;

  -- Suspend clears ALL eligibility paths for the producer.
  perform _live_regression.act_as(f.user_a);
  v_sid := coalesce(_live_regression.expect_json(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_mod2', 'input-mod2'))->>'sessionId', '');
  perform _live_regression.act_as(f.moderator);
  perform _live_regression.expect_ok(format('select public.moderate_live(%L, %L, null::text)', v_sid, 'suspend'));
  perform _live_regression.reset_actor();
  if exists (select 1 from public.live_eligibility where producer_id = f.producer_id and active) then
    raise exception 'assertion_failed: suspension left eligibility active';
  end if;

  -- flag_review suspends admissions via the content gate (start first again).
  perform _live_regression.act_as(f.moderator);
  perform _live_regression.expect_ok(format(
    'select public.grant_live_eligibility(%L, %L, null::numeric, null::integer)', f.producer_id, 'ADMIN_APPROVED'));
  perform _live_regression.act_as(f.user_a);
  v_sid := coalesce(_live_regression.expect_json(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_mod3', 'input-mod3'))->>'sessionId', '');
  perform _live_regression.act_as(f.moderator);
  perform _live_regression.expect_ok(format('select public.moderate_live(%L, %L, null::text)', v_sid, 'flag_review'));
  perform _live_regression.reset_actor();
  select content_status into v_state from public.live_sessions where id = v_sid;
  if v_state is distinct from 'review' then
    raise exception 'assertion_failed: flag_review did not set content_status=review (got %)', v_state;
  end if;
  perform _live_regression.act_as(f.user_b);
  -- Content gate fires before the age deny by design (tech §5 gate order):
  -- either way the admission is fail-closed DENIED.
  perform _live_regression.expect_error(format('select public.admit_live_viewer(%L)', v_sid),
    'P0001', 'live_content_blocked%'); -- flag_review suspends admissions (defense-in-depth)

  perform _live_regression.reset_actor();
  perform _live_regression.record('moderation', true);
end;
$func$;

-- ===========================================================================
-- CHECK 7 — Stage auto-end (policy §12.1 item 4): pause/archive ends the Live.
-- ===========================================================================
create or replace function _live_regression.check_stage_auto_end()
returns void
language plpgsql
as $func$
declare f record; v_sid text; v_reason text; v_status text;
begin
  select * into f from _live_regression.fixture();
  perform _live_regression.act_as(f.user_a);
  v_sid := coalesce(_live_regression.expect_json(format(
    'select public.start_live_session(%L, %L, %L, %L)', f.place_id, f.stage_id, 'reg_key_stage', 'input-stage'))->>'sessionId', '');
  perform _live_regression.reset_actor();

  -- Unpublish the stage mid-live (as DBA in dev; the trigger must fire).
  update public.production_stages set status = 'paused' where id = f.stage_id;

  select status, ended_reason into v_status, v_reason
  from public.live_sessions where id = v_sid;
  if v_status is distinct from 'ended' or v_reason is distinct from 'source_stage_unpublished' then
    raise exception 'assertion_failed: stage guard did not auto-end (status=%, reason=%)', v_status, v_reason;
  end if;
  perform _live_regression.record('stage_auto_end', true);
end;
$func$;

-- ===========================================================================
-- CHECK 8 — RLS + privilege baseline (fail-closed surface)
-- ===========================================================================
create or replace function _live_regression.check_rls_baseline()
returns void
language plpgsql
as $func$
declare v_enabled boolean;
begin
  for v_enabled in
    select c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('live_eligibility', 'live_sessions', 'live_viewers', 'live_reports', 'live_audit')
  loop
    if not v_enabled then
      raise exception 'assertion_failed: a Live table has RLS disabled';
    end if;
  end loop;

  -- RLS-governed reads restored for authenticated; audit stays dark.
  if not has_table_privilege('authenticated', 'public.live_sessions', 'SELECT') then
    raise exception 'assertion_failed: authenticated lost SELECT on live_sessions';
  end if;
  if has_table_privilege('authenticated', 'public.live_audit', 'SELECT') then
    raise exception 'assertion_failed: live_audit must not be readable by authenticated';
  end if;
  if has_table_privilege('anon', 'public.live_audit', 'SELECT') then
    raise exception 'assertion_failed: live_audit must not be readable by anon';
  end if;
  -- PUBLIC default privileges are revoked (no implicit access).
  if has_table_privilege('public', 'public.live_sessions', 'SELECT') then
    raise exception 'assertion_failed: PUBLIC still holds SELECT on live_sessions';
  end if;
  -- Writes remain RPC-only for every role.
  if has_table_privilege('authenticated', 'public.live_sessions', 'INSERT, UPDATE, DELETE')
     or has_table_privilege('anon', 'public.live_sessions', 'INSERT, UPDATE, DELETE') then
    raise exception 'assertion_failed: direct DML on live_sessions must stay revoked';
  end if;
  if has_table_privilege('public', 'public.live_audit', 'INSERT, UPDATE, DELETE') then
    raise exception 'assertion_failed: direct DML on live_audit must stay revoked';
  end if;
  perform _live_regression.record('rls_privilege_baseline', true);
end;
$func$;

-- ---------------------------------------------------------------------------
-- Runner: one psql-level SAVEPOINT per check. The DO wrapper records PASS/
-- FAIL via NOTICE and a session-scoped GUC counter (survives the savepoint
-- rollback); ROLLBACK TO then discards that check's fixtures. Transaction
-- control at psql top level is valid; inside plpgsql functions it is not.
-- ---------------------------------------------------------------------------
savepoint sp_check_1;
do $run$
begin
  perform _live_regression.check_rls_baseline();
  raise notice 'LIVE-REGRESSION PASS — rls_privilege_baseline';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — rls_privilege_baseline: %', sqlerrm;
end
$run$;
rollback to sp_check_1;

savepoint sp_check_2;
do $run$
begin
  perform _live_regression.check_producer_authorization();
  raise notice 'LIVE-REGRESSION PASS — producer_authorization';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — producer_authorization: %', sqlerrm;
end
$run$;
rollback to sp_check_2;

savepoint sp_check_3;
do $run$
begin
  perform _live_regression.check_eligibility_required();
  raise notice 'LIVE-REGRESSION PASS — eligibility_required';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — eligibility_required: %', sqlerrm;
end
$run$;
rollback to sp_check_3;

savepoint sp_check_4;
do $run$
begin
  perform _live_regression.check_start_end_idempotency();
  raise notice 'LIVE-REGRESSION PASS — start_end_idempotency';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — start_end_idempotency: %', sqlerrm;
end
$run$;
rollback to sp_check_4;

savepoint sp_check_5;
do $run$
begin
  perform _live_regression.check_caps();
  raise notice 'LIVE-REGRESSION PASS — caps';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — caps: %', sqlerrm;
end
$run$;
rollback to sp_check_5;

savepoint sp_check_6;
do $run$
begin
  perform _live_regression.check_viewer_admission_b1();
  raise notice 'LIVE-REGRESSION PASS — viewer_admission_b1_fail_closed';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — viewer_admission_b1_fail_closed: %', sqlerrm;
end
$run$;
rollback to sp_check_6;

savepoint sp_check_7;
do $run$
begin
  perform _live_regression.check_moderation();
  raise notice 'LIVE-REGRESSION PASS — moderation';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — moderation: %', sqlerrm;
end
$run$;
rollback to sp_check_7;

savepoint sp_check_8;
do $run$
begin
  perform _live_regression.check_stage_auto_end();
  raise notice 'LIVE-REGRESSION PASS — stage_auto_end';
exception when others then
  perform set_config('_live_regression.failed', (coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-REGRESSION FAIL — stage_auto_end: %', sqlerrm;
end
$run$;
rollback to sp_check_8;

do $verdict$
declare
  v_failed int := coalesce(nullif(current_setting('_live_regression.failed', true), ''), '0')::int;
begin
  if v_failed > 0 then
    raise exception 'LIVE REGRESSION SUITE FAILED: % check(s) failed', v_failed;
  end if;
  raise notice 'LIVE REGRESSION SUITE: ALL CHECKS PASSED';
end
$verdict$;

rollback; -- everything above is a dry run against the DEVELOPMENT database
