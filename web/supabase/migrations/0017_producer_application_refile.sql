-- 0017 — PRODUCER APPLICATION REFILE (fixes rejection refile under user_id UNIQUE)
--
-- 0016 stores one row per account (user_id UNIQUE) but its submit RPC INSERTs
-- a new row, so re-filing after a rejection always fails with a unique
-- violation (surfaced as 503) even though refile-after-rejection is the
-- designed behavior (UI "Ajukan kembali"). No table change: this replaces the
-- submit RPC only — a rejected application is refiled by resetting the SAME
-- row back to 'pending' (email/note snapshot refreshed, reviewed_at cleared).
-- Pending/approved applications still refuse duplicates, and approval still
-- activates producer_memberships for the applicant's user_id only.

create or replace function public.submit_producer_application(
  p_user_id uuid,
  p_contact_email text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;
  -- Refuse to duplicate an active application (unchanged contract).
  if exists (
    select 1 from public.producer_applications
    where user_id = p_user_id and status in ('pending', 'approved')
  ) then
    raise exception 'application_already_active';
  end if;
  -- One row per account, ever: refile after rejection resets that row
  -- instead of inserting a second one (which user_id UNIQUE forbids).
  insert into public.producer_applications (user_id, status, contact_email, note)
  values (p_user_id, 'pending', p_contact_email, p_note)
  on conflict (user_id) do update
    set status = 'pending',
        contact_email = excluded.contact_email,
        note = excluded.note,
        reviewed_at = null,
        updated_at = now();
end;
$$;

revoke all on function public.submit_producer_application(uuid, text, text) from public, anon, authenticated;
