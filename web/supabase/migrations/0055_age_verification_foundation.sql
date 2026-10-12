-- 0055 — AGE VERIFICATION FOUNDATION (provider-neutral, NOT wired to the gate).
--
-- Context: MASTER_LIVE_TECH §2.1 marks the verified-age mechanism
-- BLOCKED/TUNABLE (Phase 2.1) and MASTER_LIVE_POLICY §12.2 #2 keeps Live access
-- DENY for every viewer until that mechanism exists. The audit
-- (docs/audits/LIVE_AUTH_AUDIT_v1.md §2.3, §6) records that no vendor may be
-- chosen by the implementation, and that the gate is already a single
-- fail-closed function (`assert_viewer_eligible`) — the correct integration
-- point for later.
--
-- This migration builds ONLY the neutral foundation, so that choosing a vendor
-- later is a small, reviewable change:
--
--   * `public.age_verifications` — one row per account. It stores the RESULT of
--     a verification: status, an OPAQUE provider reference, a single boolean
--     "the subject meets the minimum age" fact, and the timestamps. It
--     deliberately has NO date of birth, NO identity-document field, NO
--     biometric field, and NO age number: a self-declared date of birth is not
--     verification (policy §12.1 item 3), so it must never be storable here.
--   * `public.age_verification_events` — the webhook/anti-replay ledger: an
--     event is recorded exactly once (`event_id` primary key) and marked
--     processed when its result is applied.
--   * `public.age_verification_satisfied(p_user_id uuid)` — the internal check:
--     status 'verified' AND minimum_age_confirmed AND verified_at is not null
--     AND (expires_at is null OR expires_at > now()). Internal only: EXECUTE is
--     revoked from PUBLIC/anon/authenticated.
--   * `public.record_age_verification_event(...)` / 
--     `public.apply_age_verification_result(...)` — the ONLY write paths,
--     SECURITY DEFINER with `search_path` pinned, EXECUTE service_role only, so
--     no client (and no non-infrastructure server role) can mint a verification.
--
-- It does NOT:
--   * choose, name, or configure a vendor, and adds no vendor column;
--   * wire anything into `assert_viewer_eligible` / `admit_live_viewer`: those
--     bodies are untouched and STILL DENY EVERY VIEWER unconditionally. The
--     one-change integration seam is documented in
--     docs/HANDOFF_LIVE_MVP.md and is only to be made AFTER a provider is
--     chosen, implemented, tested, and approved by the product owner;
--   * grant anything to `anon`;
--   * touch live_sessions / live_viewers / live_operators / any Live policy;
--   * create a "verified" row by itself — every row starts pending and only an
--     audited provider result can promote it.
--
-- Client access: RLS is on; a signed-in user may SELECT (self only, via the
-- only policy) their own status; nobody can write, and no other account's row
-- is readable. Forward-only, least privilege, non-destructive. DEV apply only.

begin;

-- ---------------------------------------------------------------------------
-- 1. Verification result (one row per account)
-- ---------------------------------------------------------------------------
create table if not exists public.age_verifications (
  user_id                uuid primary key references public.users(id) on delete cascade,
  status                 text not null
    constraint age_verifications_status_check
      check (status in ('pending', 'verified', 'failed', 'expired', 'revoked')),
  -- Opaque provider correlation handle (never an identity/document reference).
  provider_ref           text null
    constraint age_verifications_provider_ref_shape
      check (provider_ref is null or length(btrim(provider_ref)) between 4 and 200),
  -- The ONE age fact a provider may assert: the subject meets the minimum age
  -- (18, inclusive). NOT an age number and NOT a date of birth.
  minimum_age_confirmed  boolean not null default false,
  verified_at            timestamptz null,
  expires_at             timestamptz null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- A 'verified' row must carry the full, non-ambiguous proof.
  constraint age_verifications_verified_complete_check
    check (status <> 'verified' or (minimum_age_confirmed and verified_at is not null))
);

comment on table public.age_verifications is
  'Provider-neutral age-verification RESULT (Phase 2.1 foundation). Stores only status, an opaque provider reference, the boolean "meets minimum age" fact and timestamps — never a date of birth, an identity document, or biometric data. NOT consulted by assert_viewer_eligible in this migration.';
comment on column public.age_verifications.minimum_age_confirmed is
  'True only when the provider asserted that the subject meets the minimum age (18+). This is a result, never a self-declared date of birth (MASTER_LIVE_POLICY §12.1 item 3).';
comment on column public.age_verifications.provider_ref is
  'Opaque correlation handle for the provider request. No identity/document/biometric reference may be stored in this column or anywhere in this table.';

-- One verification per account (a re-verification updates the same row) and one
-- row per opaque provider reference, so a callback resolves deterministically.
create unique index if not exists age_verifications_provider_ref_key
  on public.age_verifications (provider_ref)
  where provider_ref is not null;

-- ---------------------------------------------------------------------------
-- 2. Webhook event ledger (idempotency / anti-replay)
-- ---------------------------------------------------------------------------
create table if not exists public.age_verification_events (
  event_id     text primary key
    constraint age_verification_events_id_shape
      check (length(btrim(event_id)) between 4 and 200),
  provider     text not null
    constraint age_verification_events_provider_shape
      check (length(btrim(provider)) between 2 and 60),
  event_type   text not null
    constraint age_verification_events_type_shape
      check (length(btrim(event_type)) between 2 and 60),
  received_at  timestamptz not null default now(),
  processed_at timestamptz null
);

comment on table public.age_verification_events is
  'Anti-replay ledger for age-verification webhooks. The primary key is the provider event id, so an event is recorded exactly once; processed_at is set when its result is applied. Zero client access.';

-- ---------------------------------------------------------------------------
-- 3. RLS + privileges
-- ---------------------------------------------------------------------------
alter table public.age_verifications enable row level security;
alter table public.age_verification_events enable row level security;

-- The only client-facing path: an account may READ its own status. No INSERT,
-- UPDATE or DELETE policy exists for any client role, so no client can create a
-- verification or promote its own status.
drop policy if exists age_verifications_self_read on public.age_verifications;
create policy age_verifications_self_read
  on public.age_verifications for select
  to authenticated
  using (user_id = auth.uid());

-- Fail closed: strip the implicit PUBLIC default and every client privilege,
-- then restore exactly the self-read SELECT for signed-in users. The event
-- ledger keeps ZERO client access (no grant, no policy).
revoke all on public.age_verifications from public, anon, authenticated;
grant select on public.age_verifications to authenticated;
revoke all on public.age_verification_events from public, anon, authenticated;

-- Server infrastructure (the provider callback path) reads and writes both.
grant select, insert, update on public.age_verifications to service_role;
grant select, insert, update on public.age_verification_events to service_role;

-- ---------------------------------------------------------------------------
-- 4. Internal check (never called by the Live gate in this migration)
-- ---------------------------------------------------------------------------
create or replace function public.age_verification_satisfied(p_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.age_verifications v
    where v.user_id = p_user_id
      and v.status = 'verified'
      and v.minimum_age_confirmed
      and v.verified_at is not null
      and (v.expires_at is null or v.expires_at > now())
  );
$$;

comment on function public.age_verification_satisfied(uuid) is
  'Internal Phase 2.1 check: true only for a currently-valid verified minimum-age result. Revoked, failed, pending and EXPIRED rows return false. Not referenced by assert_viewer_eligible in migration 0055 (see docs/HANDOFF_LIVE_MVP.md for the documented integration seam).';

revoke execute on function public.age_verification_satisfied(uuid) from public, anon, authenticated;
grant execute on function public.age_verification_satisfied(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Write paths (service_role only, audited by shape)
-- ---------------------------------------------------------------------------
-- Claim an incoming event exactly once. Returns false when the event was
-- already recorded (a replay) — the caller must then do nothing.
create or replace function public.record_age_verification_event(
  p_event_id text,
  p_provider text,
  p_event_type text
) returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_recorded text;
begin
  if p_event_id is null or btrim(p_event_id) = ''
     or p_provider is null or btrim(p_provider) = ''
     or p_event_type is null or btrim(p_event_type) = '' then
    raise exception 'age_verification_event_invalid' using errcode = 'P0001';
  end if;

  insert into public.age_verification_events (event_id, provider, event_type)
  values (btrim(p_event_id), btrim(p_provider), btrim(p_event_type))
  on conflict (event_id) do nothing
  returning event_id into v_recorded;

  if v_recorded is null then
    -- Replay: this event id was already recorded. Fail closed — the caller
    -- applies nothing.
    return false;
  end if;

  return true;
end;
$$;

-- Apply a provider result. This is the ONLY path that can write a verification
-- status, and it re-validates every invariant instead of trusting the caller:
-- a 'verified' row requires minimum_age_confirmed AND verified_at, and the
-- opaque provider reference is required for every non-terminal-pending row.
create or replace function public.apply_age_verification_result(
  p_event_id text,
  p_user_id uuid,
  p_status text,
  p_provider_ref text,
  p_minimum_age_confirmed boolean,
  p_verified_at timestamptz,
  p_expires_at timestamptz
) returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if p_user_id is null then
    raise exception 'age_verification_user_required' using errcode = 'P0001';
  end if;

  if p_status is null or p_status not in ('pending', 'verified', 'failed', 'expired', 'revoked') then
    raise exception 'age_verification_status_invalid' using errcode = 'P0001';
  end if;

  -- Fail closed: a "verified" write must carry the complete proof, and a
  -- failed/expired/revoked write may never claim the minimum-age fact.
  if p_status = 'verified' then
    if p_minimum_age_confirmed is not true or p_verified_at is null then
      raise exception 'age_verification_proof_incomplete' using errcode = 'P0001';
    end if;
  elsif p_minimum_age_confirmed is true then
    raise exception 'age_verification_fact_without_verified_status' using errcode = 'P0001';
  end if;

  if p_status <> 'pending' and (p_provider_ref is null or btrim(p_provider_ref) = '') then
    raise exception 'age_verification_provider_ref_required' using errcode = 'P0001';
  end if;

  insert into public.age_verifications
    (user_id, status, provider_ref, minimum_age_confirmed, verified_at, expires_at)
  values
    (
      p_user_id,
      p_status,
      nullif(btrim(coalesce(p_provider_ref, '')), ''),
      p_status = 'verified',
      case when p_status = 'verified' then p_verified_at else null end,
      p_expires_at
    )
  on conflict (user_id) do update
    set status = excluded.status,
        provider_ref = coalesce(excluded.provider_ref, public.age_verifications.provider_ref),
        minimum_age_confirmed = excluded.minimum_age_confirmed,
        verified_at = excluded.verified_at,
        expires_at = excluded.expires_at,
        updated_at = now();

  -- Mark the claimed event processed (when the caller supplies one), so the
  -- ledger shows what was applied and the same event can never be applied twice.
  if p_event_id is not null and btrim(p_event_id) <> '' then
    update public.age_verification_events
    set processed_at = now()
    where event_id = btrim(p_event_id) and processed_at is null;
  end if;
end;
$$;

revoke execute on function public.record_age_verification_event(text, text, text) from public, anon, authenticated;
revoke execute on function public.apply_age_verification_result(text, uuid, text, text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.record_age_verification_event(text, text, text) to service_role;
grant execute on function public.apply_age_verification_result(text, uuid, text, text, boolean, timestamptz, timestamptz) to service_role;

commit;
