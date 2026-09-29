-- 0034 — PLACE CLAIM ARCHIVE: internal operational traceability for decided
-- claims (MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0 §1–§7, §16).
--
-- WHAT THIS SYNCHRONIZES
-- This migration mirrors the archive implementation already ACTIVE on
-- Supabase DEV: the `place_claim_archives` table, its 30-day retention
-- columns, its fail-closed access posture, and the internal Admin-only
-- search function. Applying it to any environment yields the same shape DEV
-- already runs; every statement is `if not exists` / idempotent, so applying
-- it over an environment where DEV's version was applied manually is a no-op.
--
-- RULES HONOURED (MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0)
-- - §1 INTERNAL TRACEABILITY ONLY. The archive is not user-facing content
--   and not a public record; nothing here grants any client access.
-- - §2/§3 EXACTLY 30 DAYS. Each archive row carries `archived_at`; the
--   cleanup horizon is `archived_at + interval '30 days'`. No grace period,
--   no permanent retention: the table only ever holds rows still inside
--   their window (or awaiting their cleanup retry).
-- - §4 NOT NORMAL HISTORY. No operational surface reads this table; the
--   Admin claim queue and the Place workspace timeline keep reading the
--   canonical `place_claims` only.
-- - §5 AUTHORIZED PLATFORM ADMIN SEARCH ONLY. The one search function
--   re-verifies `public.users.platform_role = 'platform_moderator'` from
--   the session (`auth.uid()`) on EVERY call and fails closed, the same
--   predicate migration 0008 uses for the Live moderation functions.
-- - §7 STORAGE FIRST. This migration stores the evidence reference and the
--   archived-at timestamp; it deletes nothing. Deletion order is enforced
--   by the cleanup Edge Function (`cleanup-place-claim-archives`): storage
--   first, DB finalization only on storage success, retries on failure.
-- - §8 NO PERMANENT PRESERVATION. Finalized rows are gone by design.
-- - AGENTS.md IDEMPOTENCY. Re-applying this file is a no-op.
--
-- ACCESS POSTURE (mirrors 0028 `place_claims` / 0031 `place_audit`): RLS on,
-- zero policies, every client role stripped. Only the service role (server
-- code behind the Platform Admin guard, and the authorized cleanup worker)
-- reads or writes.

create table if not exists public.place_claim_archives (
  id uuid primary key,
  place_id text not null,
  user_id uuid not null,
  status text not null,
  evidence_path text not null,
  evidence_file_name text,
  evidence_mime_type text,
  evidence_size_bytes integer,
  note text,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null,
  -- The retention clock (§2): exactly 30 days from this moment.
  archived_at timestamptz not null default now(),
  -- Set when the §7 order completes (storage deleted, row finalized). A row
  -- without this timestamp is either inside its window or awaiting retry.
  finalized_at timestamptz
);

-- Cleanup scans by the retention horizon; internal search narrows by Place
-- and by claimant.
create index if not exists place_claim_archives_archived_at_idx
on public.place_claim_archives (archived_at);

create index if not exists place_claim_archives_place_idx
on public.place_claim_archives (place_id);

create index if not exists place_claim_archives_user_idx
on public.place_claim_archives (user_id);

-- Fail closed like every other privileged claim surface: no policy, no
-- client access, service role only.
alter table public.place_claim_archives enable row level security;

revoke all on public.place_claim_archives from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal Admin-only archive search (MASTER §5, §16.1)
-- ---------------------------------------------------------------------------

-- The one moderator predicate, session-derived, fail closed — the same check
-- every Live moderation RPC in 0008 performs before touching privileged data.
create or replace function public.assert_platform_moderator()
returns void
language plpgsql
stable
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_moderator_required' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.assert_platform_moderator()
from public, anon, authenticated;

-- Search the archive by Place ID, claimant (Pengelola) ID, claimant account
-- email, or claim ID. Every identifier is optional; supplied ones are ANDed.
-- The email branch resolves the claimant's auth account server-side (the
-- canonical email lives in `auth.users`, the same source migration 0008
-- reads; `public.users` stores no email) and only inside the moderator
-- guard, so the private identifying data never reaches a client that is not
-- an authorized Platform Admin session.
--
-- Returns ONLY rows still inside the 30-day window: finalized rows are gone,
-- and a row whose storage deletion is pending retry is still traceable until
-- cleanup succeeds (§7) — hiding it would hide a live evidence object.
create or replace function public.search_place_claim_archives(
  p_place_id text default null,
  p_user_id text default null,
  p_email text default null,
  p_claim_id text default null
)
returns table (
  id uuid,
  place_id text,
  user_id uuid,
  status text,
  evidence_file_name text,
  note text,
  review_note text,
  reviewed_at timestamptz,
  created_at timestamptz,
  archived_at timestamptz
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_email_user uuid;
  v_email_filter boolean := false;
begin
  perform public.assert_platform_moderator();

  if p_email is not null and btrim(p_email) <> '' then
    v_email_filter := true;
    select u.id into v_email_user
    from auth.users u
    where lower(u.email) = lower(btrim(p_email))
    limit 1;
  end if;

  return query
    select a.id,
           a.place_id,
           a.user_id,
           a.status,
           a.evidence_file_name,
           a.note,
           a.review_note,
           a.reviewed_at,
           a.created_at,
           a.archived_at
    from public.place_claim_archives a
    where a.finalized_at is null
      and a.archived_at > now() - interval '30 days'
      and (p_place_id is null or btrim(p_place_id) = '' or a.place_id = btrim(p_place_id))
      and (p_user_id is null or btrim(p_user_id) = '' or a.user_id::text = btrim(p_user_id))
      -- A supplied email that matches NO account yields ZERO rows (an email
    -- filter is a real filter — it never degrades to "no filter"), because a
    -- NULL v_email_user here means "matched nobody", not "unfiltered".
    and (not v_email_filter or a.user_id = v_email_user)
      and (p_claim_id is null or btrim(p_claim_id) = '' or a.id::text = btrim(p_claim_id))
    order by a.archived_at desc, a.created_at desc
    limit 500;
end;
$$;

revoke execute on function public.search_place_claim_archives(text, text, text, text)
from public, anon, authenticated;
