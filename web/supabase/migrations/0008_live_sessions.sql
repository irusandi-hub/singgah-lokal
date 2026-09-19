-- 0008: Live Phase 2 (MASTER_LIVE_POLICY_v1.0 + MASTER_LIVE_TECH_v1.0)
-- Fail-closed: all Live writes go through security-definer RPCs; direct DML revoked.
-- Locked limits: global 5 live, 1 per Place, 100 concurrent viewers, 60-minute cap.
-- Recording OFF / monetization OFF: no provider artifacts persisted in this schema;
-- only opaque Cloudflare live_input_id references.

-- ---------------------------------------------------------------------------
-- B2: Platform Admin/Moderator identity (policy §12.2 #3)
-- ---------------------------------------------------------------------------
alter table public.users
  add column if not exists platform_role text;

do $$ begin
  alter table public.users
    add constraint platform_role_check check (platform_role in ('platform_moderator'));
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- B4 boundary note: Cloudflare credentials never live in this repository.
-- start_live_session accepts p_live_input_id created server-side by
-- lib/live/cloudflare.ts; without credentials the boundary refuses to mint
-- inputs and start fails closed.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.live_eligibility (
  producer_id text not null references public.producers(id) on delete cascade,
  path text not null check (path in ('RATING', 'CURATED', 'EXCLUSIVE', 'HISTORY', 'ADMIN_APPROVED')),
  active boolean not null default true,
  rating_threshold numeric null,
  min_rating_count integer null,
  granted_by text null,
  granted_at timestamptz not null default now(),
  primary key (producer_id, path)
);

create table if not exists public.live_sessions (
  id text primary key default 'live_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
  place_id text not null references public.places(id) on delete cascade,
  producer_id text not null references public.producers(id) on delete cascade,
  stage_id text not null,
  status text not null default 'live'
    constraint live_sessions_status_check check (status in ('scheduled', 'live', 'ended')),
  live_input_id text null,
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  ended_reason text null
    constraint live_sessions_ended_reason_check
      check (ended_reason in ('producer_ended', 'duration_cap', 'source_stage_unpublished', 'moderation')),
  end_note text null,
  idempotency_key text not null unique constraint live_sessions_idempotency_key_not_blank check (length(btrim(idempotency_key)) > 0),
  viewer_peak integer not null default 0 constraint live_sessions_viewer_peak_check check (viewer_peak between 0 and 100),
  -- PO item 4 (tech §5): platform content gate. Set only via the moderation
  -- path; client input can never write it. 'review' suspends new admissions;
  -- 'blocked' ends the Live (fail closed).
  content_status text not null default 'ok'
    constraint live_sessions_content_status_check check (content_status in ('ok', 'review', 'blocked'))
);

-- Per-Place cap = 1 active session (policy §6)
create unique index if not exists live_sessions_one_active_per_place
  on public.live_sessions (place_id)
  where status <> 'ended';

-- Composite FK: the Process must belong to the broadcasting Place (audit M7)
alter table public.production_stages
  drop constraint if exists production_stages_id_place_id_key;
do $$ begin
  alter table public.production_stages
    add constraint production_stages_id_place_id_key unique (id, place_id);
exception
  when duplicate_object then null;
end $$;

do $$ begin
  alter table public.live_sessions
    add constraint live_sessions_stage_place_fkey
      foreign key (stage_id, place_id) references public.production_stages (id, place_id)
      on delete cascade;
exception
  when duplicate_object then null;
end $$;

create table if not exists public.live_viewers (
  live_session_id text not null references public.live_sessions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  admitted_at timestamptz not null default now(),
  primary key (live_session_id, user_id)
);

create table if not exists public.live_reports (
  id uuid primary key default gen_random_uuid(),
  live_session_id text not null references public.live_sessions(id) on delete cascade,
  reporter_id uuid not null references public.users(id) on delete cascade,
  category text not null check (category in (
    'sexual_content', 'graphic_violence', 'illegal_activity', 'prohibited_product',
    'smoking', 'unsafe_activity', 'minor_as_subject', 'private_data', 'other'
  )),
  note text null constraint live_reports_note_length_check check (length(note) <= 500),
  comment_ref text null,
  created_at timestamptz not null default now(),
  unique (live_session_id, reporter_id, category)
);

create table if not exists public.live_audit (
  id bigserial primary key,
  live_session_id text null references public.live_sessions(id) on delete set null,
  actor_id uuid null references public.users(id) on delete set null,
  action text not null check (action in (
    'session_started', 'session_ended', 'report_submitted', 'moderation_warn',
    'moderation_end', 'moderation_suspend', 'eligibility_granted',
    'eligibility_revoked', 'admission_denied', 'camera_check_passed', 'comment_removed',
    'moderation_flag_review', 'moderation_resolve_review', 'moderation_block_content'
  )),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Append-only audit (tech §1.5)
create or replace function public.block_live_audit_mutation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  raise exception 'live_audit is append-only';
end;
$$;

drop trigger if exists live_audit_block_mutation on public.live_audit;
create trigger live_audit_block_mutation
  before update or delete on public.live_audit
  for each row execute procedure public.block_live_audit_mutation();

-- ---------------------------------------------------------------------------
-- RLS + direct-DML revocation (fail closed; all writes via RPCs)
-- ---------------------------------------------------------------------------
alter table public.live_eligibility enable row level security;
alter table public.live_sessions enable row level security;
alter table public.live_viewers enable row level security;
alter table public.live_reports enable row level security;
alter table public.live_audit enable row level security;

revoke all on public.live_eligibility from authenticated;
revoke all on public.live_sessions from authenticated;
revoke all on public.live_viewers from authenticated;
revoke all on public.live_reports from authenticated;
revoke all on public.live_audit from authenticated;

create policy live_sessions_public_read on public.live_sessions for select using (
  status = 'live' and exists (
    select 1 from public.places p
    where p.id = live_sessions.place_id and p.publication_status = 'published'
  )
);

create policy live_sessions_producer_read on public.live_sessions for select using (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = live_sessions.place_id
      and m.role in ('owner', 'manager', 'editor')
  )
);

create policy live_viewers_own_read on public.live_viewers for select using (
  user_id = auth.uid()
);

create policy live_reports_reporter_read on public.live_reports for select using (
  reporter_id = auth.uid()
);

create policy live_reports_producer_read on public.live_reports for select using (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = (select place_id from public.live_sessions s where s.id = live_reports.live_session_id)
      and m.role in ('owner', 'manager')
  )
);

create policy live_eligibility_producer_read on public.live_eligibility for select using (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.producer_id = live_eligibility.producer_id
  )
);

-- live_audit: no authenticated SELECT policy (server/RPC only).

-- ---------------------------------------------------------------------------
-- RPCs (security definer, search_path fixed)
-- ---------------------------------------------------------------------------

-- Fail-closed viewer gate (tech §4.1). B1 blocked: no age mechanism yet ->
-- every viewer is denied (PO decision 2026-09-18).
-- Fail-closed privilege baseline: RPCs are executable only by authenticated
-- server callers; in-function authorization checks remain the second layer.

create or replace function public.assert_viewer_eligible(p_session_id text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_session public.live_sessions%rowtype;
begin
  -- B5: opportunistic duration-cap self-heal before any gate decision.
  perform public.apply_live_duration_cap(p_session_id);

  select * into v_session from public.live_sessions where id = p_session_id;
  if not found or v_session.status <> 'live' then
    raise exception 'live_session_not_live' using errcode = 'P0001';
  end if;

  -- PO item 4: content gate — a session under moderation review or blocked
  -- suspends ALL new participation (fail closed).
  if v_session.content_status <> 'ok' then
    raise exception 'live_content_blocked' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from auth.users
    where id = auth.uid() and email_confirmed_at is null
  ) or auth.uid() is null then
    raise exception 'live_viewer_denied' using errcode = 'P0001';
  end if;

  -- B1 (blocked): verified-age mechanism is Phase 2.1; until then deny all.
  raise exception 'live_viewer_denied' using errcode = 'P0001';
end;
$$;

create or replace function public.admit_live_viewer(p_session_id text, p_idempotency_key text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_concurrent integer;
begin
  perform public.assert_viewer_eligible(p_session_id);

  -- Concurrent capacity (PO 2026-09-18: "100 viewers" = concurrent).
  -- Phase 2 concurrent proxy: admissions within the presence grace window
  -- (TUNABLE, default 5 minutes). live_viewers ledger rows are historical
  -- metadata; only this window is counted toward the cap.
  select count(*) into v_concurrent
  from public.live_viewers
  where live_session_id = p_session_id
    and admitted_at > now() - interval '5 minutes';

  if v_concurrent >= 100 then
    insert into public.live_audit (live_session_id, actor_id, action, detail)
    values (p_session_id, auth.uid(), 'admission_denied', jsonb_build_object('reason', 'capacity_full'));
    raise exception 'live_capacity_full' using errcode = 'P0001';
  end if;

  insert into public.live_viewers (live_session_id, user_id)
  values (p_session_id, auth.uid())
  on conflict (live_session_id, user_id) do update
    set admitted_at = now();

  -- MR2: persist viewer peak (policy §12.1 item 7 retention). Bounded by the
  -- concurrent proxy above; hard-bounded by the viewer_peak <= 100 check.
  update public.live_sessions
  set viewer_peak = greatest(viewer_peak, v_concurrent + 1)
  where id = p_session_id;

  return true;
end;
$$;

create or replace function public.post_live_comment(p_session_id text, p_body text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.assert_viewer_eligible(p_session_id);

  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 300 then
    raise exception 'live_comment_too_long' using errcode = 'P0001';
  end if;

  -- Comments are ephemeral (no live_comments table). Per-viewer rate limiting
  -- (~1/5s, TUNABLE) is enforced in the server route layer (tech §6 TUNABLE
  -- mechanism), not persisted in the database.
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.submit_live_report(
  p_session_id text,
  p_category text,
  p_note text,
  p_comment_ref text default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_session public.live_sessions%rowtype;
  v_report_id uuid;
begin
  select * into v_session from public.live_sessions where id = p_session_id;
  if not found then
    raise exception 'live_session_not_found';
  end if;

  if exists (
    select 1 from auth.users
    where id = auth.uid() and email_confirmed_at is null
  ) or auth.uid() is null then
    raise exception 'live_viewer_denied' using errcode = 'P0001';
  end if;

  if p_note is not null and length(p_note) > 500 then
    raise exception 'live_report_note_too_long' using errcode = 'P0001';
  end if;

  -- CR1 (fail-closed): reports use the same gate as all Live participation.
  -- Unverified Live eligibility (age mechanism pending, Phase 2.1) => DENY.
  perform public.assert_viewer_eligible(p_session_id);

  insert into public.live_reports (live_session_id, reporter_id, category, note, comment_ref)
  values (p_session_id, auth.uid(), p_category, p_note, p_comment_ref)
  on conflict (live_session_id, reporter_id, category) do nothing
  returning id into v_report_id;

  insert into public.live_audit (live_session_id, actor_id, action, detail)
  values (p_session_id, auth.uid(), 'report_submitted', jsonb_build_object('category', p_category));

  return v_report_id;
end;
$$;

create or replace function public.grant_live_eligibility(
  p_producer_id text,
  p_path text,
  p_rating_threshold numeric default null,
  p_min_rating_count integer default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_moderator_required' using errcode = '42501';
  end if;

  insert into public.live_eligibility
    (producer_id, path, active, rating_threshold, min_rating_count, granted_by)
  values
    (p_producer_id, p_path, true, p_rating_threshold, p_min_rating_count, auth.uid()::text)
  on conflict (producer_id, path) do update
    set active = true,
        rating_threshold = excluded.rating_threshold,
        min_rating_count = excluded.min_rating_count,
        granted_by = excluded.granted_by,
        granted_at = now();

  insert into public.live_audit (actor_id, action, detail)
  values (auth.uid(), 'eligibility_granted', jsonb_build_object('producer_id', p_producer_id, 'path', p_path));
end;
$$;

-- B2: revoke an eligibility path (completes the eligibility_revoked audit action).
-- Platform Admin/Moderator only, audited, fail-closed.
create or replace function public.revoke_live_eligibility(
  p_producer_id text,
  p_path text
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_moderator_required' using errcode = '42501';
  end if;

  update public.live_eligibility
  set active = false
  where producer_id = p_producer_id and path = p_path;

  if not found then
    raise exception 'live_eligibility_not_found' using errcode = 'P0001';
  end if;

  insert into public.live_audit (actor_id, action, detail)
  values (auth.uid(), 'eligibility_revoked', jsonb_build_object('producer_id', p_producer_id, 'path', p_path));
end;
$$;

-- Start: idempotent, race-safe, fail-closed (tech §4.2)
create or replace function public.start_live_session(
  p_place_id text,
  p_stage_id text,
  p_idempotency_key text,
  p_live_input_id text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_membership text;
  v_stage_status text;
  v_active_count integer;
  v_global_count integer;
  v_session_id text;
  v_replay text;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'live_idempotency_key_required';
  end if;

  -- B5: self-heal expired sessions first so global-cap counts stay honest.
  perform public.heal_live_duration_caps();

  -- Replay: return the original session without side effects
  select id into v_replay
  from public.live_sessions
  where idempotency_key = p_idempotency_key
    and place_id = p_place_id
  limit 1;
  if v_replay is not null then
    return jsonb_build_object('sessionId', v_replay, 'replayed', true);
  end if;

  if not exists (
    select 1 from public.producer_memberships
    where user_id = auth.uid() and place_id = p_place_id and role in ('owner', 'manager')
  ) then
    raise exception 'producer_authorization_required' using errcode = '42501';
  end if;

  select producer_id into v_membership
  from public.producer_memberships
  where user_id = auth.uid() and place_id = p_place_id and role in ('owner', 'manager')
  limit 1;

  if not exists (
    select 1 from public.live_eligibility
    where producer_id = v_membership and active
  ) then
    raise exception 'live_not_eligible' using errcode = 'P0001';
  end if;

  select status into v_stage_status
  from public.production_stages
  where id = p_stage_id and place_id = p_place_id;
  if v_stage_status is null or v_stage_status <> 'published' then
    raise exception 'live_stage_not_published' using errcode = 'P0001';
  end if;

  -- Global cap of 5 concurrent lives: race-safe via advisory lock (audit B3)
  if not pg_try_advisory_xact_lock(hashtext('live_global_start_lock')) then
    raise exception 'live_start_busy' using errcode = 'P0001';
  end if;

  select count(*) into v_global_count
  from public.live_sessions
  where status = 'live';
  if v_global_count >= 5 then
    raise exception 'live_cap_denied' using errcode = 'P0001';
  end if;

  -- MR1: explicit per-Place cap (1 active session, policy §6). The partial
  -- unique index remains the race-proof backstop (dual enforcement, tech §7).
  if exists (
    select 1 from public.live_sessions
    where place_id = p_place_id and status <> 'ended'
  ) then
    raise exception 'live_place_busy' using errcode = 'P0001';
  end if;

  begin
    insert into public.live_sessions
      (place_id, producer_id, stage_id, status, live_input_id, idempotency_key)
    values
      (p_place_id, v_membership, p_stage_id, 'live', p_live_input_id, p_idempotency_key)
    on conflict (idempotency_key) do nothing
    returning id into v_session_id;
  exception
    -- Race-proof backstop: concurrent second active session for this Place
    when unique_violation then
      raise exception 'live_place_busy' using errcode = 'P0001';
  end;

  if v_session_id is null then
    -- Concurrent replay of the same key
    select id into v_session_id from public.live_sessions where idempotency_key = p_idempotency_key limit 1;
    return jsonb_build_object('sessionId', v_session_id, 'replayed', true);
  end if;

  insert into public.live_audit (live_session_id, actor_id, action, detail)
  values (v_session_id, auth.uid(), 'session_started',
    jsonb_build_object('stage_id', p_stage_id, 'live_input_id', p_live_input_id));

  return jsonb_build_object('sessionId', v_session_id, 'replayed', false);
end;
$$;

-- End: idempotent, records locked end reasons (tech §4.3)
create or replace function public.end_live_session(
  p_session_id text,
  p_reason text default 'producer_ended',
  p_note text default null
)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
begin
  select * into v_session
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found or v_session.status <> 'live' then
    return false; -- idempotent no-op
  end if;

  -- CR2 (fail-closed): every end reason is verified against current state,
  -- so a client cannot end an arbitrary session by choosing a reason.
  if p_reason = 'producer_ended' then
    if not exists (
      select 1 from public.producer_memberships
      where user_id = auth.uid()
        and place_id = v_session.place_id
        and role in ('owner', 'manager')
    ) then
      raise exception 'producer_authorization_required' using errcode = '42501';
    end if;
  elsif p_reason = 'moderation' then
    if not exists (
      select 1 from public.users
      where id = auth.uid() and platform_role = 'platform_moderator'
    ) then
      raise exception 'platform_moderator_required' using errcode = '42501';
    end if;
  elsif p_reason = 'duration_cap' then
    if not (v_session.started_at + interval '60 minutes' <= now()) then
      raise exception 'live_duration_cap_not_due' using errcode = 'P0001';
    end if;
  elsif p_reason = 'source_stage_unpublished' then
    if exists (
      select 1 from public.production_stages
      where id = v_session.stage_id and place_id = v_session.place_id and status = 'published'
    ) then
      raise exception 'live_stage_still_published' using errcode = 'P0001';
    end if;
  else
    raise exception 'live_end_reason_invalid' using errcode = 'P0001';
  end if;

  update public.live_sessions
  set status = 'ended',
      ended_at = now(),
      ended_reason = p_reason,
      end_note = p_note
  where id = p_session_id;

  insert into public.live_audit (live_session_id, actor_id, action, detail)
  values (p_session_id, auth.uid(), 'session_ended',
    jsonb_build_object('reason', p_reason));

  return true;
end;
$$;

-- 60-minute self-healing cap (tech §7)
-- Called by the server status route (authenticated) and by start/end flows;
-- the RPC itself re-verifies the cap via end_live_session (CR2).
create or replace function public.apply_live_duration_cap(p_session_id text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_expired boolean;
begin
  select exists (
    select 1 from public.live_sessions
    where id = p_session_id
      and status = 'live'
      and started_at + interval '60 minutes' <= now()
  ) into v_expired;

  if v_expired then
    perform public.end_live_session(p_session_id, 'duration_cap', '60-minute cap applied');
  end if;

  return coalesce(v_expired, false);
end;
$$;

-- Stage guard: auto-end when the Process leaves published (policy §12.1 item 4)
create or replace function public.live_stage_guard()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_live_id text;
begin
  if old.status = 'published' and new.status in ('paused', 'archived') then
    for v_live_id in
      select id from public.live_sessions
      where stage_id = new.id and place_id = new.place_id and status = 'live'
    loop
      perform public.end_live_session(v_live_id, 'source_stage_unpublished', 'Process left published state');
    end loop;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists live_stage_guard_trigger on public.production_stages;
create trigger live_stage_guard_trigger
  after update on public.production_stages
  for each row execute procedure public.live_stage_guard();

-- Moderate: Platform Admin/Moderator only (policy §12.2 #3)
create or replace function public.moderate_live(
  p_session_id text,
  p_action text,
  p_note text default null
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_session record;
  v_audit_action text;
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_moderator_required' using errcode = '42501';
  end if;

  select * into v_session from public.live_sessions where id = p_session_id;
  if not found then
    raise exception 'live_session_not_found';
  end if;

  if p_action not in ('warn', 'end', 'suspend', 'flag_review', 'resolve_review', 'block_content') then
    raise exception 'live_moderation_action_invalid' using errcode = 'P0001';
  end if;

  if p_action = 'warn' then
    v_audit_action := 'moderation_warn';
  elsif p_action = 'end' then
    v_audit_action := 'moderation_end';
    perform public.end_live_session(p_session_id, 'moderation', p_note);
  elsif p_action = 'suspend' then
    v_audit_action := 'moderation_suspend';
    perform public.end_live_session(p_session_id, 'moderation', p_note);
    update public.live_eligibility
    set active = false
    where producer_id = v_session.producer_id;
  elsif p_action = 'flag_review' then
    -- PO item 4: suspend new admissions while content is under review.
    v_audit_action := 'moderation_flag_review';
    update public.live_sessions
    set content_status = 'review'
    where id = p_session_id;
  elsif p_action = 'resolve_review' then
    v_audit_action := 'moderation_resolve_review';
    update public.live_sessions
    set content_status = 'ok'
    where id = p_session_id;
  elsif p_action = 'block_content' then
    v_audit_action := 'moderation_block_content';
    update public.live_sessions
    set content_status = 'blocked'
    where id = p_session_id;
    perform public.end_live_session(p_session_id, 'moderation', p_note);
  end if;

  insert into public.live_audit (live_session_id, actor_id, action, detail)
  values (p_session_id, auth.uid(), v_audit_action, jsonb_build_object('note', p_note));
end;
$$;

-- Grant eligibility: Platform Admin/Moderator only (dev-seed never in prod)

-- Realtime: status/comments payloads only; never video (policy §8)
alter publication supabase_realtime add table public.live_sessions;
alter publication supabase_realtime add table public.live_reports;

-- ---------------------------------------------------------------------------
-- CR3: RPC privilege hardening — functions default to EXECUTE for public.
-- Restrict to authenticated server callers; in-function authorization checks
-- remain the second layer (fail closed).
-- ---------------------------------------------------------------------------
revoke execute on function public.assert_viewer_eligible(text) from public, anon;
revoke execute on function public.admit_live_viewer(text, text) from public, anon;
revoke execute on function public.post_live_comment(text, text) from public, anon;
revoke execute on function public.submit_live_report(text, text, text, text) from public, anon;
revoke execute on function public.grant_live_eligibility(text, text, numeric, integer) from public, anon;
revoke execute on function public.revoke_live_eligibility(text, text) from public, anon;
revoke execute on function public.start_live_session(text, text, text, text) from public, anon;
revoke execute on function public.end_live_session(text, text, text) from public, anon;
revoke execute on function public.apply_live_duration_cap(text) from public, anon;
revoke execute on function public.moderate_live(text, text, text) from public, anon;

grant execute on function public.assert_viewer_eligible(text) to authenticated;
grant execute on function public.admit_live_viewer(text, text) to authenticated;
grant execute on function public.post_live_comment(text, text) to authenticated;
grant execute on function public.submit_live_report(text, text, text, text) to authenticated;
grant execute on function public.start_live_session(text, text, text, text) to authenticated;
grant execute on function public.end_live_session(text, text, text) to authenticated;
grant execute on function public.apply_live_duration_cap(text) to authenticated;

-- PO item 11: moderation capability is Platform Moderator only. The execute
-- grant is issued to authenticated as the transport layer (the server route
-- runs as the moderator's own auth context); the in-function platform-role
-- check remains the authorization layer (fail closed, M42501 otherwise).
grant execute on function public.moderate_live(text, text, text) to authenticated;
grant execute on function public.grant_live_eligibility(text, text, numeric, integer) to authenticated;
grant execute on function public.revoke_live_eligibility(text, text) to authenticated;

-- B5: opportunistic self-heal — every RPC that observes a live session first
-- applies the 60-minute duration cap (fail-closed, no scheduler invented).
-- Applied inside start_live_session, assert_viewer_eligible,
-- submit_live_report, and admit_live_viewer via the helper below.
create or replace function public.heal_live_duration_caps()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_expired_id text;
begin
  for v_expired_id in
    select id from public.live_sessions
    where status = 'live'
      and started_at + interval '60 minutes' <= now()
    limit 10
  loop
    perform public.end_live_session(v_expired_id, 'duration_cap', '60-minute cap applied');
  end loop;
end;
$$;

revoke execute on function public.heal_live_duration_caps() from public, anon;
grant execute on function public.heal_live_duration_caps() to authenticated;
