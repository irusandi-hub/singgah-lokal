-- 0047_account_center_live_operator.sql
-- Account Center access + delegated Live Operator access.
--
-- This migration is DEV-application scoped (see HANDOFF_LIVE_MVP §6 and the
-- project AGENTS.md rule: never delete data/migrations without explicit
-- approval). It adds:
--  * public.users.username — the account's own public display label (nullable
--    for legacy accounts that predate the field)
--  * a self-only, username-only update path (column-level GRANT + RLS) so an
--    account can set its OWN username and nothing else on that row
--  * public.live_operators — delegated Live-operator access: one row per
--    user + Place, granted/revoked by the owner/manager of that Place
--  * read-only RLS for the assigned operator and for the Place's owner/manager
--  * two audited SECURITY DEFINER RPCs that are the ONLY write path, so a
--    client cannot forge granted_by or widen its own access
--
-- It does NOT:
--  * change owner / manager / editor
--  * repurpose editor as Live Operator
--  * create a fifth authority tier
--  * make Producer membership imply operator access (or the reverse)
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

-- A present username is a bounded, alphanumeric/hyphen display label the
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

do $$ begin
  alter table public.users
    add constraint username_length
      check (username is null or char_length(username) between 3 and 30);
exception
  when duplicate_object then null;
end $$;

-- Uniqueness needs a PARTIAL unique INDEX, not a UNIQUE constraint: a
-- constraint cannot carry a WHERE clause. (The previous draft wrote
-- "unique (username) where username is not null", which is not valid SQL.)
create unique index if not exists users_username_unique_idx
  on public.users (username)
  where username is not null;

-- Self-only, username-only update.
--
-- RLS decides WHICH ROW may be updated; the column-level GRANT decides WHICH
-- COLUMN may be written. Together they mean an authenticated account can set
-- exactly `username` on exactly its own row — it cannot touch platform_role,
-- email, display_name, or another account's row.
revoke update on public.users from anon, authenticated;
grant update (username) on public.users to authenticated;

drop policy if exists users_username_self_update on public.users;
create policy users_username_self_update
  on public.users for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- The existing SELECT policy (users_self_access: id = auth.uid()) is unchanged
-- and still the only read path for a user's own row.

-- ---------------------------------------------------------------------------
-- 2. Delegated Live Operator access
-- ---------------------------------------------------------------------------

create table if not exists public.live_operators (
  user_id      uuid        not null references public.users(id)     on delete cascade,
  place_id     text        not null references public.places(id)    on delete cascade,
  granted_by   text        not null references public.producers(id) on delete cascade,
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz null,
  primary key (user_id, place_id)
);

create index if not exists live_operators_place_idx
  on public.live_operators (place_id);

comment on table public.live_operators is
  'Delegated Live-operator access for one Place. Owner/manager of the Place grants/revokes; the assigned user may start/end Live for that exact Place only. A Producer membership is NOT an operator assignment.';

comment on column public.live_operators.user_id is
  'The SINGGAH LOKAL account that may operate Live for the Place. Never a newly created account — only an existing one.';

comment on column public.live_operators.place_id is
  'The exact Place the operator is allowed to run Live for. Knowing this id alone is never sufficient to start/end Live.';

comment on column public.live_operators.granted_by is
  'The Producer that granted the access, derived server-side from the granting owner/manager membership — never taken from client input.';

comment on column public.live_operators.revoked_at is
  'Non-null once the access has been revoked. After revocation the row stays as an audit record and the user loses operating access.';

-- ---------------------------------------------------------------------------
-- 3. RLS on live_operators (fail closed; reads only, writes via RPC)
-- ---------------------------------------------------------------------------

alter table public.live_operators enable row level security;

-- No direct table writes at all: grant/revoke are audited RPCs. Reads are the
-- only thing an authenticated session may do with this table, and only for
-- rows it is entitled to see.
revoke all on public.live_operators from public, anon, authenticated;
grant select on public.live_operators to authenticated;

-- The assigned operator may read its own rows (active and revoked), so the
-- Account Center can show active access and so a revocation is observable.
drop policy if exists live_operators_self_read on public.live_operators;
create policy live_operators_self_read
  on public.live_operators for select
  using (user_id = auth.uid());

-- A Place's owner/manager may read the operator rows for their own Places, so
-- the existing management capability can list who currently has access.
drop policy if exists live_operators_producer_read on public.live_operators;
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

-- The operator must be able to read the exact Place they operate (its
-- canonical display name), even while that Place is not yet published. This
-- NARROWS nothing: it only adds a read for a Place the account has an ACTIVE
-- delegated assignment on. Revoked assignments grant no read.
drop policy if exists places_live_operator_read on public.places;
create policy places_live_operator_read
  on public.places for select
  using (
    exists (
      select 1
      from public.live_operators lo
      where lo.user_id = auth.uid()
        and lo.place_id = places.id
        and lo.revoked_at is null
    )
  );

-- A delegated operator must be able to pick the Proses to broadcast, so they
-- may READ the PUBLISHED stages of a Place they hold an ACTIVE assignment on.
-- Read-only and published-only: they still cannot create, change, publish, or
-- delete any stage (no INSERT/UPDATE/DELETE policy is added, and none of the
-- producer_memberships write policies apply to them).
drop policy if exists production_stages_live_operator_read on public.production_stages;
create policy production_stages_live_operator_read
  on public.production_stages for select
  using (
    status = 'published'
    and exists (
      select 1
      from public.live_operators lo
      where lo.user_id = auth.uid()
        and lo.place_id = production_stages.place_id
        and lo.revoked_at is null
    )
  );

-- A delegated operator must be able to END the Live they started, which means
-- reading the session's own Place. Read-only and scoped to an ACTIVE
-- assignment on that EXACT Place — an operator gains no other session access
-- and no write path.
drop policy if exists live_sessions_live_operator_read on public.live_sessions;
create policy live_sessions_live_operator_read
  on public.live_sessions for select
  using (
    exists (
      select 1
      from public.live_operators lo
      where lo.user_id = auth.uid()
        and lo.place_id = live_sessions.place_id
        and lo.revoked_at is null
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Audited grant/revoke RPCs — the ONLY write path
-- ---------------------------------------------------------------------------
--
-- Both functions re-check that the caller is the Place's owner/manager and
-- derive granted_by from that membership, so a caller can never forge who
-- granted the access nor grant for a Place they do not own/manage.

create or replace function public.grant_live_operator_access(
  p_user_id  uuid,
  p_place_id text
) returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_producer_id text;
begin
  select m.producer_id into v_producer_id
  from public.producer_memberships m
  where m.user_id = auth.uid()
    and m.place_id = p_place_id
    and m.role in ('owner', 'manager')
  limit 1;

  if v_producer_id is null then
    raise exception 'live_operator_grant_not_allowed' using errcode = 'P0001';
  end if;

  -- Idempotent on (user_id, place_id): re-granting an active assignment is a
  -- no-op at the row level; re-granting a revoked one clears the revocation.
  insert into public.live_operators (user_id, place_id, granted_by, granted_at, revoked_at)
    values (p_user_id, p_place_id, v_producer_id, now(), null)
    on conflict (user_id, place_id) do update
      set revoked_at = null,
          granted_by = v_producer_id,
          granted_at = now()
      where public.live_operators.revoked_at is not null;

  return true;
end;
$$;

revoke all on function public.grant_live_operator_access(uuid, text) from public, anon, authenticated;
grant execute on function public.grant_live_operator_access(uuid, text) to authenticated;

create or replace function public.revoke_live_operator_access(
  p_user_id  uuid,
  p_place_id text
) returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_allowed boolean;
  v_count integer;
begin
  select exists (
    select 1
    from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = p_place_id
      and m.role in ('owner', 'manager')
  ) into v_allowed;

  if not v_allowed then
    raise exception 'live_operator_revoke_not_allowed' using errcode = 'P0001';
  end if;

  update public.live_operators
    set revoked_at = now()
    where user_id = p_user_id
      and place_id = p_place_id
      and revoked_at is null;

  -- GET DIAGNOSTICS (not GET STACKED DIAGNOSTICS): outside an exception
  -- handler only the plain form is valid.
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.revoke_live_operator_access(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_live_operator_access(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Privacy-safe account resolution for delegated-operator management
-- ---------------------------------------------------------------------------
--
-- An owner/manager must be able to NAME the existing account they delegate to,
-- but a public user directory is prohibited (MASTER AUTHORITY §5/§6: no
-- Producer reaches another Producer, and User data is never browsable). So
-- there is NO listing, NO email lookup, and NO way to enumerate accounts.
-- These two SECURITY DEFINER functions expose the minimum an owner/manager
-- needs, and only to a caller who already holds an owner/manager membership:
--
--  * resolve_account_by_username — an EXACT match on the account's own public
--    username label (the field 0047 adds), returning at most ONE row.
--  * list_place_live_operators  — the operator rows of ONE Place the caller
--    owner/manages, labelled with the operator's public username.
--
-- Both are read-only: neither grants authority, and neither can widen the
-- caller's own access. The authorization is re-checked inside each function
-- server-side, never taken from the client.

create or replace function public.resolve_account_by_username(
  p_username text
) returns table (user_id uuid, username text)
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.role in ('owner', 'manager')
  ) then
    raise exception 'account_lookup_not_allowed' using errcode = 'P0001';
  end if;

  -- EXACT match only — no pattern, no prefix, no partial search.
  return query
    select u.id, u.username
    from public.users u
    where u.username is not null
      and u.username = p_username
    limit 1;
end;
$$;

revoke all on function public.resolve_account_by_username(text) from public, anon, authenticated;
grant execute on function public.resolve_account_by_username(text) to authenticated;

create or replace function public.list_place_live_operators(
  p_place_id text
) returns table (
  user_id    uuid,
  username   text,
  granted_at timestamptz,
  revoked_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = p_place_id
      and m.role in ('owner', 'manager')
  ) then
    raise exception 'live_operator_list_not_allowed' using errcode = 'P0001';
  end if;

  return query
    select lo.user_id, u.username, lo.granted_at, lo.revoked_at
    from public.live_operators lo
    left join public.users u on u.id = lo.user_id
    where lo.place_id = p_place_id
    order by lo.granted_at asc;
end;
$$;

revoke all on function public.list_place_live_operators(text) from public, anon, authenticated;
grant execute on function public.list_place_live_operators(text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 6. Migration notes (DEV apply only, not a production change instruction)
-- ---------------------------------------------------------------------------
-- DEV apply checklist item: run this migration against the Supabase
-- DEVELOPMENT project only. It changes public.users and adds
-- public.live_operators plus two small RPCs. No existing data is deleted; an
-- existing public.users.username stays null until that account sets one.
--
-- Post-apply verification (DEV):
--  * public.users.username exists with username_format / username_length and
--    the partial unique index users_username_unique_idx
--  * an authenticated session can update its OWN username and cannot update
--    any other account's row
--  * public.live_operators has RLS on, SELECT for authenticated, no direct
--    write, and both RPCs deny a caller who is not the Place owner/manager
--  * a delegated operator reads the exact Place name for an active
--    assignment; a revoked assignment grants nothing
--  * resolve_account_by_username resolves an EXACT username for an
--    owner/manager and lists nothing else; list_place_live_operators returns
--    only the operator rows of a Place the caller owner/manages
--
-- Do not apply this migration to production without an explicit product
-- decision and the corresponding Supabase production apply step.
