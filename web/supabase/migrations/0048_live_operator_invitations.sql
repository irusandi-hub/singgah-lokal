-- 0048_live_operator_invitations.sql
-- LIVE OPERATOR INVITATIONS — the invitation lifecycle on top of 0047.
--
-- 0047 shipped delegated Operator Live access (public.live_operators) with a
-- direct grant/revoke RPC and a USERNAME lookup. It has NO invitation entity:
-- nothing is pending, nothing expires, and the grant bypasses the invitee.
-- This migration adds the missing lifecycle:
--
--   pending  → accepted | rejected | cancelled | expired   (accepted/rejected by the invitee)
--   accepted → revoked                                     (by a manager of that Place)
--   terminal: rejected, cancelled, expired, revoked         (a new invitation = a NEW row)
--
-- Locked by the task specification (see HANDOFF_LIVE_MVP.md "Policy Gaps"):
--  * the inviter is an owner/manager of the EXACT Place, re-verified server-side;
--  * the lookup is by REGISTERED EMAIL, never a username, and NEVER auto-creates
--    an account; the invite RPC answers uniformly whether or not the email
--    exists, so the endpoint cannot be used to enumerate accounts;
--  * one PENDING invitation per (Place, user) — partial unique index;
--  * at most ONE ACTIVE operator per Place — partial unique index (the previous
--    operator is revoked explicitly, in the same transaction, on replacement);
--  * a manager may not invite themself;
--  * revocation takes effect IMMEDIATELY (the Live start/end checks read the
--    table on every call — there is no authorization cache).
--
-- It does NOT:
--  * re-apply or alter 0047 (it only ADDS a table, an index, RPCs and a trigger);
--  * grant anything to anon, disable RLS, or widen any existing grant;
--  * change any Live policy (authentication, email verification, age/eligibility,
--    fixed camera, one active Live per Place, caps, moderation, secrets);
--  * touch profiles, OTP, DOB, or migration 0046.
--
-- POLICY GAPS recorded (no Master defines these — see HANDOFF_LIVE_MVP.md):
--  * invitation TTL (here: 7 days, a single configured constant, mirrored by
--    lib/live/operator-invitations-model.ts);
--  * replacement semantics (here: explicit same-transaction revoke of the
--    previous active operator);
--  * notification category for operator events (not in MASTER 10 §6: access
--    changes use the mandatory `safety_account`; manager-facing outcomes use
--    `system`);
--  * no scheduler exists, so expiry is swept lazily by the list RPCs (and the
--    sweep function is reachable by the service role for a future cron).
--
-- Forward-only, least-privilege, non-destructive. DEV apply only.

begin;

-- ---------------------------------------------------------------------------
-- 1. Invitation entity
-- ---------------------------------------------------------------------------
create table if not exists public.live_operator_invitations (
  id                    uuid        primary key default gen_random_uuid(),
  place_id              text        not null references public.places(id)  on delete cascade,
  -- The RESOLVED existing account (never created here). Resolution is by the
  -- registered email below.
  invited_user_id       uuid        not null references public.users(id)   on delete cascade,
  -- Snapshot of the exact email the manager invited (audit + manager listing).
  invited_email         text        not null,
  -- The inviting manager: the account, and the Producer identity it derives.
  invited_by_user_id    uuid        not null references public.users(id)   on delete cascade,
  invited_by_producer_id text       not null references public.producers(id) on delete cascade,
  status                text        not null default 'pending'
                        check (status in ('pending','accepted','rejected','cancelled','expired','revoked')),
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  -- When the invitation left `pending`, or was revoked after acceptance.
  resolved_at           timestamptz null,
  check (invited_user_id <> invited_by_user_id),
  check (expires_at > created_at)
);

comment on table public.live_operator_invitations is
  'Live Operator invitation lifecycle for ONE Place. Owner/manager of the Place invites by registered email; the invitee accepts/rejects. Accepting creates the public.live_operators assignment; revoking it removes that access immediately. A Producer membership is NOT an invitation and never implies one.';

-- One PENDING invitation per (Place, user). Terminal rows are unconstrained so
-- a later re-invitation is a NEW record (task rule).
create unique index if not exists live_operator_invitations_pending_unique_idx
  on public.live_operator_invitations (place_id, invited_user_id)
  where status = 'pending';

create index if not exists live_operator_invitations_place_idx
  on public.live_operator_invitations (place_id, status, created_at desc);

create index if not exists live_operator_invitations_invitee_idx
  on public.live_operator_invitations (invited_user_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. At most ONE ACTIVE operator per Place (task rule)
-- ---------------------------------------------------------------------------
-- A revoked row (revoked_at not null) is history and does not count; an active
-- row does. The accept RPC revokes the previous active operator explicitly,
-- in the same transaction, so this index is the race-proof backstop.
create unique index if not exists live_operators_one_active_per_place_idx
  on public.live_operators (place_id)
  where revoked_at is null;

-- The SAME "max 1 active operator per Place" rule, enforced on the invitation
-- lifecycle itself: at most ONE `accepted` invitation per Place. The accept RPC
-- moves any previous accepted invitation to `revoked` earlier in the same
-- transaction, so this index is a hard backstop (a manual/buggy second accepted
-- row is impossible), independent of the assignment-table index above.
create unique index if not exists live_operator_invitations_active_unique_idx
  on public.live_operator_invitations (place_id)
  where status = 'accepted';

-- ---------------------------------------------------------------------------
-- 3. State machine + immutability — enforced in the DATABASE, not only in code
-- ---------------------------------------------------------------------------
create or replace function public.guard_live_operator_invitation_write()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending' then
      raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
    end if;
    if new.invited_user_id = new.invited_by_user_id then
      raise exception 'live_operator_invite_self_not_allowed' using errcode = 'P0001';
    end if;
    return new;
  end if;

  -- UPDATE: identity columns are frozen, and only the legal transitions below
  -- may change `status`. Every other transition is rejected.
  if new.place_id is distinct from old.place_id
     or new.invited_user_id is distinct from old.invited_user_id
     or new.invited_email is distinct from old.invited_email
     or new.invited_by_user_id is distinct from old.invited_by_user_id
     or new.invited_by_producer_id is distinct from old.invited_by_producer_id
     or new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at
  then
    raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'pending'
        and new.status in ('accepted','rejected','cancelled','expired'))
      or (old.status = 'accepted' and new.status = 'revoked')
    ) then
      raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
    end if;
    if new.resolved_at is null then
      new.resolved_at := now();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists live_operator_invitations_guard on public.live_operator_invitations;
create trigger live_operator_invitations_guard
before insert or update on public.live_operator_invitations
for each row execute procedure public.guard_live_operator_invitation_write();

revoke all on function public.guard_live_operator_invitation_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. RLS (fail closed; reads only, writes via the RPCs)
-- ---------------------------------------------------------------------------
alter table public.live_operator_invitations enable row level security;

-- Authenticated-only, SELECT-only. No grant to anon, RLS stays on, no wide
-- grant — the production regression (anon losing SELECT) is NOT reintroduced
-- and nothing is opened to anon.
revoke all on public.live_operator_invitations from public, anon, authenticated;
grant select on public.live_operator_invitations to authenticated;

-- The invitee may read its own invitations (pending and historical).
drop policy if exists live_operator_invitations_invitee_read on public.live_operator_invitations;
create policy live_operator_invitations_invitee_read
  on public.live_operator_invitations for select
  using (invited_user_id = auth.uid());

-- A Place's owner/manager may read that Place's invitations.
drop policy if exists live_operator_invitations_manager_read on public.live_operator_invitations;
create policy live_operator_invitations_manager_read
  on public.live_operator_invitations for select
  using (
    exists (
      select 1
      from public.producer_memberships m
      where m.user_id = auth.uid()
        and m.place_id = live_operator_invitations.place_id
        and m.role in ('owner', 'manager')
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Lazy expiry sweep (no scheduler exists — Policy Gap)
-- ---------------------------------------------------------------------------
create or replace function public.expire_live_operator_invitations(
  p_place_id text default null
) returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_count integer;
begin
  update public.live_operator_invitations
     set status = 'expired'
   where status = 'pending'
     and expires_at <= now()
     and (p_place_id is null or place_id = p_place_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Server-side only: reached from the list RPCs (definer) and, in the future,
-- from a scheduler through the service role.
revoke all on function public.expire_live_operator_invitations(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPCs — the ONLY write path
-- ---------------------------------------------------------------------------
-- All of these re-derive the caller's authority server-side. The inviter is
-- resolved from producer_memberships for the EXACT Place; the invitee identity
-- is the session (auth.uid()). No client ever supplies granted_by, the inviter
-- identity, or the invited user id.

-- 6.1 invite — resolve an EXISTING account by registered email and create ONE
--     pending invitation. Uniform response: a found email, an unknown email, a
--     duplicate pending invitation, and an already-active operator all return
--     success (no row vs. row is never disclosed). No account is created.
create or replace function public.invite_live_operator(
  p_place_id text,
  p_email    text
) returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor           uuid := auth.uid();
  v_producer_id     text;
  v_email           text;
  v_invited_user_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email = '' then
    raise exception 'email_required' using errcode = 'P0001';
  end if;
  -- Deliberately permissive shape check; the canonical match is the exact,
  -- case-insensitive comparison against the registered email below.
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email_invalid' using errcode = 'P0001';
  end if;

  select m.producer_id into v_producer_id
  from public.producer_memberships m
  where m.user_id = v_actor
    and m.place_id = p_place_id
    and m.role in ('owner', 'manager')
  limit 1;

  if v_producer_id is null then
    raise exception 'producer_authorization_required' using errcode = 'P0001';
  end if;

  select u.id into v_invited_user_id
  from auth.users u
  where u.email is not null
    and lower(u.email) = v_email
  limit 1;

  -- Unknown email → uniform no-op. The caller learns nothing.
  if v_invited_user_id is null then
    return;
  end if;

  if v_invited_user_id = v_actor then
    raise exception 'live_operator_invite_self_not_allowed' using errcode = 'P0001';
  end if;

  -- Already an active operator for this Place → nothing to invite.
  if exists (
    select 1
    from public.live_operators lo
    where lo.user_id = v_invited_user_id
      and lo.place_id = p_place_id
      and lo.revoked_at is null
  ) then
    return;
  end if;

  insert into public.live_operator_invitations (
    place_id, invited_user_id, invited_email,
    invited_by_user_id, invited_by_producer_id,
    status, expires_at
  ) values (
    p_place_id, v_invited_user_id, v_email,
    v_actor, v_producer_id,
    'pending', now() + make_interval(days => 7)
  )
  on conflict (place_id, invited_user_id) where status = 'pending' do nothing;
end;
$$;

revoke all on function public.invite_live_operator(text, text) from public, anon, authenticated;
grant execute on function public.invite_live_operator(text, text) to authenticated;

-- 6.2 accept — the INVITEE only. Grants the operator assignment and, if the
--     Place already had another active operator, revokes that one explicitly in
--     the same transaction (replacement), under a per-Place advisory lock.
create or replace function public.accept_live_operator_invitation(
  p_invitation_id uuid
) returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.live_operator_invitations;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  select * into v_row
  from public.live_operator_invitations
  where id = p_invitation_id
  for update;

  if not found then
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  if v_row.invited_user_id <> v_actor then
    -- Not the invitee: identical to "not found" (no existence leak).
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  if v_row.status = 'pending' and v_row.expires_at <= now() then
    update public.live_operator_invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'live_operator_invitation_expired' using errcode = 'P0001';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
  end if;

  -- Serialize concurrent accepts/replacements for the SAME Place.
  perform pg_advisory_xact_lock(hashtext('live_operator_place:' || v_row.place_id));

  -- Replacement: revoke the previous active operator (a DIFFERENT user) first,
  -- so max-one-active holds; the partial unique index is the backstop.
  update public.live_operators
     set revoked_at = now()
   where place_id = v_row.place_id
     and revoked_at is null
     and user_id <> v_row.invited_user_id;

  -- Keep the invitation history consistent: a previous accepted invitation for
  -- this Place is now revoked (fires its revocation notification).
  update public.live_operator_invitations
     set status = 'revoked'
   where place_id = v_row.place_id
     and status = 'accepted'
     and id <> p_invitation_id;

  insert into public.live_operators (user_id, place_id, granted_by, granted_at, revoked_at)
  values (v_row.invited_user_id, v_row.place_id, v_row.invited_by_producer_id, now(), null)
  on conflict (user_id, place_id) do update
    set revoked_at = null,
        granted_by = excluded.granted_by,
        granted_at = now();

  update public.live_operator_invitations
     set status = 'accepted'
   where id = p_invitation_id;
end;
$$;

revoke all on function public.accept_live_operator_invitation(uuid) from public, anon, authenticated;
grant execute on function public.accept_live_operator_invitation(uuid) to authenticated;

-- 6.3 reject — the INVITEE only.
create or replace function public.reject_live_operator_invitation(
  p_invitation_id uuid
) returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.live_operator_invitations;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  select * into v_row
  from public.live_operator_invitations
  where id = p_invitation_id
  for update;

  if not found or v_row.invited_user_id <> v_actor then
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  if v_row.status = 'pending' and v_row.expires_at <= now() then
    update public.live_operator_invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'live_operator_invitation_expired' using errcode = 'P0001';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
  end if;

  update public.live_operator_invitations
     set status = 'rejected'
   where id = p_invitation_id;
end;
$$;

revoke all on function public.reject_live_operator_invitation(uuid) from public, anon, authenticated;
grant execute on function public.reject_live_operator_invitation(uuid) to authenticated;

-- 6.4 cancel — a manager of the EXACT Place, PENDING invitations only.
create or replace function public.cancel_live_operator_invitation(
  p_invitation_id uuid
) returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_row     public.live_operator_invitations;
  v_allowed boolean;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  select * into v_row
  from public.live_operator_invitations
  where id = p_invitation_id
  for update;

  if not found then
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.producer_memberships m
    where m.user_id = v_actor
      and m.place_id = v_row.place_id
      and m.role in ('owner', 'manager')
  ) into v_allowed;

  if not v_allowed then
    -- A caller with no authority over the Place gets the same answer as a
    -- non-existent id (no cross-Place existence leak).
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  if v_row.status = 'pending' and v_row.expires_at <= now() then
    update public.live_operator_invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'live_operator_invitation_expired' using errcode = 'P0001';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
  end if;

  update public.live_operator_invitations
     set status = 'cancelled'
   where id = p_invitation_id;
end;
$$;

revoke all on function public.cancel_live_operator_invitation(uuid) from public, anon, authenticated;
grant execute on function public.cancel_live_operator_invitation(uuid) to authenticated;

-- 6.5 revoke — a manager of the EXACT Place, ACCEPTED invitations only. This is
--     the removal of a live operator's access; it takes effect immediately.
create or replace function public.revoke_live_operator_invitation(
  p_invitation_id uuid
) returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_row     public.live_operator_invitations;
  v_allowed boolean;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  select * into v_row
  from public.live_operator_invitations
  where id = p_invitation_id
  for update;

  if not found then
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.producer_memberships m
    where m.user_id = v_actor
      and m.place_id = v_row.place_id
      and m.role in ('owner', 'manager')
  ) into v_allowed;

  if not v_allowed then
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  if v_row.status <> 'accepted' then
    raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
  end if;

  -- Immediate: withdraw the operator's access for this EXACT Place.
  update public.live_operators
     set revoked_at = now()
   where user_id = v_row.invited_user_id
     and place_id = v_row.place_id
     and revoked_at is null;

  update public.live_operator_invitations
     set status = 'revoked'
   where id = p_invitation_id;
end;
$$;

revoke all on function public.revoke_live_operator_invitation(uuid) from public, anon, authenticated;
grant execute on function public.revoke_live_operator_invitation(uuid) to authenticated;

-- 6.6 list (manager) — every invitation of ONE Place the caller owner/manages.
create or replace function public.list_place_live_operator_invitations(
  p_place_id text
) returns table (
  id                    uuid,
  place_id              text,
  place_name            text,
  invited_user_id       uuid,
  invited_email         text,
  invited_by_user_id    uuid,
  invited_by_producer_id text,
  status                text,
  created_at            timestamptz,
  expires_at            timestamptz,
  resolved_at           timestamptz
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
    raise exception 'producer_authorization_required' using errcode = 'P0001';
  end if;

  perform public.expire_live_operator_invitations(p_place_id);

  return query
    select i.id, i.place_id, p.name as place_name, i.invited_user_id,
           i.invited_email, i.invited_by_user_id, i.invited_by_producer_id,
           i.status, i.created_at, i.expires_at, i.resolved_at
    from public.live_operator_invitations i
    join public.places p on p.id = i.place_id
    where i.place_id = p_place_id
    order by i.created_at desc;
end;
$$;

revoke all on function public.list_place_live_operator_invitations(text) from public, anon, authenticated;
grant execute on function public.list_place_live_operator_invitations(text) to authenticated;

-- 6.7 list (invitee) — the caller's own invitations, with the Place name and the
--     inviting manager's Producer display name (the values the notification and
--     the inbox surface read).
create or replace function public.list_my_live_operator_invitations()
returns table (
  id                    uuid,
  place_id              text,
  place_name            text,
  invited_email         text,
  invited_by_producer_id text,
  invited_by_name       text,
  status                text,
  created_at            timestamptz,
  expires_at            timestamptz,
  resolved_at           timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  perform public.expire_live_operator_invitations(null);

  return query
    select i.id, i.place_id, p.name as place_name, i.invited_email,
           i.invited_by_producer_id, pr.display_name as invited_by_name,
           i.status, i.created_at, i.expires_at, i.resolved_at
    from public.live_operator_invitations i
    join public.places p on p.id = i.place_id
    left join public.producers pr on pr.id = i.invited_by_producer_id
    where i.invited_user_id = auth.uid()
    order by i.created_at desc;
end;
$$;

revoke all on function public.list_my_live_operator_invitations() from public, anon, authenticated;
grant execute on function public.list_my_live_operator_invitations() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Notifications — reuse the EXISTING infrastructure (0025/0026/0029)
-- ---------------------------------------------------------------------------
-- No new category, no new delivery channel. Writes go through the existing
-- server-side `notify_recipient` writer, so the preference gate, the dedup key
-- and the realtime unread signal all apply unchanged. A notification failure
-- never rolls back the invitation change (MASTER 10 §17).
create or replace function public.notify_live_operator_invitation_event()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_place_name   text;
  v_manager_name text;
  v_event        text;
  v_title        text;
  v_body         text;
  v_recipient    uuid;
  v_category     text;
begin
  select p.name into v_place_name
  from public.places p where p.id = new.place_id;

  select pr.display_name into v_manager_name
  from public.producers pr where pr.id = new.invited_by_producer_id;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending' then
      return null;
    end if;
    v_event := 'live_operator_invitation_pending';
    v_recipient := new.invited_user_id;
    v_category := 'safety_account';
    v_title := 'Undangan Operator Live';
    v_body := 'Kamu diundang menjadi Operator Live di '
      || coalesce(v_place_name, new.place_id)
      || ' oleh ' || coalesce(v_manager_name, 'pengelola Tempat') || '.';
  elsif old.status is distinct from new.status then
    case new.status
      when 'accepted' then
        v_event := 'live_operator_invitation_accepted';
        v_recipient := new.invited_by_user_id;
        v_category := 'system';
        v_title := 'Undangan Operator Live diterima';
        v_body := 'Undangan Operator Live untuk '
          || coalesce(v_place_name, new.place_id) || ' diterima.';
      when 'rejected' then
        v_event := 'live_operator_invitation_rejected';
        v_recipient := new.invited_by_user_id;
        v_category := 'system';
        v_title := 'Undangan Operator Live ditolak';
        v_body := 'Undangan Operator Live untuk '
          || coalesce(v_place_name, new.place_id) || ' ditolak.';
      when 'cancelled' then
        v_event := 'live_operator_invitation_cancelled';
        v_recipient := new.invited_user_id;
        v_category := 'safety_account';
        v_title := 'Undangan Operator Live dibatalkan';
        v_body := 'Undangan menjadi Operator Live di '
          || coalesce(v_place_name, new.place_id)
          || ' dibatalkan oleh pengelola.';
      when 'revoked' then
        v_event := 'live_operator_invitation_revoked';
        v_recipient := new.invited_user_id;
        v_category := 'safety_account';
        v_title := 'Akses Operator Live dicabut';
        v_body := 'Akses Operator Live kamu di '
          || coalesce(v_place_name, new.place_id) || ' dicabut.';
      when 'expired' then
        v_event := 'live_operator_invitation_expired';
        v_recipient := new.invited_user_id;
        v_category := 'safety_account';
        v_title := 'Undangan Operator Live kedaluwarsa';
        v_body := 'Undangan Operator Live di '
          || coalesce(v_place_name, new.place_id) || ' kedaluwarsa.';
      else
        return null;
    end case;
  else
    return null;
  end if;

  begin
    perform public.notify_recipient(
      v_recipient,
      v_category,
      v_event,
      v_title,
      v_body,
      new.place_id,
      'live_operator_invitation',
      new.id::text,
      jsonb_build_object(
        'invitation_id', new.id,
        'place_id', new.place_id,
        'status', new.status,
        'invited_by_producer_id', new.invited_by_producer_id
      )
    );
  exception when others then
    raise warning 'live_operator_invitation_notification_failed: %', sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists live_operator_invitations_notify on public.live_operator_invitations;
create trigger live_operator_invitations_notify
after insert or update on public.live_operator_invitations
for each row execute procedure public.notify_live_operator_invitation_event();

revoke all on function public.notify_live_operator_invitation_event() from public, anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 8. DEV apply notes
-- ---------------------------------------------------------------------------
-- Apply to the Supabase DEVELOPMENT project only. Before applying, confirm the
-- max-one-active index cannot be blocked by existing data:
--
--   select place_id, count(*) from public.live_operators
--    where revoked_at is null group by place_id having count(*) > 1;
--
-- If any row returns, a Place already has more than one ACTIVE operator; revoke
-- the extras deliberately (public.revoke_live_operator_access) BEFORE applying —
-- this migration does not silently mutate existing assignment data.
--
-- If migration 0046 was not applied in DEV (it is out of scope here), the
-- ai-media quota tables it touches are unrelated to this feature; note the gap
-- in the PR report and do not re-run 0046.
