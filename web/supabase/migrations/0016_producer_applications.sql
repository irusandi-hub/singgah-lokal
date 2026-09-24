-- 0016 — PRODUCER APPLICATION (identity locked to auth.users.id)
--
-- One SINGGAH LOKAL account = one Producer identity. An application is always
-- filed by the signed-in account: user_id references auth.users (via
-- public.users, same as producer_memberships) and is UNIQUE, so one account
-- holds at most one application and there is no separate Producer
-- email/password ever created. Admin approval activates
-- producer_memberships for the SAME user_id — no new auth user, no new
-- credentials. Email is stored only as a display/audit snapshot copied from
-- the authenticated session; it never authorizes anything.

create table if not exists public.producer_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  contact_email text,
  note text check (note is null or char_length(note) <= 1000),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Fail-closed RLS: no policies on purpose. Applications are read/written
-- only through server code (service-role connection), exactly like the
-- Creator secret-question table — clients can never touch rows directly.
alter table public.producer_applications enable row level security;
revoke all on public.producer_applications from anon, authenticated;

-- Submit: server-side only. The caller passes the authenticated user's id
-- and the authenticated user's own email (snapshot). An existing pending or
-- approved application is never overwritten; a rejected one may be refiled.
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
  -- Refuse to duplicate an active application.
  if exists (
    select 1 from public.producer_applications
    where user_id = p_user_id and status in ('pending', 'approved')
  ) then
    raise exception 'application_already_active';
  end if;
  insert into public.producer_applications (user_id, status, contact_email, note)
  values (p_user_id, 'pending', p_contact_email, p_note);
end;
$$;

-- Approve: activates membership for the APPLICANT's user_id on the target
-- place. Creates nothing in auth — the same account simply gains Producer
-- access because producer_memberships is keyed by user_id.
create or replace function public.approve_producer_application(
  p_application_id uuid,
  p_producer_id text,
  p_place_id text,
  p_role text default 'owner'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  applicant uuid;
begin
  if p_role not in ('owner', 'manager') then
    raise exception 'invalid_role';
  end if;
  select user_id into applicant from public.producer_applications
  where id = p_application_id and status = 'pending'
  for update;
  if applicant is null then
    raise exception 'application_not_pending';
  end if;
  -- Idempotent membership activation for the same account.
  insert into public.producer_memberships (user_id, producer_id, place_id, role)
  values (applicant, p_producer_id, p_place_id, p_role)
  on conflict (user_id, place_id) do update
    set role = excluded.role;
  update public.producer_applications
  set status = 'approved', reviewed_at = now(), updated_at = now()
  where id = p_application_id;
end;
$$;

revoke all on function public.submit_producer_application(uuid, text, text) from public, anon, authenticated;
revoke all on function public.approve_producer_application(uuid, text, text, text) from public, anon, authenticated;
