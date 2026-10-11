-- 0050_profile_phone_verification.sql
-- PROFILE FOUNDATION + PHONE OTP VERIFICATION (backend only).
--
-- Context: 0047 shipped public.users.username (self-only, username-only update).
-- Before this migration the account schema carries NO profile field beyond
-- username: no full name, no phone, no date of birth, no avatar. There is also
-- no phone verification of any kind, and no age computation.
--
-- This migration adds exactly that foundation, on the EXISTING public.users row
-- (no second "profile" table — the self-read RLS policy, the self-update policy,
-- the username uniqueness and the auth.users cascade trigger are all reused):
--
--  * full_name / date_of_birth — ordinary, self-owned profile fields;
--  * phone_e164 — the account's phone number, normalized to E.164 by the server;
--    the DB additionally enforces the E.164 shape, so a non-normalized value
--    cannot be stored even by a direct write;
--  * phone_verified_at — the ONE stored phone-verification fact. It is NEVER
--    client-writable (no column GRANT, and a trigger rejects it outside the
--    audited RPC). A filled phone field is NOT verification; only a completed
--    OTP confirmation sets this column;
--  * avatar_path — a reference into the PRIVATE `account-avatars` bucket;
--  * public.phone_otp_challenges — the OTP challenge store: HASH only (never a
--    plaintext code), short expiry, attempt counter, single use. Zero client
--    access (RLS on, no policy, no grant): only server code touches it;
--  * public.record_phone_otp_verification(uuid, text) — the ONLY path that may
--    set phone_verified_at. It is SECURITY DEFINER with `search_path` pinned and
--    EXECUTE revoked from PUBLIC/anon; it re-derives the actor from auth.uid().
--
-- It does NOT:
--  * create a second profile table, or duplicate the username rules;
--  * add ANY email write path (email stays read-only; registered-email changes
--    remain owned by the existing Supabase Auth security flow);
--  * add an SMS provider, an SMS vendor, or any provider secret;
--  * touch live_operators, live_operator_invitations, migrations 0046/0047/0048/
--    0049, or any Live policy;
--  * disable RLS, grant anything to anon, or widen any existing grant;
--  * couple phone verification to Producer/manager verification or to Place
--    claim_status. Those are three SEPARATE concepts and stay separate: nothing
--    here reads or writes producers.claim_status or places.claim_status.
--
-- POLICY GAPS recorded (no Master defines these — see docs/HANDOFF_LIVE_MVP.md
-- §30.2). They are implemented as neutral technical foundations, never as
-- invented product policy:
--  * profile phone/OTP/date-of-birth do not exist in any Master;
--  * minimum account age is NOT defined. MASTER_LIVE_POLICY §12.1 item 3 defines
--    an 18+ LIVE VIEWER gate whose mechanism is deferred to Phase 2.1, and it
--    explicitly states a self-declared date of birth does NOT satisfy that gate.
--    This migration therefore computes and sanity-bounds the age only; it grants
--    NO eligibility and no age-derived status;
--  * account age reference timezone is undefined: one constant
--    (lib/account/age.ts `ACCOUNT_AGE_TIMEZONE`).
--
-- Forward-only, least-privilege, non-destructive. DEV apply only.

begin;

-- ---------------------------------------------------------------------------
-- 1. Profile columns on the EXISTING public.users row
-- ---------------------------------------------------------------------------

alter table public.users add column if not exists full_name text;
alter table public.users add column if not exists date_of_birth date;
alter table public.users add column if not exists phone_e164 text;
alter table public.users add column if not exists phone_verified_at timestamptz;
alter table public.users add column if not exists avatar_path text;

comment on column public.users.full_name is
  'The account''s own full name. Self-owned profile data; a filled value is NOT a verification of any kind.';
comment on column public.users.date_of_birth is
  'The account''s own date of birth. The age is ALWAYS computed server-side from this date; no age number is stored, so it can never go stale. Sanity-bounded (not in the future, not more than 120 years back) — the minimum-age policy is undefined (Policy Gap).';
comment on column public.users.phone_e164 is
  'The account''s phone number in E.164. Normalized and validated server-side; the DB enforces the E.164 shape. Setting/changing it does NOT imply verification.';
comment on column public.users.phone_verified_at is
  'When the account''s CURRENT phone_e164 completed OTP confirmation. NULL = unverified. Writable ONLY by public.record_phone_otp_verification (no client column GRANT, enforced by guard_profile_write). Changing phone_e164 resets this to NULL.';
comment on column public.users.avatar_path is
  'Object path inside the PRIVATE account-avatars bucket (avatars/<user id>/<object>). No public URL is ever built from it; the server issues a short-lived signed URL.';

do $$ begin
  alter table public.users
    add constraint full_name_length
      check (full_name is null or char_length(btrim(full_name)) between 2 and 120);
exception
  when duplicate_object then null;
end $$;

-- E.164: a leading '+', a non-zero country code digit, 7..15 digits total.
-- The server normalizes before writing; this is the storage-level backstop that
-- makes a non-normalized number impossible even via a direct client write.
do $$ begin
  alter table public.users
    add constraint phone_e164_format
      check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$');
exception
  when duplicate_object then null;
end $$;

-- A verified phone always carries a number (never a verified-but-empty phone).
do $$ begin
  alter table public.users
    add constraint phone_verified_requires_number
      check (phone_verified_at is null or phone_e164 is not null);
exception
  when duplicate_object then null;
end $$;

-- Avatar objects live under the OWNER's user id, so a path can never address
-- another account's directory.
do $$ begin
  alter table public.users
    add constraint avatar_path_format
      check (
        avatar_path is null
        or avatar_path ~ '^avatars/[0-9a-fA-F-]{36}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
      );
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. One VERIFIED number per active account
-- ---------------------------------------------------------------------------
-- Policy Gap: no Master defines cross-account phone uniqueness. Applied as a
-- technical integrity rule: a number may be self-reported unverified on more
-- than one account (nothing is claimed while unverified), but only ONE active
-- account may hold it as VERIFIED. A PARTIAL unique index is required — a
-- UNIQUE constraint cannot carry a WHERE clause.
create unique index if not exists users_phone_verified_unique_idx
  on public.users (phone_e164)
  where phone_verified_at is not null;

-- ---------------------------------------------------------------------------
-- 3. Profile write guard — the protected verification column
-- ---------------------------------------------------------------------------
-- Defense in depth behind the column-level GRANT:
--  * phone_verified_at may not change OUTSIDE the audited OTP RPC (the RPC marks
--    its transaction with `singgah.phone_verification`); a direct UPDATE — by a
--    client OR by anything holding the service role — is rejected;
--  * a NEW row is never born verified;
--  * changing phone_e164 always resets the verification to NULL (re-verify the
--    new number), unless the RPC is recording that very verification;
--  * a verified row always keeps a number;
--  * date of birth is sanity-bounded: not in the future, not more than 120
--    years in the past. (No minimum-age policy is invented; see Policy Gaps.)
create or replace function public.guard_profile_write()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_verification_recording boolean :=
    coalesce(current_setting('singgah.phone_verification', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.phone_verified_at is not null then
      raise exception 'phone_verification_not_allowed' using errcode = 'P0001';
    end if;
  else
    if new.phone_verified_at is distinct from old.phone_verified_at
       and not v_verification_recording then
      raise exception 'phone_verification_not_allowed' using errcode = 'P0001';
    end if;

    if new.phone_e164 is distinct from old.phone_e164
       and not v_verification_recording then
      new.phone_verified_at := null;
    end if;
  end if;

  if new.phone_verified_at is not null and new.phone_e164 is null then
    new.phone_verified_at := null;
  end if;

  if new.date_of_birth is not null then
    if new.date_of_birth > current_date then
      raise exception 'date_of_birth_invalid' using errcode = 'P0001';
    end if;
    if new.date_of_birth < (current_date - interval '120 years') then
      raise exception 'date_of_birth_invalid' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_profile_write_trigger on public.users;
create trigger guard_profile_write_trigger
before insert or update on public.users
for each row execute procedure public.guard_profile_write();

-- Trigger-called only: no login-capable role may execute it directly.
revoke all on function public.guard_profile_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Self-only, profile-only update (reuses the 0047 self-update RLS policy)
-- ---------------------------------------------------------------------------
-- RLS decides WHICH ROW: the existing `users_username_self_update` policy
-- (id = auth.uid()) already scopes UPDATE to the caller's own row and is reused
-- as-is — no second, wider policy is created.
--
-- The column-level GRANT decides WHICH COLUMNS. phone_verified_at is
-- deliberately ABSENT: an authenticated account can never write its own
-- verification status directly. email is not a public.users column at all.
revoke update on public.users from anon, authenticated;
grant update (username, full_name, date_of_birth, phone_e164, avatar_path)
  on public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 5. OTP challenge store (hash only, single use, attempt + expiry bounded)
-- ---------------------------------------------------------------------------
create table if not exists public.phone_otp_challenges (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.users(id) on delete cascade,
  -- The number this challenge proves. Stored because the RPC copies it onto the
  -- account on success; it is NEVER written to a log line.
  phone_e164   text        not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- SHA-256 hex of the delivered code. The plaintext code is never stored.
  code_hash    text        not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts     integer     not null default 0 check (attempts >= 0),
  max_attempts integer     not null default 5 check (max_attempts between 1 and 10),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz null,
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at >= created_at)
);

comment on table public.phone_otp_challenges is
  'Phone OTP challenges. HASH only — the delivered code is never stored. Short expiry, bounded attempts, single use. Zero client access: RLS is on with NO policy and no grant, so only server code (service role) reads or writes it.';
comment on column public.phone_otp_challenges.code_hash is
  'SHA-256 hex of the OTP code. Compared server-side; the plaintext code and the full phone number are never logged.';

-- At most ONE outstanding (unconsumed) challenge per account: requesting a new
-- code supersedes the previous one, which the server consumes in the same step.
create unique index if not exists phone_otp_challenges_active_user_idx
  on public.phone_otp_challenges (user_id)
  where consumed_at is null;

-- Rate-limit / audit lookups: per account and per number.
create index if not exists phone_otp_challenges_user_created_idx
  on public.phone_otp_challenges (user_id, created_at desc);
create index if not exists phone_otp_challenges_phone_created_idx
  on public.phone_otp_challenges (phone_e164, created_at desc);

-- Fail closed: no policy at all, and no grant to anon/authenticated. A client
-- cannot read challenge rows (which would expose hashes and attempts) nor insert
-- its own challenge.
alter table public.phone_otp_challenges enable row level security;
revoke all on public.phone_otp_challenges from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. The ONLY verification write path
-- ---------------------------------------------------------------------------
-- The server hashes the submitted code (server-side pepper) and calls this with
-- the hash. The function re-derives the actor from auth.uid(), locks exactly the
-- caller's OWN challenge, enforces expiry + attempts + single use, and records
-- the verification atomically. It never discloses whether a number is already
-- verified on another account: that case answers EXACTLY like a wrong code.
create or replace function public.record_phone_otp_verification(
  p_challenge_id uuid,
  p_code_hash    text
) returns text
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.phone_otp_challenges;
  v_taken boolean;
begin
  if v_actor is null then
    return 'authentication_required';
  end if;

  -- Own challenge only; a foreign/unknown id is answered like a wrong code.
  select * into v_row
  from public.phone_otp_challenges
  where id = p_challenge_id
    and user_id = v_actor
  for update;

  if not found or v_row.consumed_at is not null then
    return 'phone_otp_invalid';
  end if;

  if v_row.expires_at <= now() then
    update public.phone_otp_challenges set consumed_at = now() where id = v_row.id;
    return 'phone_otp_expired';
  end if;

  if v_row.attempts >= v_row.max_attempts then
    return 'phone_otp_too_many_attempts';
  end if;

  update public.phone_otp_challenges
     set attempts = v_row.attempts + 1
   where id = v_row.id;

  if coalesce(p_code_hash, '') <> v_row.code_hash then
    if v_row.attempts + 1 >= v_row.max_attempts then
      return 'phone_otp_too_many_attempts';
    end if;
    return 'phone_otp_invalid';
  end if;

  -- One VERIFIED number per active account. A number verified on ANOTHER
  -- account answers exactly like a wrong code (no account enumeration). The
  -- partial unique index below is the race backstop.
  select exists (
    select 1
    from public.users u
    where u.phone_e164 = v_row.phone_e164
      and u.phone_verified_at is not null
      and u.id <> v_actor
  ) into v_taken;

  if v_taken then
    update public.phone_otp_challenges set consumed_at = now() where id = v_row.id;
    return 'phone_otp_invalid';
  end if;

  -- The audited recording of the verification: the ONE path that may set
  -- phone_verified_at (see guard_profile_write).
  perform set_config('singgah.phone_verification', 'on', true);
  update public.users
     set phone_e164 = v_row.phone_e164,
         phone_verified_at = now()
   where id = v_actor;

  update public.phone_otp_challenges set consumed_at = now() where id = v_row.id;

  return 'ok';
end;
$$;

revoke all on function public.record_phone_otp_verification(uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_phone_otp_verification(uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Avatar storage — PRIVATE bucket, per-user path, no listing
-- ---------------------------------------------------------------------------
-- A private bucket with ZERO storage.objects policy: anon/authenticated can
-- neither read nor write any avatar object, and there is no public URL and no
-- bucket listing. Writes happen server-side with the service role after the API
-- verified the session; reads are short-lived signed URLs. `on conflict do
-- nothing` keeps this idempotent and never rewrites an existing bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'account-avatars',
  'account-avatars',
  false,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do nothing;

-- NOTE: no policy is created on storage.objects for this bucket. With RLS on and
-- zero policies, only the service role can reach an object — the same posture as
-- the private claim-evidence bucket (0028) and the private AI source buckets.

commit;

-- ---------------------------------------------------------------------------
-- 8. Migration notes (DEV apply only, not a production change instruction)
-- ---------------------------------------------------------------------------
-- DEV apply checklist item: run against the Supabase DEVELOPMENT project only,
-- AFTER 0047 (this migration reuses 0047's self-update RLS policy and its
-- username rules). No existing data is deleted; existing accounts simply keep
-- NULL for every new column.
--
-- Post-apply verification (DEV):
--  * public.users has full_name, date_of_birth, phone_e164, phone_verified_at,
--    avatar_path with full_name_length / phone_e164_format /
--    phone_verified_requires_number / avatar_path_format, and the partial unique
--    index users_phone_verified_unique_idx
--  * an authenticated session updates ONLY its own row; a direct
--    `update public.users set phone_verified_at = now()` is rejected, and a
--    phone_e164 change clears phone_verified_at
--  * public.phone_otp_challenges has RLS on, NO policy, and no privilege for
--    anon/authenticated
--  * public.record_phone_otp_verification is executable by authenticated only —
--    verify with:
--      select has_function_privilege('anon',
--        'public.record_phone_otp_verification(uuid,text)', 'EXECUTE');  -- false
--      select has_function_privilege('authenticated',
--        'public.record_phone_otp_verification(uuid,text)', 'EXECUTE');  -- true
--  * storage bucket account-avatars exists with public = false
--
-- Manual blocker (not a code gap): no SMS/OTP provider is configured, so
-- requesting a code answers `phone_otp_provider_not_configured` and no challenge
-- is created. See docs/HANDOFF_LIVE_MVP.md §30.3.
--
-- Do not apply this migration to production without an explicit product decision
-- and the corresponding Supabase production apply step.
