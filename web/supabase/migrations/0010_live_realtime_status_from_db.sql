-- 0010: Broadcast Live end status from the canonical DB end path.
-- Realtime is display-only; live_sessions remains the source of truth.

create or replace function public.end_live_session(
  p_session_id text,
  p_reason text default 'producer_ended',
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  select * into v_session
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found or v_session.status <> 'live' then
    return false;
  end if;

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
      where id = v_session.stage_id
        and place_id = v_session.place_id
        and status = 'published'
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
  values (
    p_session_id,
    auth.uid(),
    'session_ended',
    jsonb_build_object('reason', p_reason)
  );

  -- Display signal only. Canonical state remains live_sessions.
  perform realtime.send(
    jsonb_build_object(
      'event', 'status',
      'sessionId', p_session_id,
      'status', 'ended',
      'endedReason', p_reason
    ),
    'status',
    'live_session:' || p_session_id,
    true
  );

  return true;
end;
$$;
