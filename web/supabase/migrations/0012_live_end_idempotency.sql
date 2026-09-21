-- 0012: Add explicit idempotency to every Live end operation.

drop function if exists public.end_live_session(text,text,text);

create function public.end_live_session(
  p_session_id text,
  p_idempotency_key text,
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
  v_previous_key text;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'live_end_idempotency_key_required';
  end if;

  select * into v_session
  from public.live_sessions
  where id = p_session_id
  for update;

  if not found then
    return false;
  end if;

  if v_session.status <> 'live' then
    select detail->>'end_idempotency_key'
      into v_previous_key
    from public.live_audit
    where live_session_id = p_session_id
      and action = 'session_ended'
      and detail->>'end_idempotency_key' = p_idempotency_key
    order by created_at desc
    limit 1;

    return v_previous_key = p_idempotency_key;
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
      where id = auth.uid()
        and platform_role = 'platform_moderator'
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
    jsonb_build_object(
      'reason', p_reason,
      'end_idempotency_key', p_idempotency_key
    )
  );

  begin
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
  exception when others then
    null;
  end;

  return true;
end;
$$;

revoke execute on function public.end_live_session(text,text,text,text)
from public, anon;

grant execute on function public.end_live_session(text,text,text,text)
to authenticated;

create or replace function public.apply_live_duration_cap(p_session_id text)
returns boolean
language plpgsql
security definer
set search_path = public
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
    perform public.end_live_session(
      p_session_id,
      'duration-cap:' || p_session_id,
      'duration_cap',
      '60-minute cap applied'
    );
  end if;

  return coalesce(v_expired, false);
end;
$$;

create or replace function public.heal_live_duration_caps()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expired_id text;
begin
  for v_expired_id in
    select id
    from public.live_sessions
    where status = 'live'
      and started_at + interval '60 minutes' <= now()
    limit 10
  loop
    perform public.end_live_session(
      v_expired_id,
      'duration-cap:' || v_expired_id,
      'duration_cap',
      '60-minute cap applied'
    );
  end loop;
end;
$$;

create or replace function public.live_stage_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live_id text;
begin
  if old.status = 'published'
     and new.status in ('paused', 'archived') then

    for v_live_id in
      select id
      from public.live_sessions
      where stage_id = new.id
        and place_id = new.place_id
        and status = 'live'
    loop
      perform public.end_live_session(
        v_live_id,
        'stage-unpublish:' || v_live_id,
        'source_stage_unpublished',
        'Process left published state'
      );
    end loop;
  end if;

  return coalesce(new, old);
end;
$$;

create or replace function public.moderate_live(
  p_session_id text,
  p_action text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
  v_audit_action text;
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid()
      and platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_moderator_required' using errcode = '42501';
  end if;

  select * into v_session
  from public.live_sessions
  where id = p_session_id;

  if not found then
    raise exception 'live_session_not_found';
  end if;

  if p_action not in (
    'warn','end','suspend',
    'flag_review','resolve_review','block_content'
  ) then
    raise exception 'live_moderation_action_invalid' using errcode = 'P0001';
  end if;

  if p_action = 'warn' then
    v_audit_action := 'moderation_warn';

  elsif p_action = 'end' then
    v_audit_action := 'moderation_end';
    perform public.end_live_session(
      p_session_id,
      'moderation:' || p_session_id || ':end',
      'moderation',
      p_note
    );

  elsif p_action = 'suspend' then
    v_audit_action := 'moderation_suspend';
    perform public.end_live_session(
      p_session_id,
      'moderation:' || p_session_id || ':suspend',
      'moderation',
      p_note
    );

    update public.live_eligibility
    set active = false
    where producer_id = v_session.producer_id;

  elsif p_action = 'flag_review' then
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

    perform public.end_live_session(
      p_session_id,
      'moderation:' || p_session_id || ':block_content',
      'moderation',
      p_note
    );
  end if;

  insert into public.live_audit (
    live_session_id,
    actor_id,
    action,
    detail
  )
  values (
    p_session_id,
    auth.uid(),
    v_audit_action,
    jsonb_build_object('note', p_note)
  );
end;
$$;
