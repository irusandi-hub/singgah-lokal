-- live-viewer-presence-access.sql — A-04 presence capacity (migration 0053).
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-viewer-presence-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/live-viewer-presence-cap.test.ts.
--
-- Contract verified (docs/audits/LIVE_AUTH_AUDIT_v1.md A-04):
--   1. the presence lease exists on public.live_viewers (`last_seen_at`,
--      not null, default now(), indexed);
--   2. the capacity query counts ACTIVE PRESENCE and not the admission window
--      (`admitted_at`), while the locked cap value (100) and the TUNABLE grace
--      value (5 minutes) are unchanged;
--   3. admission is still serialized (advisory lock before the count);
--   4. the effective private-channel Realtime policies evaluate the same lease;
--   5. `touch_live_viewer_presence` is executable by authenticated/service_role
--      only (never anon/PUBLIC);
--   6. present viewers keep counting even when admitted well over five minutes
--      ago — the exact defect — while the superseded rule counts none of them;
--   7. renewal is own-presence-only and fails closed for a never-admitted user,
--      an anonymous caller, and a session that is no longer live.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check. The whole script runs in ONE transaction and ends with `rollback;`,
-- so it leaves no data behind.

begin;

create temporary table live_viewer_presence_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('bbbbbbb1-0000-4000-8000-000000000001', 'presence-watcher@example.com', now()),
  ('bbbbbbb1-0000-4000-8000-000000000002', 'presence-outsider@example.com', now())
on conflict (id) do nothing;

insert into public.users (id) values
  ('bbbbbbb1-0000-4000-8000-000000000001'),
  ('bbbbbbb1-0000-4000-8000-000000000002')
on conflict (id) do nothing;

insert into public.producers (id, display_name)
values ('prod-presence-dev', 'Pengelola Presence DEV')
on conflict (id) do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status)
values ('stage-presence-dev', 'rumah-teh-lokal', 'Tahap Presence DEV', 'x', 0, 'published')
on conflict (id) do nothing;

insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
values ('live-presence-dev', 'rumah-teh-lokal', 'prod-presence-dev', 'stage-presence-dev', 'live', 'presence-dev-key-1'),
       ('live-presence-dev-ended', 'rumah-teh-lokal', 'prod-presence-dev', 'stage-presence-dev', 'ended', 'presence-dev-key-2')
on conflict (id) do nothing;

-- One viewer present for 30 minutes (fresh lease) and one who was never admitted.
insert into public.live_viewers (live_session_id, user_id, admitted_at, last_seen_at)
values ('live-presence-dev', 'bbbbbbb1-0000-4000-8000-000000000001',
        now() - interval '30 minutes', now() - interval '1 minute')
on conflict (live_session_id, user_id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Schema / lease
-- ---------------------------------------------------------------------------
insert into live_viewer_presence_checks values
  (1, 'presence_column_exists',
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'live_viewers' and column_name = 'last_seen_at'
      ),
      'live_viewers.last_seen_at'),
  (2, 'presence_column_not_null',
      (select is_nullable = 'NO' from information_schema.columns
        where table_schema = 'public' and table_name = 'live_viewers' and column_name = 'last_seen_at'),
      'nullability of the presence lease'),
  (3, 'presence_column_default_now',
      (select column_default like 'now()%' from information_schema.columns
        where table_schema = 'public' and table_name = 'live_viewers' and column_name = 'last_seen_at'),
      'default of the presence lease'),
  (4, 'presence_index_exists',
      exists (
        select 1 from pg_indexes
        where schemaname = 'public' and tablename = 'live_viewers'
          and indexname = 'live_viewers_presence_idx'
      ),
      'index backing the presence count');

-- ---------------------------------------------------------------------------
-- 2. Capacity semantics (presence, not the admission window)
-- ---------------------------------------------------------------------------
do $$
declare
  v_body text;
begin
  select prosrc into v_body from pg_proc where proname = 'admit_live_viewer';

  insert into live_viewer_presence_checks values
    (5, 'cap_value_unchanged_100', v_body like '%v_concurrent >= 100%', 'locked 100-concurrent cap'),
    (6, 'grace_window_unchanged_5_minutes', v_body like '%interval ''5 minutes''%', 'TUNABLE grace window'),
    (7, 'counts_active_presence',
        v_body like '%last_seen_at > now() - interval ''5 minutes''%',
        'capacity counts the presence lease'),
    (8, 'ignores_admission_window',
        position('admitted_at > now()' in v_body) = 0,
        'the superseded admission-window count must be gone'),
    (9, 'admission_serialized',
        position('pg_advisory_xact_lock' in v_body) > 0
        and position('pg_advisory_xact_lock' in v_body) < position('select count(*) into v_concurrent' in v_body),
        'advisory lock precedes the capacity count'),
    (10, 'viewer_peak_still_bounded',
        v_body like '%greatest(viewer_peak, v_concurrent + 1)%',
        'viewer_peak accounting (policy §12.1 item 7)');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Effective Realtime policies use the same lease
-- ---------------------------------------------------------------------------
insert into live_viewer_presence_checks values
  (11, 'realtime_receive_uses_presence',
      exists (
        select 1 from pg_policies
        where schemaname = 'realtime' and tablename = 'messages'
          and policyname = 'live_realtime_receive'
          and coalesce(qual, '') like '%last_seen_at%'
      ),
      'live_realtime_receive predicate'),
  (12, 'realtime_send_uses_presence',
      exists (
        select 1 from pg_policies
        where schemaname = 'realtime' and tablename = 'messages'
          and policyname = 'live_realtime_send'
          and coalesce(with_check, '') like '%last_seen_at%'
      ),
      'live_realtime_send predicate'),
  (13, 'realtime_policies_ignore_admission_window',
      not exists (
        select 1 from pg_policies
        where schemaname = 'realtime' and tablename = 'messages'
          and (coalesce(qual, '') like '%admitted_at%' or coalesce(with_check, '') like '%admitted_at%')
      ),
      'no Realtime policy may still read admitted_at');

-- ---------------------------------------------------------------------------
-- 4. Renewal RPC privilege posture
-- ---------------------------------------------------------------------------
insert into live_viewer_presence_checks values
  (14, 'anon_no_touch_execute',
      not has_function_privilege('anon', 'public.touch_live_viewer_presence(text)', 'EXECUTE'),
      'anon EXECUTE on touch_live_viewer_presence'),
  (15, 'authenticated_touch_execute',
      has_function_privilege('authenticated', 'public.touch_live_viewer_presence(text)', 'EXECUTE'),
      'authenticated EXECUTE on touch_live_viewer_presence'),
  (16, 'service_role_touch_execute',
      has_function_privilege('service_role', 'public.touch_live_viewer_presence(text)', 'EXECUTE'),
      'service_role EXECUTE on touch_live_viewer_presence'),
  (17, 'public_role_no_touch_execute',
      not exists (
        select 1
        from aclexplode(coalesce(
          (select proacl from pg_proc where oid = 'public.touch_live_viewer_presence(text)'::regprocedure),
          acldefault('f', (select proowner from pg_proc where oid = 'public.touch_live_viewer_presence(text)'::regprocedure))
        ))
        where grantee = 0 and privilege_type = 'EXECUTE'
      ),
      'PUBLIC grantee on touch_live_viewer_presence');

-- ---------------------------------------------------------------------------
-- 5. The defect itself, on canonical data
-- ---------------------------------------------------------------------------
insert into live_viewer_presence_checks values
  (18, 'long_watch_still_counts',
      (select count(*) = 1 from public.live_viewers
        where live_session_id = 'live-presence-dev'
          and last_seen_at > now() - interval '5 minutes'),
      'a viewer admitted 30 minutes ago with a fresh lease still counts'),
  (19, 'superseded_rule_counts_none',
      (select count(*) = 0 from public.live_viewers
        where live_session_id = 'live-presence-dev'
          and admitted_at > now() - interval '5 minutes'),
      'the admission-window rule counted that same viewer as absent (A-04)');

-- ---------------------------------------------------------------------------
-- 6. Call-time behaviour of the renewal path
-- ---------------------------------------------------------------------------
do $$
declare
  v_ok boolean;
begin
  -- (a) the admitted viewer renews its own presence.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    select public.touch_live_viewer_presence('live-presence-dev') into v_ok;
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (20, 'admitted_viewer_renews_presence', v_ok, 'own presence renewed');
  exception when others then
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (20, 'admitted_viewer_renews_presence', false, sqlerrm);
  end;

  -- (b) a never-admitted account is refused and gains no ledger row.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    perform public.touch_live_viewer_presence('live-presence-dev');
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (21, 'outsider_cannot_renew_presence', false, 'renewal unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (21, 'outsider_cannot_renew_presence', sqlerrm = 'live_viewer_denied', sqlerrm);
  end;

  -- (c) an anonymous caller is refused.
  execute 'set role anon';
  begin
    perform public.touch_live_viewer_presence('live-presence-dev');
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (22, 'anonymous_cannot_renew_presence', false, 'renewal unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (22, 'anonymous_cannot_renew_presence',
          sqlerrm = 'live_viewer_denied' or sqlerrm like '%permission denied%', sqlerrm);
  end;

  -- (d) a session that is no longer live cannot be renewed.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.touch_live_viewer_presence('live-presence-dev-ended');
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (23, 'ended_session_cannot_renew', false, 'renewal unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (23, 'ended_session_cannot_renew', sqlerrm = 'live_session_not_live', sqlerrm);
  end;

  -- The still-fail-closed admission gate is untouched by 0053: B1 denies all.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    perform public.admit_live_viewer('live-presence-dev');
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (24, 'admission_still_deny_all_b1', false, 'admission unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_viewer_presence_checks values
      (24, 'admission_still_deny_all_b1', sqlerrm = 'live_viewer_denied', sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from live_viewer_presence_checks
order by ord;

rollback;
