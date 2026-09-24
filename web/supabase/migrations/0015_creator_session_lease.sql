-- 0015: Creator session lease singleton.
--
-- The Creator gate has one global slot.  Do not model this with a partial
-- index whose predicate contains now(): PostgreSQL index predicates require
-- immutable expressions, and expiration must be evaluated in the locked
-- transaction instead.
--
-- The fixed boolean primary key is the singleton slot.  The row is kept in
-- place when the lease is released; user_id/expires_at are cleared instead.
-- Both acquire and release take the same transaction-scoped advisory lock,
-- then lock the slot row.  Consequently an active lease cannot be replaced by
-- another Creator, while an expired lease can be atomically claimed.

create table if not exists public.creator_session_lease (
  slot_id boolean primary key,
  user_id uuid references public.users(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_session_lease_single_slot check (slot_id = true)
);

alter table public.creator_session_lease enable row level security;
revoke all on public.creator_session_lease from public, anon, authenticated;

-- There is exactly one slot row.  Keeping it in place makes the singleton
-- invariant explicit and avoids a create/delete race between callers.
insert into public.creator_session_lease (slot_id)
values (true)
on conflict (slot_id) do nothing;

create or replace function public.acquire_creator_session_lease(
  p_user_id uuid,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_lease record;
begin
  if p_user_id is null or p_expires_at is null or p_expires_at <= clock_timestamp() then
    return false;
  end if;

  -- The lock is held until the RPC transaction commits.  Release uses the
  -- exact same key, so an acquire cannot race a release or another Creator.
  perform pg_advisory_xact_lock(hashtext('creator_session_lease'));

  -- Defensive re-seeding for a database that was initialized before the
  -- singleton row was introduced.  The advisory lock serializes this too.
  insert into public.creator_session_lease (slot_id)
  values (true)
  on conflict (slot_id) do nothing;

  select user_id, expires_at
    into v_lease
    from public.creator_session_lease
   where slot_id = true
   for update;

  if v_lease.user_id is not null
     and v_lease.user_id <> p_user_id
     and v_lease.expires_at is not null
     and v_lease.expires_at > clock_timestamp() then
    return false;
  end if;

  update public.creator_session_lease
     set user_id = p_user_id,
         expires_at = p_expires_at,
         updated_at = clock_timestamp()
   where slot_id = true;

  return true;
end;
$$;

create or replace function public.release_creator_session_lease(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_lease record;
begin
  if p_user_id is null then
    return false;
  end if;

  -- Use the same lock as acquire.  The owner check prevents an old Creator
  -- from releasing a lease that has already expired and been claimed by a
  -- different Creator.
  perform pg_advisory_xact_lock(hashtext('creator_session_lease'));

  select user_id
    into v_lease
    from public.creator_session_lease
   where slot_id = true
   for update;

  if not found or v_lease.user_id is distinct from p_user_id then
    return false;
  end if;

  update public.creator_session_lease
     set user_id = null,
         expires_at = null,
         updated_at = clock_timestamp()
   where slot_id = true;

  return true;
end;
$$;

-- The RPCs are service-role/server-only.  The TypeScript layer additionally
-- calls requireCreator() before invoking them.
revoke execute on function public.acquire_creator_session_lease(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.acquire_creator_session_lease(uuid, timestamptz)
  to service_role;

revoke execute on function public.release_creator_session_lease(uuid)
  from public, anon, authenticated;
grant execute on function public.release_creator_session_lease(uuid)
  to service_role;
