-- live-cleanup-rpc-access.sql — A-03 cleanup-RPC lockdown (migration 0051).
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-cleanup-rpc-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/live-cleanup-rpc-privileges.test.ts.
--
-- Contract verified (docs/audits/LIVE_AUTH_AUDIT_v1.md A-03):
--   1. anon and authenticated hold NO EXECUTE on release_live_input /
--      list_ended_live_inputs (neither by grant nor via PUBLIC);
--   2. an authenticated session is really REFUSED at call time (permission
--      denied), not just missing a grant on paper;
--   3. the legitimate server flow still works through the SERVICE ROLE: the
--      backlog lists the ended session's input and the pointer is released;
--   4. the user-facing start/end RPCs are untouched (authenticated EXECUTE).
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check — not only RAISE NOTICE. The whole script runs in ONE transaction and
-- ends with `rollback;`, so it leaves no data behind.

begin;

create temporary table live_cleanup_rpc_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into public.producers (id, display_name)
values ('prod-cleanup-a', 'Pengelola Cleanup A')
on conflict (id) do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status)
values ('stage-cleanup-x', 'rumah-teh-lokal', 'Tahap Cleanup', 'x', 0, 'published')
on conflict (id) do nothing;

insert into public.live_sessions (id, place_id, producer_id, stage_id, status, live_input_id, idempotency_key)
values ('sess-cleanup-1', 'rumah-teh-lokal', 'prod-cleanup-a', 'stage-cleanup-x', 'ended', 'input-cleanup-1', 'cleanup-key-1'),
       ('sess-cleanup-2', 'rumah-teh-lokal', 'prod-cleanup-a', 'stage-cleanup-x', 'ended', 'input-cleanup-2', 'cleanup-key-2')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Privilege posture (on paper)
-- ---------------------------------------------------------------------------
insert into live_cleanup_rpc_checks values
  (1, 'anon_no_execute_release', not has_function_privilege('anon', 'public.release_live_input(text)', 'EXECUTE'), 'anon EXECUTE on release_live_input'),
  (2, 'anon_no_execute_list', not has_function_privilege('anon', 'public.list_ended_live_inputs()', 'EXECUTE'), 'anon EXECUTE on list_ended_live_inputs'),
  (3, 'authenticated_no_execute_release', not has_function_privilege('authenticated', 'public.release_live_input(text)', 'EXECUTE'), 'authenticated EXECUTE on release_live_input'),
  (4, 'authenticated_no_execute_list', not has_function_privilege('authenticated', 'public.list_ended_live_inputs()', 'EXECUTE'), 'authenticated EXECUTE on list_ended_live_inputs'),
  (5, 'service_role_execute_release', has_function_privilege('service_role', 'public.release_live_input(text)', 'EXECUTE'), 'service_role EXECUTE on release_live_input'),
  (6, 'service_role_execute_list', has_function_privilege('service_role', 'public.list_ended_live_inputs()', 'EXECUTE'), 'service_role EXECUTE on list_ended_live_inputs'),
  (7, 'public_role_holds_no_execute_release',
      not exists (
        select 1
        from aclexplode(coalesce(
          (select proacl from pg_proc where oid = 'public.release_live_input(text)'::regprocedure),
          acldefault('f', (select proowner from pg_proc where oid = 'public.release_live_input(text)'::regprocedure))
        ))
        where grantee = 0 and privilege_type = 'EXECUTE'
      ),
      'PUBLIC grantee on release_live_input'),
  (8, 'public_role_holds_no_execute_list',
      not exists (
        select 1
        from aclexplode(coalesce(
          (select proacl from pg_proc where oid = 'public.list_ended_live_inputs()'::regprocedure),
          acldefault('f', (select proowner from pg_proc where oid = 'public.list_ended_live_inputs()'::regprocedure))
        ))
        where grantee = 0 and privilege_type = 'EXECUTE'
      ),
      'PUBLIC grantee on list_ended_live_inputs');

-- The user-facing start/end RPCs keep their authenticated posture (A-03 must
-- not leak into the client-facing surface).
insert into live_cleanup_rpc_checks values
  (9, 'authenticated_keeps_execute_start', has_function_privilege('authenticated', 'public.start_live_session(text,text,text,text)', 'EXECUTE'), 'start_live_session posture unchanged'),
  (10, 'authenticated_keeps_execute_end', has_function_privilege('authenticated', 'public.end_live_session(text,text,text,text)', 'EXECUTE'), 'end_live_session posture unchanged');

-- ---------------------------------------------------------------------------
-- 2. Call-time behaviour per role
-- ---------------------------------------------------------------------------
-- anon: refused at call time.
do $$
begin
  execute 'set role anon';
  begin
    perform public.list_ended_live_inputs();
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (11, 'anon_call_list_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (11, 'anon_call_list_denied', true, sqlerrm);
  end;
  execute 'set role anon';
  begin
    perform public.release_live_input('sess-cleanup-1');
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (12, 'anon_call_release_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (12, 'anon_call_release_denied', true, sqlerrm);
  end;
end $$;

-- authenticated: refused at call time (the A-03 exploit path).
do $$
begin
  execute 'set role authenticated';
  begin
    perform public.list_ended_live_inputs();
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (13, 'authenticated_call_list_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (13, 'authenticated_call_list_denied', true, sqlerrm);
  end;
  execute 'set role authenticated';
  begin
    perform public.release_live_input('sess-cleanup-1');
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (14, 'authenticated_call_release_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_cleanup_rpc_checks values
      (14, 'authenticated_call_release_denied', true, sqlerrm);
  end;
end $$;

-- service_role: the legitimate server flow still works end to end.
do $$
declare
  v_list jsonb;
  v_released text;
begin
  execute 'set role service_role';
  select public.list_ended_live_inputs() into v_list;
  execute 'reset role';
  if v_list is not null
     and v_list @> '[{"sessionId": "sess-cleanup-1", "liveInputId": "input-cleanup-1"}]'::jsonb then
    insert into live_cleanup_rpc_checks values
      (15, 'service_role_lists_backlog', true, v_list::text);
  else
    insert into live_cleanup_rpc_checks values
      (15, 'service_role_lists_backlog', false, coalesce(v_list::text, 'null'));
    return;
  end if;

  execute 'set role service_role';
  select public.release_live_input('sess-cleanup-1') into v_released;
  execute 'reset role';
  if v_released = 'input-cleanup-1' then
    insert into live_cleanup_rpc_checks values
      (16, 'service_role_releases_pointer', true, 'released ' || v_released);
  else
    insert into live_cleanup_rpc_checks values
      (16, 'service_role_releases_pointer', false, coalesce(v_released, 'null'));
  end if;
end $$;

-- The release actually nulled the pointer (canonical state), and the backlog
-- no longer lists it — but the second ended session is still there for retry.
insert into live_cleanup_rpc_checks values
  (17, 'pointer_nulled_after_release',
      (select live_input_id is null from public.live_sessions where id = 'sess-cleanup-1'),
      'live_input_id of sess-cleanup-1 after service-role release'),
  (18, 'backlog_still_lists_unreleased',
      (select count(*) = 1 from public.live_sessions
        where status = 'ended' and live_input_id = 'input-cleanup-2'),
      'sess-cleanup-2 keeps its pointer for the next sweep');

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from live_cleanup_rpc_checks
order by ord;

rollback;
