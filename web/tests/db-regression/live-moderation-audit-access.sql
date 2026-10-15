-- live-moderation-audit-access.sql — LIVE-D (migration 0056).
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-moderation-audit-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/live-moderation-audit-trail.test.ts.
--
-- Contract verified (docs/audits/LIVE_AUTH_AUDIT_v1.md A-08/A-10/A-11/A-12/A-13):
--   A-12  the operator policies no longer reference public.live_operators, so an
--         anon read of live_sessions/places works again while the provider
--         columns stay invisible;
--   A-11  list_place_live_audit is owner/manager + Place-scoped only, granted to
--         authenticated (never anon), and live_audit stays dark;
--   A-10  only platform_moderator may suspend/restore the account Live
--         capability; the decision is audited with actor/target/reason and is
--         idempotent; a suspended account cannot start Live;
--   A-13  the inert in-transaction denial insert is gone; the recorder is
--         service-role only.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check. The whole script runs in ONE transaction and ends with `rollback;`,
-- so it leaves no data behind.

begin;

create temporary table live_moderation_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('ddddddd3-0000-4000-8000-000000000001', 'owner-mod-dev@example.com', now()),
  ('ddddddd3-0000-4000-8000-000000000002', 'editor-mod-dev@example.com', now()),
  ('ddddddd3-0000-4000-8000-000000000003', 'operator-mod-dev@example.com', now()),
  ('ddddddd3-0000-4000-8000-000000000004', 'other-mod-dev@example.com', now()),
  ('ddddddd3-0000-4000-8000-000000000005', 'mod-mod-dev@example.com', now()),
  ('ddddddd3-0000-4000-8000-000000000006', 'streamer-mod-dev@example.com', now()),
  ('ddddddd3-0000-4000-8000-000000000007', 'viewer-mod-dev@example.com', now())
on conflict (id) do nothing;

insert into public.users (id, platform_role) values
  ('ddddddd3-0000-4000-8000-000000000001', null),
  ('ddddddd3-0000-4000-8000-000000000002', null),
  ('ddddddd3-0000-4000-8000-000000000003', null),
  ('ddddddd3-0000-4000-8000-000000000004', null),
  ('ddddddd3-0000-4000-8000-000000000005', 'platform_moderator'),
  ('ddddddd3-0000-4000-8000-000000000006', null),
  ('ddddddd3-0000-4000-8000-000000000007', null)
on conflict (id) do update set platform_role = excluded.platform_role;

insert into public.producers (id, display_name) values
  ('prod-mod-dev', 'Pengelola Mod DEV'), ('prod-mod-dev-c', 'Pengelola Mod DEV C')
on conflict (id) do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status) values
  ('stage-mod-dev', 'rumah-teh-lokal', 'Tahap Mod DEV', 'x', 0, 'published'),
  ('stage-mod-dev-b', 'kopi-dari-kebun', 'Tahap Mod DEV B', 'x', 0, 'published'),
  ('stage-mod-dev-c', 'dapur-rasa', 'Tahap Mod DEV C', 'x', 0, 'published')
on conflict (id) do nothing;

insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key) values
  ('live-mod-dev', 'rumah-teh-lokal', 'prod-mod-dev', 'stage-mod-dev', 'live', 'mod-dev-key-1'),
  ('live-mod-dev-b', 'kopi-dari-kebun', 'prod-mod-dev', 'stage-mod-dev-b', 'live', 'mod-dev-key-2')
on conflict (id) do nothing;

insert into public.live_eligibility (producer_id, path, active) values
  ('prod-mod-dev', 'ADMIN_APPROVED', true), ('prod-mod-dev-c', 'ADMIN_APPROVED', true)
on conflict (producer_id, path) do nothing;

insert into public.producer_memberships (user_id, producer_id, place_id, role) values
  ('ddddddd3-0000-4000-8000-000000000001', 'prod-mod-dev', 'rumah-teh-lokal', 'owner'),
  ('ddddddd3-0000-4000-8000-000000000002', 'prod-mod-dev', 'rumah-teh-lokal', 'editor'),
  ('ddddddd3-0000-4000-8000-000000000004', 'prod-mod-dev', 'kopi-dari-kebun', 'owner'),
  ('ddddddd3-0000-4000-8000-000000000006', 'prod-mod-dev-c', 'dapur-rasa', 'owner')
on conflict (user_id, place_id) do nothing;

insert into public.live_operators (user_id, place_id, granted_by) values
  ('ddddddd3-0000-4000-8000-000000000003', 'rumah-teh-lokal', 'prod-mod-dev')
on conflict (user_id, place_id) do nothing;

insert into public.live_audit (live_session_id, action, detail) values
  ('live-mod-dev', 'session_started', '{"dev":true}'::jsonb),
  ('live-mod-dev-b', 'session_started', '{"dev":true}'::jsonb);

-- ---------------------------------------------------------------------------
-- 1. A-12 — the operator policies no longer reference the operator table
-- ---------------------------------------------------------------------------
insert into live_moderation_checks values
  (1, 'operator_helper_exists_and_pinned',
      exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'is_active_live_operator_for_place'
          and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public%'
      ),
      'SECURITY DEFINER + search_path pinned'),
  (2, 'anon_has_execute_on_operator_helper',
      has_function_privilege('anon', 'public.is_active_live_operator_for_place(text)', 'EXECUTE'),
      'policy expression is evaluable by anon'),
  (3, 'anon_still_has_no_privilege_on_live_operators',
      not has_table_privilege('anon', 'public.live_operators', 'SELECT'),
      'no grant is widened to anon'),
  (4, 'live_sessions_operator_policy_uses_helper',
      exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'live_sessions'
          and policyname = 'live_sessions_live_operator_read'
          and qual like '%is_active_live_operator_for_place%'
          and qual not like '%live_operators%'
      ),
      'no direct table reference in the policy'),
  (5, 'places_operator_policy_uses_helper',
      exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'places'
          and policyname = 'places_live_operator_read'
          and qual like '%is_active_live_operator_for_place%'
          and qual not like '%live_operators%'
      ),
      'places operator read fixed too'),
  (6, 'stages_operator_policy_uses_helper',
      exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'production_stages'
          and policyname = 'production_stages_live_operator_read'
          and qual like '%is_active_live_operator_for_place%'
          and qual not like '%live_operators%'
      ),
      'stages operator read fixed too');

do $$
declare
  v_detail text;
begin
  -- anon reads public Live metadata again (previously: permission denied for
  -- table live_operators, before any row was considered).
  execute 'set role anon';
  begin
    perform 1 from public.live_sessions where status = 'live' limit 1;
    execute 'reset role';
    insert into live_moderation_checks values
      (7, 'anon_reads_live_sessions', true, 'no operator ACL error');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values (7, 'anon_reads_live_sessions', false, sqlerrm);
  end;

  execute 'set role anon';
  begin
    perform 1 from public.places limit 1;
    execute 'reset role';
    insert into live_moderation_checks values (8, 'anon_reads_places', true, 'public discovery intact');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values (8, 'anon_reads_places', false, sqlerrm);
  end;

  execute 'set role anon';
  begin
    execute 'select live_input_id from public.live_sessions limit 1';
    execute 'reset role';
    insert into live_moderation_checks values
      (9, 'anon_denied_provider_column', false, 'provider pointer unexpectedly readable');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values
      (9, 'anon_denied_provider_column',
          sqlerrm ilike '%permission denied%', sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 2. A-11 — Place-scoped audit reader
-- ---------------------------------------------------------------------------
insert into live_moderation_checks values
  (20, 'audit_reader_pinned_security_definer',
      exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'list_place_live_audit'
          and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public%'
      ),
      'list_place_live_audit'),
  (21, 'audit_reader_granted_to_authenticated_only',
      has_function_privilege('authenticated', 'public.list_place_live_audit(text)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.list_place_live_audit(text)', 'EXECUTE'),
      'no anon surface'),
  (22, 'live_audit_has_no_select_grant_for_authenticated',
      not has_table_privilege('authenticated', 'public.live_audit', 'SELECT'),
      'the table itself stays dark (tech §3)');

do $$
declare
  v_count integer;
begin
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000001","role":"authenticated"}', false);
    select count(*) into v_count from public.list_place_live_audit('rumah-teh-lokal');
    execute 'reset role';
    insert into live_moderation_checks values
      (23, 'owner_reads_own_place_audit', v_count = 1, 'rows: ' || coalesce(v_count::text, '0'));
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values (23, 'owner_reads_own_place_audit', false, sqlerrm);
  end;

  -- editor, delegated operator and another Place's producer are refused.
  declare
    v_sub  text;
    v_name text;
  begin
    foreach v_sub in array array[
      'ddddddd3-0000-4000-8000-000000000002',
      'ddddddd3-0000-4000-8000-000000000003',
      'ddddddd3-0000-4000-8000-000000000004'
    ] loop
      v_name := case v_sub
        when 'ddddddd3-0000-4000-8000-000000000002' then 'editor'
        when 'ddddddd3-0000-4000-8000-000000000003' then 'delegated_operator'
        else 'other_place_producer' end;
      execute 'set role authenticated';
      begin
        perform set_config('request.jwt.claims',
          '{"sub":"' || v_sub || '","role":"authenticated"}', false);
        perform public.list_place_live_audit('rumah-teh-lokal');
        execute 'reset role';
        insert into live_moderation_checks values
          (24, v_name || '_denied_place_audit', false, 'unexpectedly allowed');
      exception when others then
        execute 'reset role';
        insert into live_moderation_checks values
          (24, v_name || '_denied_place_audit', sqlerrm = 'producer_authorization_required', sqlerrm);
      end;
    end loop;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. A-10 — account Live-capability suspension
-- ---------------------------------------------------------------------------
insert into live_moderation_checks values
  (30, 'suspension_table_rls_on_no_client_policy',
      (select relrowsecurity from pg_class where oid = 'public.live_capability_suspensions'::regclass)
      and not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'live_capability_suspensions'
      ),
      'zero client access'),
  (31, 'suspension_enforced_in_authority_predicate',
      (select prosrc from pg_proc where proname = 'can_operate_live_for_place')
        like '%is_live_account_suspended%',
      'start and end share the predicate');

do $$
declare
  v_body text;
  v_audit integer;
  v_rows integer;
begin
  -- Non-moderator authorities are refused; a viewer too.
  declare
    v_sub  text;
    v_name text;
  begin
    foreach v_sub in array array[
      'ddddddd3-0000-4000-8000-000000000001',
      'ddddddd3-0000-4000-8000-000000000002',
      'ddddddd3-0000-4000-8000-000000000003',
      'ddddddd3-0000-4000-8000-000000000007'
    ] loop
      v_name := case v_sub
        when 'ddddddd3-0000-4000-8000-000000000001' then 'owner'
        when 'ddddddd3-0000-4000-8000-000000000002' then 'editor'
        when 'ddddddd3-0000-4000-8000-000000000003' then 'delegated_operator'
        else 'viewer' end;
      execute 'set role authenticated';
      begin
        perform set_config('request.jwt.claims',
          '{"sub":"' || v_sub || '","role":"authenticated"}', false);
        perform public.suspend_live_capability('ddddddd3-0000-4000-8000-000000000006', 'x');
        execute 'reset role';
        insert into live_moderation_checks values
          (32, v_name || '_cannot_suspend_live_capability', false, 'unexpectedly allowed');
      exception when others then
        execute 'reset role';
        insert into live_moderation_checks values
          (32, v_name || '_cannot_suspend_live_capability',
              sqlerrm = 'platform_moderator_required', sqlerrm);
      end;
    end loop;
  end;

  -- The moderator suspends the streamer owner.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000005","role":"authenticated"}', false);
    perform public.suspend_live_capability('ddddddd3-0000-4000-8000-000000000006', 'dev-check');
    perform public.suspend_live_capability('ddddddd3-0000-4000-8000-000000000006', 'again');
    execute 'reset role';
    select count(*) into v_rows from public.live_capability_suspensions
      where user_id = 'ddddddd3-0000-4000-8000-000000000006' and revoked_at is null;
    select count(*) into v_audit from public.live_audit where action = 'live_capability_suspended';
    insert into live_moderation_checks values
      (33, 'moderator_suspend_is_idempotent_and_audited',
          v_rows = 1 and v_audit = 1,
          'rows=' || coalesce(v_rows::text, '?') || ' audit=' || coalesce(v_audit::text, '?'));
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values
      (33, 'moderator_suspend_is_idempotent_and_audited', false, sqlerrm);
  end;

  -- The suspended account cannot start Live.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000006","role":"authenticated"}', false);
    perform public.start_live_session('dapur-rasa', 'stage-mod-dev-c', 'mod-dev-susp', null);
    execute 'reset role';
    insert into live_moderation_checks values
      (34, 'suspended_account_cannot_start', false, 'unexpectedly allowed');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values
      (34, 'suspended_account_cannot_start',
          sqlerrm = 'producer_authorization_required', sqlerrm);
  end;

  -- Restore (moderator only) re-enables it.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000005","role":"authenticated"}', false);
    perform public.restore_live_capability('ddddddd3-0000-4000-8000-000000000006', 'dev-restore');
    execute 'reset role';
    insert into live_moderation_checks values
      (35, 'moderator_restore_audited',
          exists (select 1 from public.live_audit where action = 'live_capability_restored'),
          'audit row present');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values (35, 'moderator_restore_audited', false, sqlerrm);
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000006","role":"authenticated"}', false);
    execute 'select public.start_live_session(''dapur-rasa'', ''stage-mod-dev-c'', ''mod-dev-restored'', null)';
    execute 'reset role';
    insert into live_moderation_checks values
      (36, 'restored_account_can_start', true, 'broadcasting re-enabled');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values (36, 'restored_account_can_start', false, sqlerrm);
  end;

  -- Producer cannot undo the moderation: no restore path for a non-moderator.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.restore_live_capability('ddddddd3-0000-4000-8000-000000000006', 'self');
    execute 'reset role';
    insert into live_moderation_checks values
      (37, 'producer_cannot_restore_capability', false, 'unexpectedly allowed');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values
      (37, 'producer_cannot_restore_capability',
          sqlerrm = 'platform_moderator_required', sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 4. A-13 — out-of-band denial recording (service role only)
-- ---------------------------------------------------------------------------
insert into live_moderation_checks values
  (40, 'admit_rpc_no_longer_writes_audit_in_transaction',
      (select prosrc from pg_proc where proname = 'admit_live_viewer')
        not like '%insert into public.live_audit%',
      'the RAISE can no longer erase the record'),
  (41, 'denial_recorder_is_service_role_only',
      has_function_privilege('service_role', 'public.record_live_admission_denied(text, uuid, text)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.record_live_admission_denied(text, uuid, text)', 'EXECUTE')
      and not has_function_privilege('anon', 'public.record_live_admission_denied(text, uuid, text)', 'EXECUTE'),
      'no client can forge a denial record');

do $$
declare
  v_count integer;
begin
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000007","role":"authenticated"}', false);
    perform public.record_live_admission_denied('live-mod-dev',
      'ddddddd3-0000-4000-8000-000000000007', 'capacity_full');
    execute 'reset role';
    insert into live_moderation_checks values
      (42, 'authenticated_cannot_record_denial', false, 'unexpectedly allowed');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values
      (42, 'authenticated_cannot_record_denial', sqlerrm ilike '%permission denied%', sqlerrm);
  end;

  execute 'set role service_role';
  begin
    perform public.record_live_admission_denied('live-mod-dev',
      'ddddddd3-0000-4000-8000-000000000007', 'capacity_full');
    execute 'reset role';
    select count(*) into v_count from public.live_audit where action = 'admission_denied';
    insert into live_moderation_checks values
      (43, 'service_role_records_denial', v_count = 1, 'rows: ' || coalesce(v_count::text, '0'));
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values (43, 'service_role_records_denial', false, sqlerrm);
  end;

  -- The recorder never grants admission.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000007","role":"authenticated"}', false);
    perform public.admit_live_viewer('live-mod-dev');
    execute 'reset role';
    insert into live_moderation_checks values
      (44, 'gate_still_denies_after_recording', false, 'admission unexpectedly allowed');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values
      (44, 'gate_still_denies_after_recording',
          sqlerrm in ('live_viewer_denied', 'live_session_not_live'), sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. A-08/A-10 — moderation stays platform-moderator only and ends sessions
-- ---------------------------------------------------------------------------
do $$
declare
  v_status text;
begin
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.moderate_live('live-mod-dev', 'end', 'dev-check');
    execute 'reset role';
    insert into live_moderation_checks values
      (50, 'producer_cannot_moderate', false, 'unexpectedly allowed');
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values
      (50, 'producer_cannot_moderate', sqlerrm = 'platform_moderator_required', sqlerrm);
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ddddddd3-0000-4000-8000-000000000005","role":"authenticated"}', false);
    perform public.moderate_live('live-mod-dev', 'end', 'dev-check');
    execute 'reset role';
    select status into v_status from public.live_sessions where id = 'live-mod-dev';
    insert into live_moderation_checks values
      (51, 'moderator_end_ends_session', v_status = 'ended', 'status: ' || coalesce(v_status, '?'));
  exception when others then
    execute 'reset role';
    insert into live_moderation_checks values (51, 'moderator_end_ends_session', false, sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from live_moderation_checks
order by ord, check_name;

rollback;
