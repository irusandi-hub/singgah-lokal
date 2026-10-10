-- ============================================================================
-- LIVE OPERATOR ACCESS CHECK — migrations 0047 + 0048 + 0049
-- Target: Supabase DEVELOPMENT project ONLY. NEVER production.
--
-- Run AFTER 0047, 0048 and 0049 are applied, via the Supabase SQL Editor or:
--   psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-operator-invitations-access.sql
--
-- What it proves (the 0049 authority rule, end to end, on the real engine):
--   1. an owner/manager can still start and end Live (no regression);
--   2. a delegated operator holding an ACCEPTED invitation can start AND end;
--      the session belongs to the granting Producer (live_operators.granted_by);
--   3. once that invitation is REVOKED, the operator's very next start and end
--      are refused (authorization is inside the RPC, nothing is cached);
--   4. an operator of Place A cannot start or end Live for Place B;
--   5. an unrelated authenticated account and an editor are refused;
--   6. anon holds no EXECUTE on either Live RPC and cannot probe the internal
--      authority predicate.
--
-- Design (same harness as live-regression.sql):
--   * Error expectations use plpgsql BEGIN...EXCEPTION blocks — a caught
--     exception IS a subtransaction, so partial writes of a failed RPC roll
--     back by themselves.
--   * Fixture isolation per check: each check runs inside its own top-level
--     SAVEPOINT and is ROLLBACKed afterwards, so the suite leaves NO data
--     behind. The whole file is wrapped in one transaction that ends in
--     `rollback;`.
--   * Role switching uses set_config('role', ...) + request.jwt.claims, so the
--     RPC authorization runs exactly as it does in production.
--   * A session-scoped GUC counts FAILs across per-check rollbacks; the final
--     verdict raises (non-zero exit) if any check failed.
-- ============================================================================
\set ON_ERROR_STOP on
begin;

create schema if not exists _live_operator_access;

-- Helpers are called from within the authenticated context (after act_as), so
-- the role needs USAGE on this postgres-owned schema. Transactional grant: it
-- disappears with the suite's final ROLLBACK.
grant usage on schema _live_operator_access to authenticated;

create table _live_operator_access.results (
  id serial primary key,
  check_name text not null,
  outcome text not null
);

-- ---------------------------------------------------------------------------
-- Fixture: two Places with separate Producers, plus a delegated operator, an
-- unrelated authenticated account, and an editor. Returns handles; the check's
-- rollback discards every row.
-- ---------------------------------------------------------------------------
create or replace function _live_operator_access.fixture()
returns table (
  manager_a uuid,
  manager_b uuid,
  operator uuid,
  outsider uuid,
  editor uuid,
  producer_a text,
  producer_b text,
  place_a text,
  place_b text,
  stage_a text,
  stage_b text
)
language plpgsql
as $func$
declare
  v_manager_a uuid := gen_random_uuid();
  v_manager_b uuid := gen_random_uuid();
  v_operator  uuid := gen_random_uuid();
  v_outsider  uuid := gen_random_uuid();
  v_editor    uuid := gen_random_uuid();
  v_producer_a text := 'loa_producer_a';
  v_producer_b text := 'loa_producer_b';
  v_place_a text := 'loa_place_a';
  v_place_b text := 'loa_place_b';
  v_stage_a text := 'loa_stage_a';
  v_stage_b text := 'loa_stage_b';
begin
  -- 0001's handle_new_user trigger mirrors every auth.users row into public.users.
  insert into auth.users (id, email, email_confirmed_at, encrypted_password)
  values
    (v_manager_a, 'loa-manager-a@test.local', now(), 'x'),
    (v_manager_b, 'loa-manager-b@test.local', now(), 'x'),
    (v_operator,  'loa-operator@test.local',  now(), 'x'),
    (v_outsider,  'loa-outsider@test.local',  now(), 'x'),
    (v_editor,    'loa-editor@test.local',    now(), 'x');

  insert into public.producers (id, display_name)
  values (v_producer_a, 'LOA Producer A'), (v_producer_b, 'LOA Producer B');

  insert into public.places
    (id, name, short_description, category, type, area, timezone, currency, producer_id, publication_status)
  values
    (v_place_a, 'LOA Place A', 'Test', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', v_producer_a, 'published'),
    (v_place_b, 'LOA Place B', 'Test', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', v_producer_b, 'published');

  insert into public.production_stages (id, place_id, title, description, sort_order, status)
  values
    (v_stage_a, v_place_a, 'LOA Stage A', 'Test', 0, 'published'),
    (v_stage_b, v_place_b, 'LOA Stage B', 'Test', 0, 'published');

  insert into public.producer_memberships (user_id, producer_id, place_id, role)
  values
    (v_manager_a, v_producer_a, v_place_a, 'owner'),
    (v_manager_b, v_producer_b, v_place_b, 'owner'),
    (v_editor,    v_producer_a, v_place_a, 'editor');

  insert into public.live_eligibility (producer_id, path, active, granted_by)
  values
    (v_producer_a, 'ADMIN_APPROVED', true, 'loa'),
    (v_producer_b, 'ADMIN_APPROVED', true, 'loa');

  return query
    select v_manager_a, v_manager_b, v_operator, v_outsider, v_editor,
           v_producer_a, v_producer_b, v_place_a, v_place_b, v_stage_a, v_stage_b;
end;
$func$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function _live_operator_access.act_as(p_user uuid)
returns void
language plpgsql
as $func$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user::text)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$func$;

create or replace function _live_operator_access.act_as_anon()
returns void
language plpgsql
as $func$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end;
$func$;

create or replace function _live_operator_access.reset_actor()
returns void
language plpgsql
as $func$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$func$;

-- Expect a failing call: compare SQLSTATE (and optionally the message prefix).
create or replace function _live_operator_access.expect_error(
  p_sql text,
  p_state text,
  p_msg_like text default null
)
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

create or replace function _live_operator_access.expect_json(p_sql text)
returns jsonb
language plpgsql
as $func$
declare v_out jsonb;
begin
  execute p_sql into v_out;
  return v_out;
end;
$func$;

-- Invite `p_email` to `p_place` as manager and accept as `p_invitee`.
-- Returns the invitation id so the revocation check can reuse it.
create or replace function _live_operator_access.invite_and_accept(
  p_manager uuid,
  p_place text,
  p_email text,
  p_invitee uuid
)
returns uuid
language plpgsql
as $func$
declare
  v_id uuid;
begin
  perform _live_operator_access.act_as(p_manager);
  perform public.invite_live_operator(p_place, p_email);
  perform _live_operator_access.reset_actor();

  select i.id into v_id
  from public.live_operator_invitations i
  where i.place_id = p_place
    and i.status = 'pending'
  order by i.created_at desc
  limit 1;

  if v_id is null then
    raise exception 'assertion_failed: invitation was not created for %', p_place;
  end if;

  perform _live_operator_access.act_as(p_invitee);
  perform public.accept_live_operator_invitation(v_id);
  perform _live_operator_access.reset_actor();

  return v_id;
end;
$func$;

-- ===========================================================================
-- CHECK 1 — Owner/manager path is unchanged (no regression)
-- ===========================================================================
create or replace function _live_operator_access.check_manager_still_works()
returns void
language plpgsql
as $func$
declare f record; v_start jsonb; v_sid text;
begin
  select * into f from _live_operator_access.fixture();

  perform _live_operator_access.act_as(f.manager_a);

  v_start := _live_operator_access.expect_json(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_mgr_key', 'loa-input-mgr'));
  v_sid := v_start->>'sessionId';
  if coalesce(v_sid, '') = '' then
    raise exception 'assertion_failed: manager start returned no session: %', v_start;
  end if;

  if not public.end_live_session(v_sid, 'loa_mgr_end_key', 'producer_ended', 'loa') then
    raise exception 'assertion_failed: manager could not end the session';
  end if;

  perform _live_operator_access.reset_actor();

  if (select producer_id from public.live_sessions where id = v_sid) <> f.producer_a then
    raise exception 'assertion_failed: manager session did not keep the membership producer';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 2 — An accepted operator can start AND end; producer is granted_by
-- ===========================================================================
create or replace function _live_operator_access.check_operator_can_operate()
returns void
language plpgsql
as $func$
declare f record; v_start jsonb; v_sid text; v_active int;
begin
  select * into f from _live_operator_access.fixture();

  perform _live_operator_access.invite_and_accept(
    f.manager_a, f.place_a, 'loa-operator@test.local', f.operator);

  perform _live_operator_access.reset_actor();

  select count(*) into v_active
  from public.live_operators
  where user_id = f.operator and place_id = f.place_a and revoked_at is null;
  if v_active <> 1 then
    raise exception 'assertion_failed: accept did not create one active assignment (got %)', v_active;
  end if;

  -- The internal predicate agrees, and is scoped to the exact Place.
  if not public.can_operate_live_for_place(f.operator, f.place_a) then
    raise exception 'assertion_failed: predicate false for the active operator';
  end if;
  if public.can_operate_live_for_place(f.operator, f.place_b) then
    raise exception 'assertion_failed: predicate leaked the operator into Place B';
  end if;

  perform _live_operator_access.act_as(f.operator);

  v_start := _live_operator_access.expect_json(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_op_key', 'loa-input-op'));
  v_sid := v_start->>'sessionId';
  if coalesce(v_sid, '') = '' then
    raise exception 'assertion_failed: operator start returned no session: %', v_start;
  end if;

  if not public.end_live_session(v_sid, 'loa_op_end_key', 'producer_ended', 'loa') then
    raise exception 'assertion_failed: operator could not end the session';
  end if;

  perform _live_operator_access.reset_actor();

  if (select producer_id from public.live_sessions where id = v_sid) <> f.producer_a then
    raise exception 'assertion_failed: operator session producer is not the granting Producer';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 3 — A revoked operator is refused on the VERY NEXT start and end
-- ===========================================================================
create or replace function _live_operator_access.check_revoke_denies_next_call()
returns void
language plpgsql
as $func$
declare f record; v_invitation uuid; v_start jsonb; v_sid text; v_active int;
begin
  select * into f from _live_operator_access.fixture();

  v_invitation := _live_operator_access.invite_and_accept(
    f.manager_a, f.place_a, 'loa-operator@test.local', f.operator);

  -- The operator starts a session while still authorized...
  perform _live_operator_access.act_as(f.operator);
  v_start := _live_operator_access.expect_json(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_pre_revoke_key', 'loa-input-pre-revoke'));
  v_sid := v_start->>'sessionId';
  perform _live_operator_access.reset_actor();

  -- ...the manager revokes the accepted invitation...
  perform _live_operator_access.act_as(f.manager_a);
  perform public.revoke_live_operator_invitation(v_invitation);
  perform _live_operator_access.reset_actor();

  select count(*) into v_active
  from public.live_operators
  where user_id = f.operator and place_id = f.place_a and revoked_at is null;
  if v_active <> 0 then
    raise exception 'assertion_failed: revoke left an active assignment (got %)', v_active;
  end if;

  -- ...and the operator's very next calls are refused, inside the RPC.
  perform _live_operator_access.act_as(f.operator);

  perform _live_operator_access.expect_error(
    format('select public.end_live_session(%L, %L, %L, %L)',
           v_sid, 'loa_post_revoke_end', 'producer_ended', 'loa'),
    '42501', 'producer_authorization_required%');

  perform _live_operator_access.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_post_revoke_start', 'loa-input-post-revoke'),
    '42501', 'producer_authorization_required%');

  perform _live_operator_access.reset_actor();
end;
$func$;

-- ===========================================================================
-- CHECK 4 — An operator of Place A cannot start or end Live for Place B
-- ===========================================================================
create or replace function _live_operator_access.check_cross_place_denied()
returns void
language plpgsql
as $func$
declare f record; v_b jsonb; v_sid_b text;
begin
  select * into f from _live_operator_access.fixture();

  perform _live_operator_access.invite_and_accept(
    f.manager_a, f.place_a, 'loa-operator@test.local', f.operator);

  -- Place B's own owner starts a session there.
  perform _live_operator_access.act_as(f.manager_b);
  v_b := _live_operator_access.expect_json(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_b, f.stage_b, 'loa_place_b_key', 'loa-input-place-b'));
  v_sid_b := v_b->>'sessionId';
  perform _live_operator_access.reset_actor();

  perform _live_operator_access.act_as(f.operator);

  perform _live_operator_access.expect_error(
    format('select public.end_live_session(%L, %L, %L, %L)',
           v_sid_b, 'loa_cross_end', 'producer_ended', 'loa'),
    '42501', 'producer_authorization_required%');

  perform _live_operator_access.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_b, f.stage_b, 'loa_cross_start', 'loa-input-cross-start'),
    '42501', 'producer_authorization_required%');

  perform _live_operator_access.reset_actor();
end;
$func$;

-- ===========================================================================
-- CHECK 5 — An unrelated account and an editor are refused
-- ===========================================================================
create or replace function _live_operator_access.check_others_denied()
returns void
language plpgsql
as $func$
declare f record; v_start jsonb; v_sid text;
begin
  select * into f from _live_operator_access.fixture();

  -- Manager A opens a session so the editor can also be refused on END.
  perform _live_operator_access.act_as(f.manager_a);
  v_start := _live_operator_access.expect_json(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_others_key', 'loa-input-others'));
  v_sid := v_start->>'sessionId';
  perform _live_operator_access.reset_actor();

  -- Unrelated authenticated account: no start.
  perform _live_operator_access.act_as(f.outsider);
  perform _live_operator_access.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_outsider_key', 'loa-input-outsider'),
    '42501', 'producer_authorization_required%');
  perform _live_operator_access.reset_actor();

  -- Editor: no start, and no end either.
  perform _live_operator_access.act_as(f.editor);
  perform _live_operator_access.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_editor_key', 'loa-input-editor'),
    '42501', 'producer_authorization_required%');
  perform _live_operator_access.expect_error(
    format('select public.end_live_session(%L, %L, %L, %L)',
           v_sid, 'loa_editor_end_key', 'producer_ended', 'loa'),
    '42501', 'producer_authorization_required%');
  perform _live_operator_access.reset_actor();
end;
$func$;

-- ===========================================================================
-- CHECK 6 — anon is fully outside: no EXECUTE, no predicate probe
-- ===========================================================================
create or replace function _live_operator_access.check_anon_locked_out()
returns void
language plpgsql
as $func$
declare f record;
begin
  select * into f from _live_operator_access.fixture();
  perform _live_operator_access.reset_actor();

  if has_function_privilege('anon', 'public.start_live_session(text,text,text,text)', 'EXECUTE') then
    raise exception 'assertion_failed: anon holds EXECUTE on start_live_session';
  end if;
  if has_function_privilege('anon', 'public.end_live_session(text,text,text,text)', 'EXECUTE') then
    raise exception 'assertion_failed: anon holds EXECUTE on end_live_session';
  end if;
  if has_function_privilege('authenticated', 'public.can_operate_live_for_place(uuid,text)', 'EXECUTE') then
    raise exception 'assertion_failed: authenticated can probe the internal authority predicate';
  end if;

  -- And the call itself is refused at the privilege gate (not merely at authz).
  perform _live_operator_access.act_as_anon();
  perform _live_operator_access.expect_error(
    format('select public.start_live_session(%L, %L, %L, %L)',
           f.place_a, f.stage_a, 'loa_anon_key', 'loa-input-anon'),
    '42501', '%');
  perform _live_operator_access.reset_actor();
end;
$func$;

-- ===========================================================================
-- Runner — one savepoint per check; failures counted in a session GUC.
-- ===========================================================================
savepoint sp_loa_1;
do $run$
begin
  perform _live_operator_access.check_manager_still_works();
  raise notice 'LIVE-OPERATOR-ACCESS PASS — manager_still_works';
exception when others then
  perform set_config('_live_operator_access.failed', (coalesce(nullif(current_setting('_live_operator_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-OPERATOR-ACCESS FAIL — manager_still_works: %', sqlerrm;
end
$run$;
rollback to sp_loa_1;

savepoint sp_loa_2;
do $run$
begin
  perform _live_operator_access.check_operator_can_operate();
  raise notice 'LIVE-OPERATOR-ACCESS PASS — operator_can_operate';
exception when others then
  perform set_config('_live_operator_access.failed', (coalesce(nullif(current_setting('_live_operator_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-OPERATOR-ACCESS FAIL — operator_can_operate: %', sqlerrm;
end
$run$;
rollback to sp_loa_2;

savepoint sp_loa_3;
do $run$
begin
  perform _live_operator_access.check_revoke_denies_next_call();
  raise notice 'LIVE-OPERATOR-ACCESS PASS — revoke_denies_next_call';
exception when others then
  perform set_config('_live_operator_access.failed', (coalesce(nullif(current_setting('_live_operator_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-OPERATOR-ACCESS FAIL — revoke_denies_next_call: %', sqlerrm;
end
$run$;
rollback to sp_loa_3;

savepoint sp_loa_4;
do $run$
begin
  perform _live_operator_access.check_cross_place_denied();
  raise notice 'LIVE-OPERATOR-ACCESS PASS — cross_place_denied';
exception when others then
  perform set_config('_live_operator_access.failed', (coalesce(nullif(current_setting('_live_operator_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-OPERATOR-ACCESS FAIL — cross_place_denied: %', sqlerrm;
end
$run$;
rollback to sp_loa_4;

savepoint sp_loa_5;
do $run$
begin
  perform _live_operator_access.check_others_denied();
  raise notice 'LIVE-OPERATOR-ACCESS PASS — others_denied';
exception when others then
  perform set_config('_live_operator_access.failed', (coalesce(nullif(current_setting('_live_operator_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-OPERATOR-ACCESS FAIL — others_denied: %', sqlerrm;
end
$run$;
rollback to sp_loa_5;

savepoint sp_loa_6;
do $run$
begin
  perform _live_operator_access.check_anon_locked_out();
  raise notice 'LIVE-OPERATOR-ACCESS PASS — anon_locked_out';
exception when others then
  perform set_config('_live_operator_access.failed', (coalesce(nullif(current_setting('_live_operator_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'LIVE-OPERATOR-ACCESS FAIL — anon_locked_out: %', sqlerrm;
end
$run$;
rollback to sp_loa_6;

do $verdict$
declare
  v_failed int := coalesce(nullif(current_setting('_live_operator_access.failed', true), ''), '0')::int;
begin
  if v_failed > 0 then
    raise exception 'LIVE OPERATOR ACCESS CHECK FAILED: % check(s) failed', v_failed;
  end if;
  raise notice 'LIVE OPERATOR ACCESS: ALL CHECKS PASSED';
end
$verdict$;

rollback; -- everything above is a dry run against the DEVELOPMENT database
