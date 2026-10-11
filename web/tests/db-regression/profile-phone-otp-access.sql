-- ============================================================================
-- PROFILE + PHONE OTP ACCESS CHECK — migration 0050
-- Target: Supabase DEVELOPMENT project ONLY. NEVER production.
--
-- Run AFTER 0050 is applied, via the Supabase SQL Editor or:
--   psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/profile-phone-otp-access.sql
--
-- What it proves on the real engine:
--   1. an authenticated account updates ONLY its own profile fields;
--   2. another account's row is untouchable (RLS self-only update);
--   3. `phone_verified_at` is NOT client-writable, and even a direct service
--      write outside the audited RPC is rejected by the guard trigger;
--   4. a correct OTP code is the ONLY thing that moves a number from unverified
--      to verified, and the challenge is single-use;
--   5. a wrong code is refused and the attempt bound is enforced;
--   6. changing the number RESETS the verification to unverified;
--   7. a number already verified on another account answers EXACTLY like a wrong
--      code (no account enumeration);
--   8. anon holds no EXECUTE on the verification RPC and cannot read the
--      challenge table at all.
--
-- Design (same harness as live-operator-invitations-access.sql):
--   * The OTP codes below are hashed with a FIXED SCRIPT-ONLY secret, so no
--     pgcrypto call is needed at run time. Recompute with:
--       select encode(hmac('123456','singgah-dev-script-secret','sha256'),'hex');
--   * Error expectations use plpgsql BEGIN...EXCEPTION blocks (a caught
--     exception is a subtransaction, so a failed statement rolls back by itself)
--     and SAVEPOINTs, so the suite leaves NO data behind; the whole file is one
--     transaction ending in `rollback;`.
--   * Role switching uses set_config('role', ...) + request.jwt.claims, so the
--     RPC and the RLS policies run exactly as they do in production.
-- ============================================================================
\set ON_ERROR_STOP on
begin;

create schema if not exists _profile_otp_access;
grant usage on schema _profile_otp_access to authenticated, anon;

-- Script-only OTP secret. The hash is what the RPC compares; the real server
-- secret (PHONE_OTP_HASH_SECRET) is never needed here.
create or replace function _profile_otp_access.otp_hash(p_code text)
returns text
language sql
immutable
as $func$
  select case p_code
    when '123456' then 'f6dad18ec12f20ab3b8292722e63f232e23fe54711fbd786d2caf10cdfb3e1b5'
    when '000000' then 'ca9d6c7ea4dc242afd77cfa246dfaee5b40603101c9af4ed0cf2a0195e41758d'
    when '654321' then '6350f9aff8c14e76b1ae82d290a999927d60cb3c46470201fb9ad303aaa6efa4'
    when '222222' then '1e92b90f6125f46b6fb092b9acab632f6651ad59b56f3d83c81de10a93fb1503'
    else null
  end
$func$;

-- ---------------------------------------------------------------------------
-- Fixture: three accounts with known profile state. Returns their ids; the
-- per-check rollback discards every row.
-- ---------------------------------------------------------------------------
create or replace function _profile_otp_access.fixture()
returns table (user_a uuid, user_b uuid, user_c uuid)
language plpgsql
as $func$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
begin
  -- 0001's on_auth_user_created trigger mirrors every auth.users row into
  -- public.users.
  insert into auth.users (id, email, email_confirmed_at)
  values
    (v_a, 'poa-a@test.local', now()),
    (v_b, 'poa-b@test.local', now()),
    (v_c, 'poa-c@test.local', now());

  -- The auth trigger already created the public.users rows; this sets the
  -- profile state under test.
  insert into public.users (id, full_name, phone_e164)
  values
    (v_a, 'POA A', '+628111111111'),
    (v_b, 'POA B', '+628222222222'),
    (v_c, 'POA C', '+628333333333')
  on conflict (id) do update
    set full_name = excluded.full_name,
        phone_e164 = excluded.phone_e164;

  return query select v_a, v_b, v_c;
end;
$func$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function _profile_otp_access.act_as(p_user uuid)
returns void
language plpgsql
as $func$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user::text)::text, true);
  perform set_config('role', 'authenticated', true);
end;
$func$;

create or replace function _profile_otp_access.act_as_anon()
returns void
language plpgsql
as $func$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end;
$func$;

create or replace function _profile_otp_access.reset_actor()
returns void
language plpgsql
as $func$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end;
$func$;

create or replace function _profile_otp_access.expect_error(
  p_sql text,
  p_state text,
  p_msg_like text default null
)
returns text
language plpgsql
as $func$
declare v_state text; v_msg text;
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

create or replace function _profile_otp_access.expect_text(p_sql text)
returns text
language plpgsql
as $func$
declare v_out text;
begin
  execute p_sql into v_out;
  return v_out;
end;
$func$;

-- Server-side challenge creation (the real writer is the service role).
create or replace function _profile_otp_access.new_challenge(
  p_user uuid,
  p_phone text,
  p_code text,
  p_minutes int default 10
) returns uuid
language plpgsql
as $func$
declare v_id uuid;
begin
  insert into public.phone_otp_challenges (user_id, phone_e164, code_hash, created_at, expires_at)
  values (
    p_user, p_phone, _profile_otp_access.otp_hash(p_code),
    now() + make_interval(mins => p_minutes - 10),
    now() + make_interval(mins => p_minutes)
  )
  returning id into v_id;
  return v_id;
end;
$func$;

-- ===========================================================================
-- CHECK 1 — an account updates only its OWN profile fields
-- ===========================================================================
create or replace function _profile_otp_access.check_profile_self_update()
returns void
language plpgsql
as $func$
declare f record;
begin
  select * into f from _profile_otp_access.fixture();

  perform _profile_otp_access.act_as(f.user_a);
  update public.users
     set full_name = 'POA A Updated',
         date_of_birth = current_date - interval '30 years',
         phone_e164 = '+6281234567890'
   where id = f.user_a;

  perform _profile_otp_access.reset_actor();

  if (select full_name from public.users where id = f.user_a) <> 'POA A Updated' then
    raise exception 'assertion_failed: own full_name was not updated';
  end if;
  if (select phone_e164 from public.users where id = f.user_a) <> '+6281234567890' then
    raise exception 'assertion_failed: own phone was not updated';
  end if;
  if (select phone_verified_at from public.users where id = f.user_a) is not null then
    raise exception 'assertion_failed: a filled phone must stay UNVERIFIED';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 2 — another account's row is untouchable
-- ===========================================================================
create or replace function _profile_otp_access.check_foreign_profile_blocked()
returns void
language plpgsql
as $func$
declare f record; v_changed int;
begin
  select * into f from _profile_otp_access.fixture();

  perform _profile_otp_access.act_as(f.user_a);
  update public.users set full_name = 'DICURI' where id = f.user_b;
  get diagnostics v_changed = row_count;
  perform _profile_otp_access.reset_actor();

  if v_changed <> 0 then
    raise exception 'assertion_failed: another account''s row was updated (% rows)', v_changed;
  end if;
  if (select full_name from public.users where id = f.user_b) <> 'POA B' then
    raise exception 'assertion_failed: another profile was modified';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 3 — the verification column is locked (client AND service write)
-- ===========================================================================
create or replace function _profile_otp_access.check_verification_column_locked()
returns void
language plpgsql
as $func$
declare f record;
begin
  select * into f from _profile_otp_access.fixture();

  -- A signed-in account holds no UPDATE privilege on that column.
  perform _profile_otp_access.act_as(f.user_a);
  perform _profile_otp_access.expect_error(
    format('update public.users set phone_verified_at = now() where id = %L', f.user_a),
    '42501'
  );
  perform _profile_otp_access.reset_actor();

  -- Even a direct service write outside the audited RPC is refused.
  perform _profile_otp_access.expect_error(
    format('update public.users set phone_verified_at = now() where id = %L', f.user_a),
    'P0001',
    'phone_verification_not_allowed%'
  );

  -- A row is never born verified.
  perform _profile_otp_access.expect_error(
    format(
      'insert into public.users (id, phone_verified_at) values (%L, now())',
      gen_random_uuid()
    ),
    'P0001',
    'phone_verification_not_allowed%'
  );
end;
$func$;

-- ===========================================================================
-- CHECK 4 — a correct code verifies the number, exactly once
-- ===========================================================================
create or replace function _profile_otp_access.check_otp_verify_happy_path()
returns void
language plpgsql
as $func$
declare f record; v_id uuid; v_result text;
begin
  select * into f from _profile_otp_access.fixture();

  perform _profile_otp_access.reset_actor();
  v_id := _profile_otp_access.new_challenge(f.user_a, '+6281234567890', '123456');

  perform _profile_otp_access.act_as(f.user_a);
  v_result := _profile_otp_access.expect_text(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('123456')
    )
  );
  if v_result <> 'ok' then
    raise exception 'assertion_failed: expected ok, got %', v_result;
  end if;

  -- Single use: the same challenge is refused afterwards.
  v_result := _profile_otp_access.expect_text(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('123456')
    )
  );
  if v_result <> 'phone_otp_invalid' then
    raise exception 'assertion_failed: a consumed challenge must be refused, got %', v_result;
  end if;
  perform _profile_otp_access.reset_actor();

  if (select phone_verified_at from public.users where id = f.user_a) is null then
    raise exception 'assertion_failed: the verification was not recorded';
  end if;
  if (select phone_e164 from public.users where id = f.user_a) <> '+6281234567890' then
    raise exception 'assertion_failed: the verified number was not stored';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 5 — a wrong code is refused and the attempt bound is enforced
-- ===========================================================================
create or replace function _profile_otp_access.check_otp_wrong_and_bounded()
returns void
language plpgsql
as $func$
declare f record; v_id uuid; v_result text; i int;
begin
  select * into f from _profile_otp_access.fixture();

  perform _profile_otp_access.reset_actor();
  v_id := _profile_otp_access.new_challenge(f.user_a, '+6281234567890', '654321');

  perform _profile_otp_access.act_as(f.user_a);
  for i in 1..4 loop
    v_result := _profile_otp_access.expect_text(
      format(
        'select public.record_phone_otp_verification(%L, %L)',
        v_id, _profile_otp_access.otp_hash('000000')
      )
    );
    if v_result <> 'phone_otp_invalid' then
      raise exception 'assertion_failed: attempt % expected phone_otp_invalid, got %', i, v_result;
    end if;
  end loop;

  v_result := _profile_otp_access.expect_text(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('000000')
    )
  );
  if v_result <> 'phone_otp_too_many_attempts' then
    raise exception 'assertion_failed: the 5th attempt must exhaust, got %', v_result;
  end if;

  -- Even the CORRECT code cannot revive an exhausted challenge.
  v_result := _profile_otp_access.expect_text(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('654321')
    )
  );
  if v_result <> 'phone_otp_too_many_attempts' then
    raise exception 'assertion_failed: an exhausted challenge must stay closed, got %', v_result;
  end if;
  perform _profile_otp_access.reset_actor();

  if (select phone_verified_at from public.users where id = f.user_a) is not null then
    raise exception 'assertion_failed: an exhausted challenge must never verify';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 6 — changing the number resets the verification
-- ===========================================================================
create or replace function _profile_otp_access.check_number_change_resets()
returns void
language plpgsql
as $func$
declare f record; v_id uuid;
begin
  select * into f from _profile_otp_access.fixture();

  perform _profile_otp_access.reset_actor();
  v_id := _profile_otp_access.new_challenge(f.user_a, '+6281234567890', '123456');

  perform _profile_otp_access.act_as(f.user_a);
  perform _profile_otp_access.expect_text(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('123456')
    )
  );

  update public.users set phone_e164 = '+6289999999999' where id = f.user_a;
  perform _profile_otp_access.reset_actor();

  if (select phone_verified_at from public.users where id = f.user_a) is not null then
    raise exception 'assertion_failed: a changed number must reset to UNVERIFIED';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 7 — a number verified on another account answers like a wrong code
-- ===========================================================================
create or replace function _profile_otp_access.check_taken_number_answers_uniformly()
returns void
language plpgsql
as $func$
declare f record; v_id uuid; v_result text;
begin
  select * into f from _profile_otp_access.fixture();

  -- A verifies the shared number.
  perform _profile_otp_access.reset_actor();
  v_id := _profile_otp_access.new_challenge(f.user_a, '+6281234567890', '123456');
  perform _profile_otp_access.act_as(f.user_a);
  perform _profile_otp_access.expect_text(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('123456')
    )
  );
  perform _profile_otp_access.reset_actor();

  -- B submits the SAME number with a CORRECT code.
  v_id := _profile_otp_access.new_challenge(f.user_b, '+6281234567890', '222222');
  perform _profile_otp_access.act_as(f.user_b);
  v_result := _profile_otp_access.expect_text(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('222222')
    )
  );
  perform _profile_otp_access.reset_actor();

  if v_result <> 'phone_otp_invalid' then
    raise exception 'assertion_failed: expected the wrong-code answer, got %', v_result;
  end if;
  if (select phone_verified_at from public.users where id = f.user_b) is not null then
    raise exception 'assertion_failed: the second account must not be verified';
  end if;
end;
$func$;

-- ===========================================================================
-- CHECK 8 — anon is locked out of the RPC and the challenge table
-- ===========================================================================
create or replace function _profile_otp_access.check_anon_locked_out()
returns void
language plpgsql
as $func$
declare f record; v_id uuid;
begin
  select * into f from _profile_otp_access.fixture();
  perform _profile_otp_access.reset_actor();
  v_id := _profile_otp_access.new_challenge(f.user_a, '+6281234567890', '123456');

  perform _profile_otp_access.act_as_anon();
  perform _profile_otp_access.expect_error(
    format(
      'select public.record_phone_otp_verification(%L, %L)',
      v_id, _profile_otp_access.otp_hash('123456')
    ),
    '42501'
  );
  perform _profile_otp_access.expect_error(
    'select count(*) from public.phone_otp_challenges',
    '42501'
  );
  perform _profile_otp_access.reset_actor();

  -- Defence in depth: the trigger function is not directly callable either.
  perform _profile_otp_access.act_as_anon();
  if has_function_privilege('anon', 'public.guard_profile_write()', 'EXECUTE') then
    raise exception 'assertion_failed: anon must not execute the guard trigger function';
  end if;
  perform _profile_otp_access.reset_actor();
end;
$func$;

-- ===========================================================================
-- Runner — one savepoint per check; failures counted in a session GUC.
-- ===========================================================================
savepoint sp_poa_1;
do $run$
begin
  perform _profile_otp_access.check_profile_self_update();
  raise notice 'PROFILE-OTP-ACCESS PASS — profile_self_update';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — profile_self_update: %', sqlerrm;
end
$run$;
rollback to sp_poa_1;

savepoint sp_poa_2;
do $run$
begin
  perform _profile_otp_access.check_foreign_profile_blocked();
  raise notice 'PROFILE-OTP-ACCESS PASS — foreign_profile_blocked';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — foreign_profile_blocked: %', sqlerrm;
end
$run$;
rollback to sp_poa_2;

savepoint sp_poa_3;
do $run$
begin
  perform _profile_otp_access.check_verification_column_locked();
  raise notice 'PROFILE-OTP-ACCESS PASS — verification_column_locked';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — verification_column_locked: %', sqlerrm;
end
$run$;
rollback to sp_poa_3;

savepoint sp_poa_4;
do $run$
begin
  perform _profile_otp_access.check_otp_verify_happy_path();
  raise notice 'PROFILE-OTP-ACCESS PASS — otp_verify_happy_path';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — otp_verify_happy_path: %', sqlerrm;
end
$run$;
rollback to sp_poa_4;

savepoint sp_poa_5;
do $run$
begin
  perform _profile_otp_access.check_otp_wrong_and_bounded();
  raise notice 'PROFILE-OTP-ACCESS PASS — otp_wrong_and_bounded';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — otp_wrong_and_bounded: %', sqlerrm;
end
$run$;
rollback to sp_poa_5;

savepoint sp_poa_6;
do $run$
begin
  perform _profile_otp_access.check_number_change_resets();
  raise notice 'PROFILE-OTP-ACCESS PASS — number_change_resets';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — number_change_resets: %', sqlerrm;
end
$run$;
rollback to sp_poa_6;

savepoint sp_poa_7;
do $run$
begin
  perform _profile_otp_access.check_taken_number_answers_uniformly();
  raise notice 'PROFILE-OTP-ACCESS PASS — taken_number_answers_uniformly';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — taken_number_answers_uniformly: %', sqlerrm;
end
$run$;
rollback to sp_poa_7;

savepoint sp_poa_8;
do $run$
begin
  perform _profile_otp_access.check_anon_locked_out();
  raise notice 'PROFILE-OTP-ACCESS PASS — anon_locked_out';
exception when others then
  perform set_config('_profile_otp_access.failed', (coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int + 1)::text, false);
  raise notice 'PROFILE-OTP-ACCESS FAIL — anon_locked_out: %', sqlerrm;
end
$run$;
rollback to sp_poa_8;

do $verdict$
declare
  v_failed int := coalesce(nullif(current_setting('_profile_otp_access.failed', true), ''), '0')::int;
begin
  if v_failed > 0 then
    raise exception 'PROFILE OTP ACCESS CHECK FAILED: % check(s) failed', v_failed;
  end if;
  raise notice 'PROFILE OTP ACCESS: ALL CHECKS PASSED';
end
$verdict$;

rollback; -- everything above is a dry run against the DEVELOPMENT database
