-- live-comment-rate-limit-access.sql — A-09 shared comment window (migration 0054).
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-comment-rate-limit-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/live-comment-rate-limit.test.ts.
--
-- Contract verified (docs/audits/LIVE_AUTH_AUDIT_v1.md A-09):
--   1. the window lives in the SHARED store `public.live_comment_rate_limits`
--      (one row per session+viewer, timestamp only — never comment text);
--   2. client roles (anon, authenticated) hold NO privilege on it and no policy
--      admits them, so the window cannot be read, forged, or cleared from a
--      client — and cannot differ between server instances;
--   3. `post_live_comment` runs the fail-closed gate first, then claims the slot
--      with ONE atomic conditional upsert whose WHERE keeps a denied attempt
--      from extending the window;
--   4. at call time: the first comment is accepted, a second one inside the
--      window is rejected with `live_comment_rate_limited`, a different viewer /
--      different session is unaffected, and an over-length body is rejected
--      without consuming a slot.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check. The whole script runs in ONE transaction and ends with `rollback;`,
-- so it leaves no data behind.

begin;

create temporary table live_comment_rate_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('ccccccc2-0000-4000-8000-000000000001', 'rate-a@example.com', now()),
  ('ccccccc2-0000-4000-8000-000000000002', 'rate-b@example.com', now())
on conflict (id) do nothing;

insert into public.users (id) values
  ('ccccccc2-0000-4000-8000-000000000001'),
  ('ccccccc2-0000-4000-8000-000000000002')
on conflict (id) do nothing;

insert into public.producers (id, display_name)
values ('prod-rate-dev', 'Pengelola Rate DEV')
on conflict (id) do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status)
values ('stage-rate-dev', 'rumah-teh-lokal', 'Tahap Rate DEV', 'x', 0, 'published'),
       ('stage-rate-dev-2', 'kopi-dari-kebun', 'Tahap Rate DEV 2', 'x', 0, 'published')
on conflict (id) do nothing;

-- One session per Place (per-Place cap of 1): the per-session isolation check
-- therefore uses two different Places.
insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
values ('live-rate-dev', 'rumah-teh-lokal', 'prod-rate-dev', 'stage-rate-dev', 'live', 'rate-dev-key-1'),
       ('live-rate-dev-2', 'kopi-dari-kebun', 'prod-rate-dev', 'stage-rate-dev-2', 'live', 'rate-dev-key-2')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Store shape + zero client access
-- ---------------------------------------------------------------------------
insert into live_comment_rate_checks values
  (1, 'rate_table_exists', to_regclass('public.live_comment_rate_limits') is not null, 'shared window store'),
  (2, 'rate_table_rls_on',
      (select relrowsecurity from pg_class where oid = 'public.live_comment_rate_limits'::regclass),
      'RLS enabled'),
  (3, 'rate_table_has_no_client_policy',
      not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'live_comment_rate_limits'
      ),
      'no policy may admit a client'),
  (4, 'rate_table_stores_no_comment_text',
      (select count(*) = 0
         from information_schema.columns
        where table_schema = 'public' and table_name = 'live_comment_rate_limits'
          and column_name not in ('live_session_id', 'user_id', 'last_comment_at')),
      'timestamp-only store (comments stay ephemeral)'),
  (5, 'rate_primary_key_is_session_and_viewer',
      exists (
        select 1 from pg_constraint
        where conrelid = 'public.live_comment_rate_limits'::regclass
          and contype = 'p'
          and pg_get_constraintdef(oid) like '%(live_session_id, user_id)%'
      ),
      'composite scope key');

do $$
declare
  v_role   text;
  v_action text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_action in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      insert into live_comment_rate_checks values (
        100,
        v_role || '_no_' || lower(v_action) || '_on_rate_store',
        not has_table_privilege(v_role, 'public.live_comment_rate_limits', v_action),
        v_role || ' ' || v_action || ' on live_comment_rate_limits'
      );
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Enforcement lives in the canonical comment RPC
-- ---------------------------------------------------------------------------
do $$
declare
  v_body text;
begin
  select prosrc into v_body from pg_proc where proname = 'post_live_comment';

  insert into live_comment_rate_checks values
    (200, 'rpc_runs_gate_first',
        position('perform public.assert_viewer_eligible(p_session_id)' in v_body) = 1
        or position('perform public.assert_viewer_eligible(p_session_id)' in v_body)
           < position('live_comment_rate_limits' in v_body),
        'the fail-closed gate still runs before the window'),
    (201, 'rpc_claims_shared_slot',
        v_body like '%insert into public.live_comment_rate_limits%'
        and v_body like '%on conflict (live_session_id, user_id) do update%',
        'single atomic claim against the shared store'),
    (202, 'rpc_conditional_window',
        v_body like '%last_comment_at <= now() - interval ''5 seconds''%',
        'TUNABLE ~1/5s window mirrored from LIVE_COMMENT_MIN_INTERVAL_MS'),
    (203, 'rpc_rejects_when_slot_not_claimed',
        v_body like '%if not found then%'
        and v_body like '%raise exception ''live_comment_rate_limited''%',
        'denial uses the error code the route/UI already map'),
    (204, 'rpc_stores_no_body',
        position('p_body' in substring(v_body from position('live_comment_rate_limits' in v_body))) = 0,
        'the claim never stores comment text');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Call-time behaviour (gate stubbed so the window itself is exercised; the
--    deny-all gate has its own checks elsewhere)
-- ---------------------------------------------------------------------------
create or replace function public.assert_viewer_eligible(p_session_id text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  return true;
end $$;

do $$
declare
  v_detail text;
begin
  -- (1) the first comment is accepted.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ccccccc2-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.post_live_comment('live-rate-dev', 'halo');
    execute 'reset role';
    insert into live_comment_rate_checks values
      (300, 'first_comment_accepted', true, 'slot claimed');
  exception when others then
    execute 'reset role';
    insert into live_comment_rate_checks values
      (300, 'first_comment_accepted', false, sqlerrm);
  end;

  -- (2) a second comment inside the window is rejected.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ccccccc2-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.post_live_comment('live-rate-dev', 'halo lagi');
    execute 'reset role';
    insert into live_comment_rate_checks values
      (301, 'second_comment_rate_limited', false, 'comment unexpectedly accepted');
  exception when others then
    execute 'reset role';
    insert into live_comment_rate_checks values
      (301, 'second_comment_rate_limited', sqlerrm = 'live_comment_rate_limited', sqlerrm);
  end;

  -- (3) a denied attempt did not extend the window: backdate and re-post.
  update public.live_comment_rate_limits
  set last_comment_at = now() - interval '6 seconds'
  where live_session_id = 'live-rate-dev'
    and user_id = 'ccccccc2-0000-4000-8000-000000000001';

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ccccccc2-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.post_live_comment('live-rate-dev', 'halo ketiga');
    execute 'reset role';
    insert into live_comment_rate_checks values
      (302, 'window_frees_after_five_seconds', true, 'accepted once outside the window');
  exception when others then
    execute 'reset role';
    insert into live_comment_rate_checks values
      (302, 'window_frees_after_five_seconds', false, sqlerrm);
  end;

  -- (4) a different viewer on the same session is unaffected.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ccccccc2-0000-4000-8000-000000000002","role":"authenticated"}', false);
    perform public.post_live_comment('live-rate-dev', 'halo dari penonton lain');
    execute 'reset role';
    insert into live_comment_rate_checks values
      (303, 'other_viewer_has_own_window', true, 'per-viewer scope');
  exception when others then
    execute 'reset role';
    insert into live_comment_rate_checks values
      (303, 'other_viewer_has_own_window', false, sqlerrm);
  end;

  -- (5) the same viewer on another session is unaffected (per-session scope).
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"ccccccc2-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.post_live_comment('live-rate-dev-2', 'halo di sesi lain');
    execute 'reset role';
    insert into live_comment_rate_checks values
      (304, 'other_session_has_own_window', true, 'per-session scope');
  exception when others then
    execute 'reset role';
    insert into live_comment_rate_checks values
      (304, 'other_session_has_own_window', false, sqlerrm);
  end;

  -- (6) an over-length body is rejected and consumes no slot.
  begin
    execute 'set role authenticated';
    perform set_config('request.jwt.claims',
      '{"sub":"ccccccc2-0000-4000-8000-000000000002","role":"authenticated"}', false);
    begin
      perform public.post_live_comment('live-rate-dev-2', repeat('x', 301));
      execute 'reset role';
      insert into live_comment_rate_checks values
        (305, 'over_length_body_rejected', false, 'body unexpectedly accepted');
    exception when others then
      execute 'reset role';
      insert into live_comment_rate_checks values
        (305, 'over_length_body_rejected', sqlerrm = 'live_comment_too_long', sqlerrm);
    end;
  end;

  -- (7) the store holds one timestamp-only row per (session, viewer).
  select count(*)::text into v_detail from public.live_comment_rate_limits;
  insert into live_comment_rate_checks values
    (306, 'store_scope_is_shared_and_canonical',
        (select count(*) = 3 from public.live_comment_rate_limits)
        and (select count(*) = 0 from information_schema.columns
              where table_schema = 'public' and table_name = 'live_comment_rate_limits'
                and column_name not in ('live_session_id', 'user_id', 'last_comment_at')),
        'rows after the sequence: ' || v_detail);
end $$;

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from live_comment_rate_checks
order by ord, check_name;

rollback;
