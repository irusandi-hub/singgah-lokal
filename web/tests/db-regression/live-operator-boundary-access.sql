-- live-operator-boundary-access.sql — least-privilege boundary between the
-- Pengelola Tempat and a delegated Operator Live account.
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-operator-boundary-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/live-operator-boundary.test.ts.
--
-- Contract verified (docs/audits/LIVE_OPERATOR_BOUNDARY_AUDIT.md):
--   1. accepting an invitation grants EXACTLY the delegated assignment and
--      never creates/upgrades a producer_memberships row (H1);
--   2. a delegated operator operates Live for the ASSIGNED Place only;
--   3. the operator cannot invite / list / cancel / revoke / grant / revoke
--      operators, nor look accounts up (H3);
--   4. a fake Place id and a fake invitation id are refused;
--   5. revocation denies the very next start (no authorization cache);
--   6. RLS confines reads to self or the managing Place (H4/H5);
--   7. `anon` holds no table SELECT and no RPC EXECUTE; the authority predicate
--      is not client-callable (H5);
--   8. no migration is required — this script is a verification step, not a
--      schema change.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check. One transaction; ends with `rollback;`.

begin;

create temporary table live_operator_boundary_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (rolled back at the end). Places 'rumah-teh-lokal' and
-- 'kopi-dari-kebun' are seeded by 0001.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('bbbbbbb1-0000-4000-8000-000000000001', 'bnd-manager@example.com', now()),
  ('bbbbbbb1-0000-4000-8000-000000000002', 'bnd-manager-b@example.com', now()),
  ('bbbbbbb1-0000-4000-8000-000000000003', 'bnd-operator@example.com', now()),
  ('bbbbbbb1-0000-4000-8000-000000000004', 'bnd-operator-b@example.com', now()),
  ('bbbbbbb1-0000-4000-8000-000000000005', 'bnd-outsider@example.com', now())
on conflict (id) do nothing;

insert into public.users (id) values
  ('bbbbbbb1-0000-4000-8000-000000000001'),
  ('bbbbbbb1-0000-4000-8000-000000000002'),
  ('bbbbbbb1-0000-4000-8000-000000000003'),
  ('bbbbbbb1-0000-4000-8000-000000000004'),
  ('bbbbbbb1-0000-4000-8000-000000000005')
on conflict (id) do nothing;

insert into public.producers (id, display_name) values
  ('prod-boundary-a', 'Pengelola Boundary A'),
  ('prod-boundary-b', 'Pengelola Boundary B')
on conflict (id) do nothing;

insert into public.producer_memberships (user_id, producer_id, place_id, role) values
  ('bbbbbbb1-0000-4000-8000-000000000001', 'prod-boundary-a', 'rumah-teh-lokal', 'owner'),
  ('bbbbbbb1-0000-4000-8000-000000000002', 'prod-boundary-b', 'kopi-dari-kebun', 'owner')
on conflict do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status) values
  ('stage-boundary-a', 'rumah-teh-lokal', 'Proses Boundary A', 'x', 0, 'published'),
  ('stage-boundary-b', 'kopi-dari-kebun', 'Proses Boundary B', 'x', 0, 'published')
on conflict (id) do nothing;

insert into public.live_eligibility (producer_id, path, active, granted_by) values
  ('prod-boundary-a', 'ADMIN_APPROVED', true, 'regression'),
  ('prod-boundary-b', 'ADMIN_APPROVED', true, 'regression')
on conflict (producer_id, path) do update set active = true;

-- ---------------------------------------------------------------------------
-- 1. Accept: assignment granted, NO membership change.
-- ---------------------------------------------------------------------------
do $$
declare
  v_before integer;
  v_after  integer;
  v_role   text;
begin
  select count(*) into v_before from public.producer_memberships;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.invite_live_operator('rumah-teh-lokal', 'bnd-operator@example.com');
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.accept_live_operator_invitation(
      (select id from public.live_operator_invitations
        where place_id = 'rumah-teh-lokal'
          and invited_user_id = 'bbbbbbb1-0000-4000-8000-000000000003'
          and status = 'pending'));
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  select count(*) into v_after from public.producer_memberships;
  select role into v_role
    from public.producer_memberships
   where user_id = 'bbbbbbb1-0000-4000-8000-000000000003';

  insert into live_operator_boundary_checks values
    (1, 'accept_creates_no_producer_membership', v_before = v_after,
       'memberships before=' || v_before || ' after=' || v_after),
    (2, 'accept_grants_operator_assignment',
       exists (select 1 from public.live_operators
                where user_id = 'bbbbbbb1-0000-4000-8000-000000000003'
                  and place_id = 'rumah-teh-lokal' and revoked_at is null),
       'active delegated assignment'),
    (3, 'accepted_account_has_no_membership_role', v_role is null,
       'operator membership role = ' || coalesce(v_role, 'none'));
end $$;

-- ---------------------------------------------------------------------------
-- 2. Operator can start the ASSIGNED Place; a non-assigned Place and a fake
--    Place id are refused.
-- ---------------------------------------------------------------------------
do $$
declare
  v_session jsonb;
begin
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    select public.start_live_session('rumah-teh-lokal', 'stage-boundary-a', 'bnd-key-1', 'input-b1')
      into v_session;
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (4, 'operator_can_start_assigned_place', v_session is not null, coalesce(v_session::text, 'null'));
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (4, 'operator_can_start_assigned_place', false, sqlerrm);
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.end_live_session(
      (select id from public.live_sessions where idempotency_key = 'bnd-key-1'),
      'bnd-end-1', 'producer_ended', null);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.start_live_session('kopi-dari-kebun', 'stage-boundary-b', 'bnd-key-2', 'input-b2');
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (5, 'operator_cannot_start_unassigned_place', false, 'start unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (5, 'operator_cannot_start_unassigned_place', sqlerrm = 'producer_authorization_required', sqlerrm);
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.start_live_session('place-yang-tidak-ada', 'stage-boundary-b', 'bnd-key-3', 'input-b3');
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (6, 'fake_place_refused', false, 'start unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (6, 'fake_place_refused', sqlerrm = 'producer_authorization_required', sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The operator cannot reach ANY management RPC.
-- ---------------------------------------------------------------------------
do $$
declare
  v_after boolean;
begin
  -- invite
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.invite_live_operator('rumah-teh-lokal', 'bnd-outsider@example.com');
    execute 'reset role';
    insert into live_operator_boundary_checks values (7, 'operator_cannot_invite', false, 'invite unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (7, 'operator_cannot_invite', sqlerrm = 'producer_authorization_required', sqlerrm);
  end;

  -- list Place invitations
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform (select count(*) from public.list_place_live_operator_invitations('rumah-teh-lokal'));
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (8, 'operator_cannot_list_place_invitations', false, 'list unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (8, 'operator_cannot_list_place_invitations', sqlerrm = 'producer_authorization_required', sqlerrm);
  end;

  -- list Place operators
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform (select count(*) from public.list_place_live_operators('rumah-teh-lokal'));
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (9, 'operator_cannot_list_place_operators', false, 'list unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (9, 'operator_cannot_list_place_operators', sqlerrm = 'live_operator_list_not_allowed', sqlerrm);
  end;

  -- revoke own access (must go through the manager)
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.revoke_live_operator_access('bbbbbbb1-0000-4000-8000-000000000003', 'rumah-teh-lokal');
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (10, 'operator_cannot_revoke_operator_access', false, 'revoke unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (10, 'operator_cannot_revoke_operator_access', sqlerrm = 'live_operator_revoke_not_allowed', sqlerrm);
  end;

  -- grant someone else
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.grant_live_operator_access('bbbbbbb1-0000-4000-8000-000000000005', 'rumah-teh-lokal');
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (11, 'operator_cannot_grant_operator_access', false, 'grant unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (11, 'operator_cannot_grant_operator_access', sqlerrm = 'live_operator_grant_not_allowed', sqlerrm);
  end;

  -- account lookup
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform (select count(*) from public.resolve_account_by_username('bnd-outsider'));
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (12, 'operator_cannot_lookup_accounts', false, 'lookup unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (12, 'operator_cannot_lookup_accounts', sqlerrm = 'account_lookup_not_allowed', sqlerrm);
  end;

  -- the operator's own access is untouched by the refusals above
  select revoked_at is null into v_after
    from public.live_operators
   where user_id = 'bbbbbbb1-0000-4000-8000-000000000003' and place_id = 'rumah-teh-lokal';
  insert into live_operator_boundary_checks values
    (13, 'operator_access_untouched_by_refusals', coalesce(v_after, false), 'revoked_at is null');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Revoke (by the manager) denies the very next start.
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.revoke_live_operator_invitation(
      (select id from public.live_operator_invitations
        where place_id = 'rumah-teh-lokal' and status = 'accepted'));
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    perform public.start_live_session('rumah-teh-lokal', 'stage-boundary-a', 'bnd-key-9', 'input-b9');
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (14, 'revoke_denies_next_start', false, 'start unexpectedly succeeded after revoke');
  exception when others then
    execute 'reset role';
    insert into live_operator_boundary_checks values
      (14, 'revoke_denies_next_start', sqlerrm = 'producer_authorization_required', sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. RLS: self or the managing Place only.
-- ---------------------------------------------------------------------------
do $$
declare
  v_operator_rows integer;
  v_manager_rows  integer;
  v_outsider_rows integer;
  v_other_manager integer;
begin
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000003","role":"authenticated"}', false);
    select count(*) into v_operator_rows from public.live_operators;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    select count(*) into v_manager_rows
      from public.live_operators where place_id = 'rumah-teh-lokal';
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000005","role":"authenticated"}', false);
    select count(*) into v_outsider_rows from public.live_operators;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"bbbbbbb1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    select count(*) into v_other_manager
      from public.live_operators where place_id = 'rumah-teh-lokal';
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  insert into live_operator_boundary_checks values
    (15, 'rls_operator_sees_own_assignment_only', v_operator_rows >= 1, 'rows=' || v_operator_rows),
    (16, 'rls_manager_sees_own_place', v_manager_rows >= 1, 'rows=' || v_manager_rows),
    (17, 'rls_outsider_sees_nothing', v_outsider_rows = 0, 'rows=' || v_outsider_rows),
    (18, 'rls_other_place_manager_sees_nothing', v_other_manager = 0, 'rows=' || v_other_manager);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Grants / EXECUTE posture (anon excluded; predicate internal).
-- ---------------------------------------------------------------------------
insert into live_operator_boundary_checks values
  (19, 'anon_has_no_table_select_on_live_operators',
      not has_table_privilege('anon', 'public.live_operators', 'SELECT'),
      'anon SELECT on live_operators'),
  (20, 'anon_has_no_table_select_on_invitations',
      not has_table_privilege('anon', 'public.live_operator_invitations', 'SELECT'),
      'anon SELECT on live_operator_invitations'),
  (21, 'anon_has_no_execute_on_accept',
      not has_function_privilege('anon', 'public.accept_live_operator_invitation(uuid)', 'EXECUTE'),
      'anon EXECUTE on accept'),
  (22, 'anon_has_no_execute_on_start',
      not has_function_privilege('anon', 'public.start_live_session(text,text,text,text)', 'EXECUTE'),
      'anon EXECUTE on start_live_session'),
  (23, 'predicate_not_client_callable_authenticated',
      not has_function_privilege('authenticated', 'public.can_operate_live_for_place(uuid,text)', 'EXECUTE'),
      'authenticated EXECUTE on can_operate_live_for_place'),
  (24, 'predicate_not_client_callable_anon',
      not has_function_privilege('anon', 'public.can_operate_live_for_place(uuid,text)', 'EXECUTE'),
      'anon EXECUTE on can_operate_live_for_place'),
  (25, 'no_client_write_policy_on_live_operators',
      (select count(*) from pg_policies
        where schemaname='public' and tablename='live_operators'
          and cmd in ('INSERT','UPDATE','DELETE','ALL')) = 0,
      'write policies on live_operators'),
  (26, 'no_client_write_policy_on_invitations',
      (select count(*) from pg_policies
        where schemaname='public' and tablename='live_operator_invitations'
          and cmd in ('INSERT','UPDATE','DELETE','ALL')) = 0,
      'write policies on live_operator_invitations');

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from live_operator_boundary_checks
order by ord;

rollback;
