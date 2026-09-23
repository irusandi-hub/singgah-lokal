-- 0015 — CREATOR SINGLE ACTIVE SESSION (lease)
--
-- Exactly one Creator may hold the active Creator slot at a time. The slot
-- is a lease row in public.creator_session_lease with an expires_at bound to
-- the Creator's own user id, so a closed browser or lost session cannot lock
-- the slot forever. Enforcement is server-side and atomic via a unique
-- partial index; release is guarded by a Postgres advisory lock keyed on the
-- lease user id so two concurrent releases (e.g. a background refresh racing
-- an explicit sign-out) cannot each delete a different expired row.

create table if not exists public.creator_session_lease (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active_since timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- Fail-closed RLS: no policies on purpose — the table is reachable only via
-- the service-role connection used by the server-only lease module
-- (lib/creator/session-lease.ts), never from anon/authenticated clients.
alter table public.creator_session_lease enable row level security;
revoke all on public.creator_session_lease from anon, authenticated;

-- Atomic acquire: a single INSERT is the point of serialization. The unique
-- index on (1) guarantees at most one live row exists; concurrent acquires
-- race on it and Postgres picks exactly one winner per instant. An expired
-- row is not live (partial index predicate), so it never blocks the next
-- Creator once the TTL passes.
create unique index if not exists creator_session_lease_single_live_row
  on public.creator_session_lease ((1))
  where expires_at > now();

-- Advisory-lock-guarded release: deletes this user's row (expired or not).
-- pg_advisory_xact_lock serializes concurrent releases for the same user.
create or replace function public.release_creator_session_lease(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('creator_session_lease:'::text || p_user_id::text, 0));
  delete from public.creator_session_lease
  where user_id = p_user_id;
  get diagnostics released = row_count;
  return released > 0;
end;
$$;

revoke all on function public.release_creator_session_lease(uuid) from public, anon, authenticated;
