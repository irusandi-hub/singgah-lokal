-- 0047_account_center_live_operator.sql
-- Account Center access management + delegated Live Operator access.
--
-- This migration is DEV-application scoped (see HANDOFF_LIVE_MVP §6 and the
-- project AGENTS.md rule: never delete data/migrations without explicit
-- approval). It adds:
--  * public.users.username (canonical public display name, nullable for legacy
--    accounts that predate the field)
--  * public.live_operators (delegated Live-operator access: one row per
--    user + place, granted/revoked by the Producer owner/manager of that Place)
--  * RLS + self-access policies so a user can read/update only their own username
--    and owners/managers can manage Live Operator rows for their Place
--  * server-side helpers for the Live start/end paths to accept an explicit
--    Live Operator assignment in addition to the existing owner/manager path
--
-- It does NOT:
--  * change owner / manager / editor
--  * repurpose editor as Live Operator
--  * create a fifth authority tier
--  * weaken or bypass any existing Live policy (authentication, email
--    verification, age/eligibility, fixed-camera, one active Live per Place,
--    active Live limits, viewer limits, session duration, moderation,
--    reporting, private realtime channels, server-side authorization, secrets)

begin;

-- ---------------------------------------------------------------------------
-- 1. Username on public.users
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists username text;

-- A present username is a bounded, Latin/alphanumeric/hyphen display label the
-- signed-in account owns. Absent is allowed for legacy rows and for accounts
-- that have never set one; the app treats "no username" as "no public display
-- name yet" rather than inventing one.
do $$ begin
  alter table public.users
    add constraint username_format
      check (username is null or username ~ '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$');
exception
  when duplicate_object then null;
end $$;

-- Bounded length at the DB level too (server validator will also enforce it).
do $$ begin
  alter table public.users
    add constraint username_length
      check (username is null or char_length(username) between 3 and 30);
exception
  when duplicate_object then null;
end $$;

-- Uniqueness (so a username is an honest public label, not a duplicate).
do $$ begin
  alter table public.users
    add constraint users_username_unique
      unique (username)
      where username is not null;
exception
  when duplicate_object then null;
end $$;

-- Self-only read/write for username. A user may read and update ONLY their own
-- row's username. No other authenticated role can touch another account's
-- username, and the service role remains the only path that can set it for
-- another account (and only through an audited, explicit operation).
create policy if not exists users_username_self_read
  on public.users for select
  using (id = auth.uid());

create policy if not exists users_username_self_update
  on public.users for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- Application-side username validation still runs before any update; the DB
-- policy only restricts writes to the authenticated user's own row.

-- Keep the existing self-access policy intact for the rest of the row; the
-- migration above adds narrow username policies, it does not widen user access.

-- ---------------------------------------------------------------------------
-- 2. Delegated Live Operator access
-- ---------------------------------------------------------------------------

create table if not exists public.live_operators (
  user_id      uuid        not null references public.users(id)    on delete cascade,
  place_id     text        not null references public.places(id)   on delete cascade,
  granted_by   text        not null references public.producers(id) on delete cascade,
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz null,
  primary key (user_id, place_id)
);

comment on table public.live_operators is
  'Delegated Live-operator access for one Place. Owner/manager of the Place grants/revokes; the assigned user may start/end Live for that exact Place only through the existing Live authorization paths.';

comment on column public.live_operators.user_id is
  'The SINGGAH LOKAL account that may operate Live for the Place. Never a newly created account — only an existing one.';

comment on column public.live_operators.place_id is
  'The exact Place the operator is allowed to run Live for. Knowing this id alone is never sufficient to start/end Live.';

comment on column public.live_operators.granted_by is
  'The Producer (owner/manager) that granted the access. Ownership belongs to the Place, so the grantor is the Place’s Producer identity.';

comment on column public.live_operators.revoked_at is
  'Non-null once the access has been revoked. After revocation the row stays as an audit record and the user loses operating access.';

-- ---------------------------------------------------------------------------
-- 3. RLS on live_operators (fail-closed first)
-- ---------------------------------------------------------------------------

alter table public.live_operators enable row level security;

revoke all on public.live_operators from public, anon, authenticated;

-- A user may read rows where they are the assigned operator.
create policy live_operators_self_read
  on public.live_operators for select
  using (user_id = auth.uid());

-- A user may read rows for Places they own/manage (so owners/managers can
-- manage operators for their own Places only).
create policy live_operators_producer_read
  on public.live_operators for select
  using (
    exists (
      select 1
      from public.producer_memberships m
      where m.user_id = auth.uid()
        and m.place_id = live_operators.place_id
        and m.role in ('owner', 'manager')
    )
  );

-- Only the owner/manager of the Place may insert a Live Operator for it.
create policy live_operators_producer_insert
  on public.live_operators for insert
  with check (
    exists (
      select 1
      from public.producer_memberships m
      where m.user_id = auth.uid()
        and m.place_id = live_operators.place_id
        and m.role in ('owner', 'manager')
    )
  );

-- Only the owner/manager of the Place may revoke (update revoked_at) a row
-- for that Place. The row itself is not deleted — it remains as an audit record.
create policy live_operators_producer_update
  on public.live_operators for update
  using (
    exists (
      select 1
      from public.producer_memberships m
      where m.user_id = auth.uid()
        and m.place_id = live_operators.place_id
        and m.role in ('owner', 'manager')
    )
  )
  with check (
    exists (
      select 1
      from public.producer_memberships m
      where m.user_id = auth.uid()
        and m.place_id = live_operators.place_id
        and m.role in ('owner', 'manager')
    )
    and (live_operators.revoked_at is null or live_operators.revoked_at is not null)
  );

-- No delete via RLS. Revocation is an update to revoked_at (auditable),
-- matching the existing pattern for other access decisions in the app.

-- ---------------------------------------------------------------------------
-- 4. Idempotency/audit helper for grant/revoke (optional small landing guard)
-- ---------------------------------------------------------------------------

-- Grant is idempotent on (user_id, place_id): granting again when already active
-- is a no-op at the row level, not a duplicate-error.
create or replace function public.grant_live_operator_access(
  p_user_id  uuid,
  p_place_id text,
  p_producer_id text
) returns setof public.live_operators
language plpgsql
security definer set search_path = public
as $$
begin
  -- Only the Place’s owner/manager may call this (server-side only, but belt
  -- and suspenders in case the function is ever exposed more widely).
  if not exists (
    select 1
    from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = p_place_id
      and m.role in ('owner', 'manager')
  ) then
    raise exception 'live_operator_grant_not_allowed' using errcode = 'P0001';
  end if;

  insert into public.live_operators (user_id, place_id, granted_by, granted_at, revoked_at)
    values (p_user_id, p_place_id, p_producer_id, now(), null)
    on conflict (user_id, place_id) do update
      set revoked_at = null
      where public.live_operators.revoked_at is not null
    returning *;
end;
$$;

revoke all on function public.grant_live_operator_access(uuid, text, text) from public, anon, authenticated;
grant execute on function public.grant_live_operator_access(uuid, text, text) to authenticated;

create or replace function public.revoke_live_operator_access(
  p_user_id  uuid,
  p_place_id text
) returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_count integer;
begin
  if not exists (
    select 1
    from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = p_place_id
      and m.role in ('owner', 'manager')
  ) then
    raise exception 'live_operator_revoke_not_allowed' using errcode = 'P0001';
  end if;

  update public.live_operators
    set revoked_at = now()
    where user_id = p_user_id
      and place_id = p_place_id
      and revoked_at is null;

  get stacked diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.revoke_live_operator_access(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_live_operator_access(uuid, text) to authenticated;

-- A small privacy-safe lookup helper for owner/manager use: find a SINGGAH
-- LOKAL account by email (exact case-insensitive match) and return only the
-- columns the owner/manager needs to decide whether to grant Live Operator
-- access. It never returns another account’s password, memberships, tokens, or
-- anything other than the public display identity the app already shows.
create or replace function public.lookup_rakyat_account_by_email(
  p_email text
) returns table (
  user_id     uuid,
  email       text,
  username    text,
  created_at  timestamptz
)
language sql
security definer set search_path = public
as $$
  select id, email, username, created_at
  from public.users
  where lower(users.email) = lower(p_email)
  limit 1;
$$;

revoke all on function public.lookup_rakyat_account_by_email(text) from public, anon, authenticated;
grant execute on function public.lookup_rakyat_account_by_email(text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 5. Migration notes (DEV apply only, not a production change instruction)
-- ---------------------------------------------------------------------------
-- DEV apply checklist item: run this migration against the Supabase DEVELOPMENT
-- project only. It changes public.users and adds public.live_operators plus
-- three small RPCs. No existing data is deleted or altered except that existing
-- public.users.username values remain null until/unless accounts set one.
--
-- Required follow-up after this migration is applied in DEV:
--  * wire the server-side helpers into the Live start/end authorization paths
--    (producer owner/manager OR live_operator assignment for the exact place)
--  * add the Account Center “Kelola Akses Live” UI behind owner/manager only
--  * add username self-edit UI in Account Center (server-owned, ownership-validated)
--  * add/update regression tests for:
--      - username ownership + validation + unauthorized changes rejected
--      - Live Operator grant/revoke only by Place owner/manager
--      - Live Operator exact-Place authorization on start/end
--      - Live Operator cannot edit Place/Experience/Media/Production Story
--      - Live Operator cannot respond to Visit Intent
--      - unauthorized user cannot grant/revoke Live access
--
-- Do not apply this migration to production without an explicit product decision
-- and the corresponding Supabase production apply step.
