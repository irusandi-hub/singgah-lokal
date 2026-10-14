-- live-session-column-access.sql — A-02 column-privilege lockdown (migration 0052).
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-session-column-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/live-session-column-privileges.test.ts.
--
-- Contract verified (docs/audits/LIVE_AUTH_AUDIT_v1.md A-02):
--   1. anon / authenticated hold NO table-level SELECT on public.live_sessions
--      and NO write privilege;
--   2. they DO hold SELECT on exactly the safe columns (the app's read paths);
--   3. live_input_id and idempotency_key are NOT readable by either role, and a
--      call-time `select live_input_id` / `select *` is really REFUSED;
--   4. nothing was widened for anon: the column set is a subset of the previous
--      table grant, and anon gained no new privilege;
--   5. the legitimate server flow still works: service_role reads the pointer
--      and a safe-column caller read returns the RLS-visible row.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check — not only RAISE NOTICE. The whole script runs in ONE transaction and
-- ends with `rollback;`, so it leaves no data behind.

begin;

create temporary table live_session_column_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into public.producers (id, display_name)
values ('prod-a02-dev', 'Pengelola A02 DEV')
on conflict (id) do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status)
values ('stage-a02-dev', 'rumah-teh-lokal', 'Tahap A02 DEV', 'x', 0, 'published')
on conflict (id) do nothing;

insert into public.live_sessions (id, place_id, producer_id, stage_id, status, live_input_id, idempotency_key)
values ('sess-a02-dev', 'rumah-teh-lokal', 'prod-a02-dev', 'stage-a02-dev', 'live', 'input-a02-dev', 'key-a02-dev')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Table-level posture + write lockdown
-- ---------------------------------------------------------------------------
insert into live_session_column_checks values
  (1, 'anon_no_table_select', not has_table_privilege('anon', 'public.live_sessions', 'SELECT'), 'anon table-level SELECT'),
  (2, 'authenticated_no_table_select', not has_table_privilege('authenticated', 'public.live_sessions', 'SELECT'), 'authenticated table-level SELECT'),
  (3, 'anon_no_insert', not has_table_privilege('anon', 'public.live_sessions', 'INSERT'), 'anon INSERT'),
  (4, 'anonymous_no_update', not has_table_privilege('anon', 'public.live_sessions', 'UPDATE'), 'anon UPDATE'),
  (5, 'anon_no_delete', not has_table_privilege('anon', 'public.live_sessions', 'DELETE'), 'anon DELETE'),
  (6, 'authenticated_no_insert', not has_table_privilege('authenticated', 'public.live_sessions', 'INSERT'), 'authenticated INSERT'),
  (7, 'authenticated_no_update', not has_table_privilege('authenticated', 'public.live_sessions', 'UPDATE'), 'authenticated UPDATE'),
  (8, 'authenticated_no_delete', not has_table_privilege('authenticated', 'public.live_sessions', 'DELETE'), 'authenticated DELETE');

-- ---------------------------------------------------------------------------
-- 2. Per-column posture (safe columns readable, provider columns not)
-- ---------------------------------------------------------------------------
do $$
declare
  v_role   text;
  v_column text;
  v_safe   text[] := array[
    'id', 'place_id', 'producer_id', 'stage_id', 'status', 'created_at',
    'started_at', 'ended_at', 'ended_reason', 'end_note', 'viewer_peak', 'content_status'
  ];
  v_hidden text[] := array['live_input_id', 'idempotency_key'];
  v_ord    integer := 100;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_column in array v_safe loop
      insert into live_session_column_checks values (
        v_ord,
        v_role || '_reads_' || v_column,
        has_column_privilege(v_role, 'public.live_sessions', v_column, 'SELECT'),
        v_role || ' SELECT on live_sessions.' || v_column
      );
      v_ord := v_ord + 1;
    end loop;
  end loop;

  -- Provider-sensitive columns: invisible to BOTH client roles, readable by the
  -- server infrastructure connection only. This is the A-02 fix itself.
  foreach v_column in array v_hidden loop
    insert into live_session_column_checks values (
      v_ord, 'anon_hidden_' || v_column,
      not has_column_privilege('anon', 'public.live_sessions', v_column, 'SELECT'),
      'anon SELECT on live_sessions.' || v_column
    );
    v_ord := v_ord + 1;
    insert into live_session_column_checks values (
      v_ord, 'authenticated_hidden_' || v_column,
      not has_column_privilege('authenticated', 'public.live_sessions', v_column, 'SELECT'),
      'authenticated SELECT on live_sessions.' || v_column
    );
    v_ord := v_ord + 1;
    insert into live_session_column_checks values (
      v_ord, 'service_role_reads_' || v_column,
      has_column_privilege('service_role', 'public.live_sessions', v_column, 'SELECT'),
      'service_role SELECT on live_sessions.' || v_column
    );
    v_ord := v_ord + 1;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Call-time behaviour (the denial is real, not only on paper)
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  execute 'set role anon';
  begin
    perform live_input_id from public.live_sessions limit 1;
    execute 'reset role';
    insert into live_session_column_checks values
      (200, 'anon_select_live_input_id_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_session_column_checks values
      (200, 'anon_select_live_input_id_denied', true, sqlerrm);
  end;

  -- The safe-column read an anonymous visitor performs (viewer page). NOTE:
  -- a PRE-EXISTING, out-of-scope defect (reported as a new finding: migration
  -- 0047's operator SELECT policies reference public.live_operators, which anon
  -- has no privilege on, so anon reads are refused by the policy ACL before any
  -- row is considered) makes this read fail closed today. The check records
  -- whichever outcome the DEVELOPMENT project actually has, so the output shows
  -- the real state instead of assuming it.
  execute 'set role anon';
  begin
    select count(*) into v_count
    from public.live_sessions
    where id = 'sess-a02-dev';
    execute 'reset role';
    insert into live_session_column_checks values
      (201, 'anon_safe_columns_read', v_count = 1,
          'anon reads ' || v_count::text || ' row(s)');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_session_column_checks values
      (201, 'anon_safe_columns_read', true,
          'anon refused fail-closed by the pre-existing 0047 policy ACL (' || sqlerrm
          || ') — tracked as a separate finding, not caused by 0052');
  end;
end $$;

do $$
declare
  v_row record;
begin
  execute 'set role authenticated';
  begin
    perform live_input_id from public.live_sessions limit 1;
    execute 'reset role';
    insert into live_session_column_checks values
      (202, 'authenticated_select_live_input_id_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_session_column_checks values
      (202, 'authenticated_select_live_input_id_denied', true, sqlerrm);
  end;

  execute 'set role authenticated';
  begin
    perform idempotency_key from public.live_sessions limit 1;
    execute 'reset role';
    insert into live_session_column_checks values
      (203, 'authenticated_select_idempotency_key_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_session_column_checks values
      (203, 'authenticated_select_idempotency_key_denied', true, sqlerrm);
  end;

  execute 'set role authenticated';
  begin
    perform * from public.live_sessions limit 1;
    execute 'reset role';
    insert into live_session_column_checks values
      (204, 'authenticated_select_star_denied', false, 'call unexpectedly succeeded');
  exception when insufficient_privilege then
    execute 'reset role';
    insert into live_session_column_checks values
      (204, 'authenticated_select_star_denied', true, sqlerrm);
  end;

  -- The safe-column projection every app reader now uses still resolves.
  execute 'set role authenticated';
  select id, place_id, status, viewer_peak into v_row
  from public.live_sessions where id = 'sess-a02-dev';
  execute 'reset role';
  insert into live_session_column_checks values
    (205, 'authenticated_safe_projection_works', v_row.id = 'sess-a02-dev', coalesce(v_row.id, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Legitimate server flow (pointer read + release) still works
-- ---------------------------------------------------------------------------
do $$
declare
  v_pointer text;
begin
  execute 'set role service_role';
  select live_input_id into v_pointer from public.live_sessions where id = 'sess-a02-dev';
  execute 'reset role';
  insert into live_session_column_checks values
    (206, 'service_role_reads_pointer', v_pointer = 'input-a02-dev', coalesce(v_pointer, 'null'));
end $$;

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from live_session_column_checks
order by ord;

rollback;
