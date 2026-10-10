-- 0049_live_operator_authority.sql
-- DELEGATED OPERATOR LIVE AUTHORITY — start/end accept an ACTIVE operator.
--
-- GAP this migration closes: 0047 added the delegated Operator Live assignment
-- (public.live_operators) and 0048 added the invitation lifecycle that creates
-- it, but the two Live CORE RPCs still authorized ONLY a producer_memberships
-- owner/manager:
--
--   start_live_session  (0008)  ->  producer_authorization_required for anyone else
--   end_live_session    (0012)  ->  producer_authorization_required for 'producer_ended'
--
-- So the routes authorized a delegated operator (lib/live/operator-authorization
-- .ts `canOperateLiveForPlace`) and the RPC then refused the same call. This
-- migration makes the RPC the authority, so the two layers can never disagree.
--
-- It is FORWARD-ONLY and it changes ONE thing in each RPC: the authorization
-- predicate. The producing Producer is still derived server-side, never taken
-- from input. Nothing else about either function changes — idempotency, the
-- eligibility gate, the published-stage gate, the global (5) and per-Place (1)
-- caps, the 60-minute cap, the end reasons, and the realtime end signal are all
-- byte-for-byte the 0008 / 0012 behaviour.
--
-- It does NOT:
--   * weaken or remove the existing owner/manager path (it is a strict superset:
--     owner/manager OR an ACTIVE delegated assignment);
--   * change 0008 or 0012 (both files are untouched — this migration replaces
--     the two function bodies);
--   * change migration 0046, any Live policy, or any other table;
--   * grant anything to anon, or make the predicate client-callable.
--
-- "An operator with an accepted, still-active invitation" resolves to exactly
-- the ACTIVE public.live_operators row: 0048's accept creates that row together
-- with the `accepted` invitation, and 0048's revoke clears that row together
-- with the invitation in the same transaction. `revoked_at is null` is therefore
-- "accepted and not revoked/expired", and revocation denies the very next call
-- because no authorization is ever cached.
--
-- DEV apply only; never production without an explicit product decision.

begin;

-- ---------------------------------------------------------------------------
-- 1. The ONE SQL authority predicate
-- ---------------------------------------------------------------------------
-- The SQL mirror of lib/live/operator-authorization.ts `canOperateLiveForPlace`,
-- so the route and the RPC evaluate the SAME rule. Internal: no client EXECUTE
-- (the definer RPCs call it; a client can never probe it).
create or replace function public.can_operate_live_for_place(
  p_user_id  uuid,
  p_place_id text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1
      from public.producer_memberships m
      where m.user_id = p_user_id
        and m.place_id = p_place_id
        and m.role in ('owner', 'manager')
    )
    or exists (
      select 1
      from public.live_operators lo
      where lo.user_id = p_user_id
        and lo.place_id = p_place_id
        and lo.revoked_at is null
    );
$$;

revoke all on function public.can_operate_live_for_place(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. start_live_session — authorization now accepts an active operator
-- ---------------------------------------------------------------------------
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

  -- ---- Authorization (INSIDE the RPC, not only at the route) --------------
  -- owner/manager of the EXACT Place, OR a delegated Operator Live holding an
  -- ACTIVE assignment for that EXACT Place. A revoked operator fails on this
  -- very call — there is no authorization cache anywhere.
  if not public.can_operate_live_for_place(auth.uid(), p_place_id) then
    raise exception 'producer_authorization_required' using errcode = '42501';
  end if;

  -- The producing Producer is DERIVED here, never supplied by the client: the
  -- caller's own owner/manager membership, else the Producer that authorized
  -- the delegated assignment.
  select producer_id into v_membership
  from public.producer_memberships
  where user_id = auth.uid()
    and place_id = p_place_id
    and role in ('owner', 'manager')
  limit 1;

  if v_membership is null then
    select lo.granted_by into v_membership
    from public.live_operators lo
    where lo.user_id = auth.uid()
      and lo.place_id = p_place_id
      and lo.revoked_at is null
    limit 1;
  end if;

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

-- ---------------------------------------------------------------------------
-- 3. end_live_session — 'producer_ended' now accepts an active operator
-- ---------------------------------------------------------------------------
create or replace function public.end_live_session(
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
    -- Authorization is derived from the SESSION's own Place, and now accepts an
    -- ACTIVE delegated operator exactly like the start path. A revoked operator
    -- is refused here on this very call.
    if not public.can_operate_live_for_place(auth.uid(), v_session.place_id) then
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

-- ---------------------------------------------------------------------------
-- 4. Privileges — unchanged posture (authenticated only; never public/anon)
-- ---------------------------------------------------------------------------
revoke execute on function public.start_live_session(text, text, text, text) from public, anon;
grant execute on function public.start_live_session(text, text, text, text) to authenticated;

revoke execute on function public.end_live_session(text, text, text, text) from public, anon;
grant execute on function public.end_live_session(text, text, text, text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 5. DEV apply notes
-- ---------------------------------------------------------------------------
-- Apply AFTER 0047 and 0048 (it reads public.live_operators). It replaces two
-- function BODIES only; it creates/alts no table and deletes no data.
--
-- Post-apply verification (DEVELOPMENT only):
--   * as an owner/manager: start_live_session / end_live_session keep working;
--   * as a delegated operator with an ACTIVE assignment (accepted invitation):
--     both RPCs succeed; the session's producer_id is live_operators.granted_by;
--   * after revoking that invitation: the operator's NEXT start/end call raises
--     producer_authorization_required;
--   * an operator of Place A cannot start/end for Place B;
--   * an editor and an unrelated authenticated account are refused;
--   * anon holds no EXECUTE on either RPC and can read no operator row.
-- The runnable manual script for all of the above is
-- web/tests/db-regression/live-operator-invitations-access.sql (rolls back).
