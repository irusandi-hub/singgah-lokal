-- age-verification-access.sql — age-verification foundation (migration 0055).
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/age-verification-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/age-verification-foundation.test.ts.
--
-- Contract verified (docs/audits/LIVE_AUTH_AUDIT_v1.md §2.3/§6; the neutral
-- integration boundary built by Tahap C):
--   1. the storage exists with the MINIMAL shape: status, opaque provider
--      reference, the single boolean "meets the minimum age" fact and
--      timestamps — no date of birth, no identity document, no biometrics, no
--      age number;
--   2. clients (anon, authenticated) cannot write it or escalate a status, and
--      a signed-in account sees ONLY its own row;
--   3. the webhook ledger records each event id exactly once (replays refused)
--      and marks an event processed when its result is applied;
--   4. only service_role can record events, apply results or run the internal
--      check;
--   5. the internal check is exact: verified + minimum_age_confirmed + not
--      expired + not revoked;
--   6. **the Live gate is still fail-closed**: a fully valid verified result does
--      NOT admit a viewer — `assert_viewer_eligible` is untouched and still
--      denies every viewer, and its body never references this foundation.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check. The whole script runs in ONE transaction and ends with `rollback;`,
-- so it leaves no data behind.

begin;

create temporary table age_verification_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures (superuser; rolled back at the end)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('eeeeeee2-0000-4000-8000-000000000001', 'age-foundation@example.com', now())
on conflict (id) do nothing;

insert into public.users (id) values ('eeeeeee2-0000-4000-8000-000000000001')
on conflict (id) do nothing;

insert into public.producers (id, display_name)
values ('prod-age-dev', 'Pengelola Age DEV')
on conflict (id) do nothing;

insert into public.production_stages (id, place_id, title, description, sort_order, status)
values ('stage-age-dev', 'rumah-teh-lokal', 'Tahap Age DEV', 'x', 0, 'published')
on conflict (id) do nothing;

insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
values ('live-age-dev', 'rumah-teh-lokal', 'prod-age-dev', 'stage-age-dev', 'live', 'age-dev-key-1')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Storage shape (minimal, no identity data)
-- ---------------------------------------------------------------------------
insert into age_verification_checks values
  (1, 'verification_table_exists', to_regclass('public.age_verifications') is not null, 'age_verifications'),
  (2, 'event_ledger_exists', to_regclass('public.age_verification_events') is not null, 'age_verification_events'),
  (3, 'verification_rls_on',
      (select relrowsecurity from pg_class where oid = 'public.age_verifications'::regclass), 'RLS enabled'),
  (4, 'event_ledger_rls_on',
      (select relrowsecurity from pg_class where oid = 'public.age_verification_events'::regclass), 'RLS enabled'),
  (5, 'event_ledger_has_no_policy',
      not exists (select 1 from pg_policies where schemaname='public' and tablename='age_verification_events'),
      'zero client access'),
  (6, 'verification_has_only_self_read_policy',
      (select count(*) = 1 from pg_policies where schemaname='public' and tablename='age_verifications')
      and exists (
        select 1 from pg_policies
        where schemaname='public' and tablename='age_verifications'
          and policyname='age_verifications_self_read' and cmd='SELECT'
      ),
      'exactly one SELECT policy, self-scoped'),
  (7, 'no_identity_or_dob_columns',
      not exists (
        select 1 from information_schema.columns
        where table_schema='public' and table_name='age_verifications'
          and column_name in ('date_of_birth','document_number','document_type','selfie','biometric_ref','age_years','verified_age')
      ),
      'no DOB / document / biometric / age-number column'),
  (8, 'minimum_age_is_a_boolean',
      exists (
        select 1 from information_schema.columns
        where table_schema='public' and table_name='age_verifications'
          and column_name='minimum_age_confirmed' and data_type='boolean' and is_nullable='NO'
      ),
      'the only age fact is the boolean minimum-age result'),
  (9, 'verified_requires_complete_proof_constraint',
      exists (
        select 1 from pg_constraint
        where conrelid='public.age_verifications'::regclass
          and conname='age_verifications_verified_complete_check'
      ),
      'verified needs minimum_age_confirmed AND verified_at');

-- Client privilege posture: self-read only, never a write.
insert into age_verification_checks values
  (10, 'anon_has_no_select', not has_table_privilege('anon','public.age_verifications','SELECT'), 'anon SELECT'),
  (11, 'authenticated_has_select', has_table_privilege('authenticated','public.age_verifications','SELECT'), 'authenticated SELECT (RLS self-scoped)'),
  (12, 'authenticated_no_insert', not has_table_privilege('authenticated','public.age_verifications','INSERT'), 'authenticated INSERT'),
  (13, 'authenticated_no_update', not has_table_privilege('authenticated','public.age_verifications','UPDATE'), 'authenticated UPDATE'),
  (14, 'authenticated_no_delete', not has_table_privilege('authenticated','public.age_verifications','DELETE'), 'authenticated DELETE'),
  (15, 'anon_has_no_event_access', not has_table_privilege('anon','public.age_verification_events','SELECT'), 'anon event ledger'),
  (16, 'authenticated_has_no_event_access', not has_table_privilege('authenticated','public.age_verification_events','SELECT'), 'authenticated event ledger');

-- Internal check + write paths are service_role only.
insert into age_verification_checks values
  (17, 'satisfied_execute_service_role_only',
      not has_function_privilege('anon','public.age_verification_satisfied(uuid)','EXECUTE')
      and not has_function_privilege('authenticated','public.age_verification_satisfied(uuid)','EXECUTE')
      and has_function_privilege('service_role','public.age_verification_satisfied(uuid)','EXECUTE'),
      'internal check posture'),
  (18, 'record_event_execute_service_role_only',
      not has_function_privilege('anon','public.record_age_verification_event(text,text,text)','EXECUTE')
      and not has_function_privilege('authenticated','public.record_age_verification_event(text,text,text)','EXECUTE')
      and has_function_privilege('service_role','public.record_age_verification_event(text,text,text)','EXECUTE'),
      'event claim posture'),
  (19, 'apply_result_execute_service_role_only',
      not has_function_privilege('anon','public.apply_age_verification_result(text,uuid,text,text,boolean,timestamptz,timestamptz)','EXECUTE')
      and not has_function_privilege('authenticated','public.apply_age_verification_result(text,uuid,text,text,boolean,timestamptz,timestamptz)','EXECUTE')
      and has_function_privilege('service_role','public.apply_age_verification_result(text,uuid,text,text,boolean,timestamptz,timestamptz)','EXECUTE'),
      'result-apply posture'),
  (20, 'no_public_grantee_on_write_paths',
      not exists (
        select 1
        from aclexplode(coalesce(
          (select proacl from pg_proc where oid = 'public.apply_age_verification_result(text,uuid,text,text,boolean,timestamptz,timestamptz)'::regprocedure),
          acldefault('f', (select proowner from pg_proc where oid = 'public.apply_age_verification_result(text,uuid,text,text,boolean,timestamptz,timestamptz)'::regprocedure))
        ))
        where grantee = 0 and privilege_type = 'EXECUTE'
      ),
      'PUBLIC grantee on apply_age_verification_result');

-- ---------------------------------------------------------------------------
-- 2. Call-time behaviour: replay, invariants, exactness
-- ---------------------------------------------------------------------------
do $$
declare
  v_first boolean;
  v_replay boolean;
  v_satisfied boolean;
  v_count integer;
begin
  -- replay: the same event id is recorded once.
  execute 'set role service_role';
  select public.record_age_verification_event('evt-dev-1', 'vendor-dev', 'verification.completed') into v_first;
  select public.record_age_verification_event('evt-dev-1', 'vendor-dev', 'verification.completed') into v_replay;
  execute 'reset role';
  insert into age_verification_checks values
    (30, 'event_recorded_once',
        v_first is true and v_replay is false,
        'first=' || coalesce(v_first::text,'null') || ' replay=' || coalesce(v_replay::text,'null'));

  -- a valid verified result is applied and satisfies the internal check.
  execute 'set role service_role';
  perform public.apply_age_verification_result(
    'evt-dev-1', 'eeeeeee2-0000-4000-8000-000000000001', 'verified', 'ref-age-dev', true, now(), now() + interval '1 year');
  select public.age_verification_satisfied('eeeeeee2-0000-4000-8000-000000000001') into v_satisfied;
  execute 'reset role';
  insert into age_verification_checks values
    (31, 'verified_result_satisfied', v_satisfied is true, 'satisfied=' || coalesce(v_satisfied::text,'null')),
    (32, 'event_marked_processed',
        (select processed_at is not null from public.age_verification_events where event_id = 'evt-dev-1'),
        'processed_at set once applied');

  -- expired / revoked results stop satisfying the check.
  execute 'set role service_role';
  perform public.apply_age_verification_result(
    null, 'eeeeeee2-0000-4000-8000-000000000001', 'verified', 'ref-age-dev', true, now() - interval '1 year', now() - interval '1 day');
  select public.age_verification_satisfied('eeeeeee2-0000-4000-8000-000000000001') into v_satisfied;
  execute 'reset role';
  insert into age_verification_checks values
    (33, 'expired_result_not_satisfied', v_satisfied is false, 'expired → false');

  execute 'set role service_role';
  perform public.apply_age_verification_result(null, 'eeeeeee2-0000-4000-8000-000000000001', 'revoked', 'ref-age-dev', false, null, null);
  select public.age_verification_satisfied('eeeeeee2-0000-4000-8000-000000000001') into v_satisfied;
  execute 'reset role';
  insert into age_verification_checks values
    (34, 'revoked_result_not_satisfied', v_satisfied is false, 'revoked → false');

  -- an incomplete "verified" write is refused outright.
  begin
    execute 'set role service_role';
    perform public.apply_age_verification_result(null, 'eeeeeee2-0000-4000-8000-000000000001', 'verified', 'ref-bad', false, now(), null);
    execute 'reset role';
    insert into age_verification_checks values
      (35, 'incomplete_verified_write_refused', false, 'write unexpectedly accepted');
  exception when others then
    execute 'reset role';
    insert into age_verification_checks values
      (35, 'incomplete_verified_write_refused', sqlerrm = 'age_verification_proof_incomplete', sqlerrm);
  end;

  -- clients can neither write nor escalate.
  begin
    execute 'set role authenticated';
    perform set_config('request.jwt.claims',
      '{"sub":"eeeeeee2-0000-4000-8000-000000000001","role":"authenticated"}', false);
    insert into public.age_verifications (user_id, status, provider_ref, minimum_age_confirmed, verified_at)
      values ('eeeeeee2-0000-4000-8000-000000000001', 'verified', 'ref-forged', true, now());
    execute 'reset role';
    insert into age_verification_checks values
      (36, 'client_cannot_write_verification', false, 'client write unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into age_verification_checks values
      (36, 'client_cannot_write_verification', true, sqlerrm);
  end;

  begin
    execute 'set role authenticated';
    perform set_config('request.jwt.claims',
      '{"sub":"eeeeeee2-0000-4000-8000-000000000001","role":"authenticated"}', false);
    update public.age_verifications set status = 'verified' where user_id = 'eeeeeee2-0000-4000-8000-000000000001';
    execute 'reset role';
    insert into age_verification_checks values
      (37, 'client_cannot_escalate_status', false, 'client update unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into age_verification_checks values
      (37, 'client_cannot_escalate_status', true, sqlerrm);
  end;

  -- the client still sees its OWN row (self-read is the one useful path).
  execute 'set role authenticated';
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeee2-0000-4000-8000-000000000001","role":"authenticated"}', false);
  select count(*) into v_count from public.age_verifications;
  execute 'reset role';
  insert into age_verification_checks values
    (38, 'client_reads_own_row', v_count = 1, 'rows visible to the account: ' || v_count::text);
end $$;

-- ---------------------------------------------------------------------------
-- 3. THE POINT: the Live viewer gate is untouched and still denies all
-- ---------------------------------------------------------------------------
do $$
declare
  v_body text;
begin
  select prosrc into v_body from pg_proc where proname = 'assert_viewer_eligible';
  insert into age_verification_checks values
    (40, 'gate_body_never_references_age_foundation',
        v_body not like '%age_verification%',
        'assert_viewer_eligible must be untouched by 0055'),
    (41, 'gate_still_denies_unconditionally',
        v_body like '%raise exception ''live_viewer_denied'' using errcode = ''P0001'';%'
        and v_body like '%B1 (blocked)%',
        'the B1 deny-all tail is still present');
end $$;

do $$
declare
  v_tmp integer;
begin
  -- BEST CASE for a viewer: confirmed email + a currently valid verified
  -- minimum-age result + a live session. Admission must STILL be refused.
  execute 'set role service_role';
  perform public.apply_age_verification_result(
    null, 'eeeeeee2-0000-4000-8000-000000000001', 'verified', 'ref-age-dev', true, now(), now() + interval '1 year');
  execute 'reset role';

  execute 'set role authenticated';
  perform set_config('request.jwt.claims',
    '{"sub":"eeeeeee2-0000-4000-8000-000000000001","role":"authenticated"}', false);
  begin
    perform public.admit_live_viewer('live-age-dev');
    execute 'reset role';
    insert into age_verification_checks values
      (42, 'admission_still_denied_with_valid_age_result', false, 'admission unexpectedly succeeded');
  exception when others then
    execute 'reset role';
    insert into age_verification_checks values
      (42, 'admission_still_denied_with_valid_age_result',
          sqlerrm = 'live_viewer_denied', sqlerrm);
  end;

  insert into age_verification_checks values
    (43, 'no_ledger_row_for_denied_viewer',
        (select count(*) = 0 from public.live_viewers where live_session_id = 'live-age-dev'),
        'a denied admission writes no ledger row');
end $$;

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from age_verification_checks
order by ord;

rollback;
