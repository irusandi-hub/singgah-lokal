-- live-operator-email-verification-access.sql — A-06 verified-email gate for
-- the delegated Operator Live authority (migration 0051, section 2).
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-operator-email-verification-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/live-operator-email-verification.test.ts.
--
-- Contract verified (docs/audits/LIVE_AUTH_AUDIT_v1.md A-06 + POLICY DECISION):
--   1. an invitee whose auth.users.email_confirmed_at is NULL cannot ACCEPT a
--      pending invitation (email_verification_required, raised BEFORE any
--      state change — the invitation stays pending);
--   2. an ACTIVE delegated operator whose email is unconfirmed cannot START
--      Live (the authority predicate refuses);
--   3. once the email is confirmed, the same invitee accepts and starts;
--   4. revocation denies the very next start (no authorization cache);
--   5. POLICY DECISION: an owner/manager WITHOUT a confirmed email keeps
--      starting Live — the gate is operator-delegate scope only.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check — not only RAISE NOTICE. One transaction; ends with `rollback;`.

begin;

create temporary table live_email_verification_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('aaaaaaa1-0000-4000-8000-000000000001', 'mgr-unverified@example.com', null),
  ('aaaaaaa1-0000-4000-8000-000000000002', 'operator-unverified@example.com', null)
on conflict (id) do nothing;

insert into public.users (id) values
  ('aaaaaaa1-0000-4000-8000-000000000001'),
  ('aaaaaaa1-0000-4000-8000-000000000002')
on conflict (id) do nothing;

insert into public.producers (id, display_name)
values ('prod-email-a', 'Pengelola Email A')
on conflict (id) do nothing;

insert into public.producer_memberships (user_id, producer_id, place_id, role)
values ('aaaaaaa1-0000-4000-8000-000000000001', 'prod-email-a', 'rumah-teh-lokal', 'owner')
on conflict do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status)
values ('stage-email-a', 'rumah-teh-lokal', 'Tahap Email', 'x', 0, 'published')
on conflict (id) do nothing;

insert into public.live_eligibility (producer_id, path, active, granted_by)
values ('prod-email-a', 'ADMIN_APPROVED', true, 'regression')
on conflict (producer_id, path) do update set active = true;

-- The actor is expressed through the Supabase-standard request.jwt.claims
-- GUC, which auth.uid() reads on the real project. It is set with
-- is_local = false (SESSION level) on purpose: SQL-Editor / psql runners reuse
-- one session across statements, and a transaction-local setting would already
-- be gone by the time the RPC reads auth.uid() — or silently rolled back by an
-- exception handler below. (The PGlite harness in
-- tests/live-operator-email-verification.test.ts replaces auth.uid() with a
-- constant instead, because there each statement is its own transaction.)

-- 1 (ord 1): manager without a verified email → start succeeds.
do $$
declare
  v_session jsonb;
begin
  execute 'set role authenticated';
  begin
    -- The RPC derives the actor from auth.uid(); this session-level GUC is the
    -- same value the Supabase runtime provides for a signed-in request.
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    select public.start_live_session('rumah-teh-lokal', 'stage-email-a', 'email-mgr-key-1', 'input-email-1')
      into v_session;
    execute 'reset role';
    insert into live_email_verification_checks values
      (1, 'owner_manager_without_verified_email_can_start', true,
         coalesce(v_session::text, 'null'));
  exception when others then
    execute 'reset role';
    insert into live_email_verification_checks values
      (1, 'owner_manager_without_verified_email_can_start', false, sqlerrm);
  end;
end $$;

-- End that session so the per-Place cap frees the Place for the operator flow.
do $$
begin
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.end_live_session(
      (select id from public.live_sessions where idempotency_key = 'email-mgr-key-1'),
      'email-mgr-end-1', 'producer_ended', null);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- POLICY DECISION (ord 1): an owner/manager WITHOUT a confirmed email keeps
-- starting Live — the A-06 gate is operator-delegate scope only.
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- The invitee flow: accept gate, authority gate, confirmation, revocation.
-- ---------------------------------------------------------------------------
-- Manager (unverified, owner) invites the operator — invitations have no
-- email gate; the gate is on ACCEPT and on OPERATOR authority.
-- ---------------------------------------------------------------------------
insert into public.live_operator_invitations
  (place_id, invited_user_id, invited_by_user_id, invited_by_producer_id, invited_email, status, expires_at)
select 'rumah-teh-lokal', 'aaaaaaa1-0000-4000-8000-000000000002',
       'aaaaaaa1-0000-4000-8000-000000000001', 'prod-email-a',
       'operator-unverified@example.com', 'pending', now() + interval '7 days'
where not exists (
  select 1 from public.live_operator_invitations
  where place_id = 'rumah-teh-lokal'
    and invited_user_id = 'aaaaaaa1-0000-4000-8000-000000000002'
    and status = 'pending'
);

-- ---------------------------------------------------------------------------
-- Expected refusals are matched by their exact MESSAGE, not by SQLSTATE: the
-- authority refusals travel as 42501 (insufficient_privilege) while the accept
-- gate is P0001, so a `when raise_exception` handler would leak the authority
-- ones out of the script.
-- 1 (ord 2): unverified invitee CANNOT accept; the invitation stays pending.
-- 2 (ord 3): an ACTIVE assignment with an unconfirmed email CANNOT start.
-- 3 (ord 5-6): after confirmation the same invitee accepts and starts.
-- 4 (ord 7): revocation denies the very next start.
-- ---------------------------------------------------------------------------
do $$
declare
  v_invitation uuid;
  v_session jsonb;
begin
  select id into v_invitation
  from public.live_operator_invitations
  where place_id = 'rumah-teh-lokal'
    and invited_user_id = 'aaaaaaa1-0000-4000-8000-000000000002'
    and status = 'pending'
  limit 1;

  -- (2) accept refused before any state change.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    perform public.accept_live_operator_invitation(v_invitation);
    execute 'reset role';
    insert into live_email_verification_checks values
      (2, 'unverified_invitee_cannot_accept', false, 'accept unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    if sqlerrm = 'email_verification_required' then
      insert into live_email_verification_checks values
        (2, 'unverified_invitee_cannot_accept', true, sqlerrm);
    else
      insert into live_email_verification_checks values
        (2, 'unverified_invitee_cannot_accept', false, sqlerrm);
    end if;
  end;

  insert into live_email_verification_checks values
    (3, 'invitation_stays_pending_after_denied_accept',
      (select status = 'pending'
         from public.live_operator_invitations where id = v_invitation),
      'invitation status after the refused accept');

  -- Seed an ACTIVE assignment for the still-unverified operator (the exact
  -- audit scenario: an operator holding authority without a confirmed email).
  insert into public.live_operators (user_id, place_id, granted_by, granted_at, revoked_at)
  values ('aaaaaaa1-0000-4000-8000-000000000002', 'rumah-teh-lokal', 'prod-email-a', now(), null)
  on conflict (user_id, place_id) do update set revoked_at = null;

  -- (2 continued) start refused through the authority predicate.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    select public.start_live_session('rumah-teh-lokal', 'stage-email-a', 'email-op-key-1', 'input-email-2')
      into v_session;
    execute 'reset role';
    insert into live_email_verification_checks values
      (4, 'unverified_active_operator_cannot_start', false, 'start unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    if sqlerrm = 'producer_authorization_required' then
      insert into live_email_verification_checks values
        (4, 'unverified_active_operator_cannot_start', true, sqlerrm);
    else
      insert into live_email_verification_checks values
        (4, 'unverified_active_operator_cannot_start', false, sqlerrm);
    end if;
  end;

  -- Confirm the operator's email (the authoritative source).
  update auth.users
  set email_confirmed_at = now()
  where id = 'aaaaaaa1-0000-4000-8000-000000000002';

  -- (3) accept now succeeds.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    perform public.accept_live_operator_invitation(v_invitation);
    execute 'reset role';
    insert into live_email_verification_checks values
      (5, 'verified_invitee_can_accept', true, 'accepted');
  exception when others then
    execute 'reset role';
    insert into live_email_verification_checks values
      (5, 'verified_invitee_can_accept', false, sqlerrm);
  end;

  insert into live_email_verification_checks values
    (6, 'assignment_active_after_accept',
      (select revoked_at is null
         from public.live_operators
        where user_id = 'aaaaaaa1-0000-4000-8000-000000000002'
          and place_id = 'rumah-teh-lokal'),
      'live_operators.revoked_at after the verified accept');

  -- (3 continued) start now succeeds.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    select public.start_live_session('rumah-teh-lokal', 'stage-email-a', 'email-op-key-2', 'input-email-3')
      into v_session;
    execute 'reset role';
    insert into live_email_verification_checks values
      (7, 'verified_operator_can_start', true, coalesce(v_session::text, 'null'));
  exception when others then
    execute 'reset role';
    insert into live_email_verification_checks values
      (7, 'verified_operator_can_start', false, sqlerrm);
  end;

  -- End the operator's session (same authority) so the Place is free again.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    perform public.end_live_session(
      (select id from public.live_sessions where idempotency_key = 'email-op-key-2'),
      'email-op-end-1', 'producer_ended', null);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  -- (4) revoke as the manager, then the operator's NEXT start is refused.
  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000001","role":"authenticated"}', false);
    perform public.revoke_live_operator_invitation(v_invitation);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    raise;
  end;

  execute 'set role authenticated';
  begin
    perform set_config('request.jwt.claims',
      '{"sub":"aaaaaaa1-0000-4000-8000-000000000002","role":"authenticated"}', false);
    select public.start_live_session('rumah-teh-lokal', 'stage-email-a', 'email-op-key-3', 'input-email-4')
      into v_session;
    execute 'reset role';
    insert into live_email_verification_checks values
      (8, 'revoke_denies_next_start', false, 'start unexpectedly succeeded after revoke');
  exception when others then
    execute 'reset role';
    if sqlerrm = 'producer_authorization_required' then
      insert into live_email_verification_checks values
        (8, 'revoke_denies_next_start', true, sqlerrm);
    else
      insert into live_email_verification_checks values
        (8, 'revoke_denies_next_start', false, sqlerrm);
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- The authority predicate stays internal (no client EXECUTE).
-- ---------------------------------------------------------------------------
insert into live_email_verification_checks values
  (9, 'predicate_not_client_callable_authenticated',
      not has_function_privilege('authenticated', 'public.can_operate_live_for_place(uuid,text)', 'EXECUTE'),
      'authenticated EXECUTE on can_operate_live_for_place'),
  (10, 'predicate_not_client_callable_anon',
      not has_function_privilege('anon', 'public.can_operate_live_for_place(uuid,text)', 'EXECUTE'),
      'anon EXECUTE on can_operate_live_for_place');

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from live_email_verification_checks
order by ord;

rollback;
