-- 0060_live_decouple_production_stage.sql
-- LIVE ↔ KEGIATAN / KELOLA PROSES — DECOUPLING (product decision 2026-10-16).
--
-- PRODUCT RATIONALE
-- Kegiatan and Kelola Proses are INFORMATIONAL tools for a Place's owners /
-- authorized managers: they describe activities and processes and their
-- lifecycle (draft → published → paused → archived). Live is a SEPARATE
-- capability associated with a Place. Live must never require a Production
-- Stage to exist, be published, or be selected, and informational content
-- changes must never block a Live start nor automatically end a running Live.
--
-- BEFORE this migration the database enforced the opposite (the superseded
-- "strict-MVP" resolution, MASTER_LIVE_POLICY §12.1 item 4 / MASTER_LIVE_TECH
-- §4.2 #3 and §4.5):
--   * `live_sessions.stage_id` was NOT NULL and carried the composite FK
--     `live_sessions_stage_place_fkey (stage_id, place_id) →
--     production_stages (id, place_id) ON DELETE CASCADE`;
--   * the trigger `live_stage_guard_trigger` auto-ENDED a live session whose
--     stage left `published` (`ended_reason = 'source_stage_unpublished'`);
--   * `start_live_session` refused a start unless the referenced stage existed
--     in the same Place and was `published` (`live_stage_not_published`).
-- Two consequences the product decision forbids: deleting a Production Stage
-- DELETED its Live sessions (the FK's ON DELETE CASCADE), and pausing/archiving
-- a stage KILLED a running broadcast.
--
-- WHAT THIS MIGRATION CHANGES (and nothing else)
--   1. Drops the stage guard trigger and the now-unused guard function.
--   2. Drops the composite FK — which also removes the ON DELETE CASCADE that
--      let informational content destroy Live history.
--   3. Makes `live_sessions.stage_id` nullable. The COLUMN STAYS: historical
--      sessions keep the Process reference they recorded, so their Place/LIVE
--      card and audit trail stay readable. No data is deleted or remapped.
--   4. Re-states the `ended_reason` CHECK explicitly and documents it.
--      APPROACH CHOSEN: `source_stage_unpublished` is KEPT as a
--      legacy-valid value for historical rows (it is never produced any more).
--      Rationale: existing rows already carry it, an ended session is immutable
--      by design, and remapping those rows would rewrite audit history —
--      preserving data and history wins over a narrower vocabulary. New
--      attempts to end a session with that reason are refused by the RPC
--      (see 6), so the value cannot be re-introduced.
--   5. Replaces `start_live_session` with a stage-free definition: the session
--      is created WITHOUT a stage. The legacy `p_stage_id` argument is kept
--      (now with a DEFAULT NULL) so every existing caller and grant stays
--      valid, and it is IGNORED — it is never validated and never persisted.
--      All other behaviour is unchanged: authority, eligibility, the global
--      advisory lock, the global (5) and per-Place (1) caps, idempotent
--      replay, the audit row, and the returned JSON shape.
--   6. Replaces `end_live_session` without the `source_stage_unpublished`
--      branch, so that reason (and any other unsupported value) raises
--      `live_end_reason_invalid`. Idempotency, the end-reason validation for
--      the remaining reasons, the audit row, and the realtime status signal
--      are byte-for-byte the previous definition.
--
-- WHY THIS IS SAFE TO APPLY ONCE TO THE EXPECTED SCHEMA
--   * Forward-only and non-destructive: no table, row, column, index, policy,
--     grant, or unrelated constraint is removed; the only dropped objects are
--     the Live↔stage coupling itself.
--   * The relaxed constraints are STRICTLY MORE PERMISSIVE for inserts
--     (nullable column, no FK), so no existing row can violate them.
--   * Both functions keep their `security definer`, pinned `search_path`, and
--     EXECUTE posture (restated at the bottom; `create or replace` also
--     preserves owner and ACL).
--   * Idempotent re-apply: every drop uses IF EXISTS and the constraint
--     re-add is guarded.
--   * Deliberately NOT touched: `production_stages` and its informational
--     lifecycle, `production_stages_id_place_id_key` (harmless without its
--     former dependent FK), the operator read policy on production_stages,
--     RLS, `live_audit` append-only enforcement, the 60-minute cap, moderation,
--     eligibility, viewer capacity, and the notification trigger of 0026 (it
--     still resolves a Process title for a LEGACY session that has one, and
--     simply writes no title for a session that has none).
--
-- DEV apply only; never production without an explicit product decision.
-- DO NOT apply this migration as part of the change that introduced it.

begin;

-- ---------------------------------------------------------------------------
-- 1. The stage auto-end hook is gone
-- ---------------------------------------------------------------------------
-- Drop the trigger FIRST (a trigger function cannot be dropped while a trigger
-- depends on it), then the function, so no informational write can ever reach
-- `end_live_session` again. Leaving the function installed would invite a
-- future accidental re-installation of the superseded behaviour.
drop trigger if exists live_stage_guard_trigger on public.production_stages;
drop function if exists public.live_stage_guard();

-- ---------------------------------------------------------------------------
-- 2. Live sessions are no longer bound to a Production Stage
-- ---------------------------------------------------------------------------
-- The composite FK (0008) both required a stage of the SAME Place and, through
-- its ON DELETE CASCADE, deleted the Place's Live sessions whenever that stage
-- row was deleted. Both effects contradict the product decision. The unique
-- constraint it referenced (`production_stages_id_place_id_key`) is left in
-- place: it is unrelated to Live now and may still back other integrity needs.
alter table public.live_sessions
  drop constraint if exists live_sessions_stage_place_fkey;

-- ---------------------------------------------------------------------------
-- 3. `stage_id` becomes nullable (kept as a historical reference)
-- ---------------------------------------------------------------------------
alter table public.live_sessions
  alter column stage_id drop not null;

-- ---------------------------------------------------------------------------
-- 4. `ended_reason`: explicit, with the legacy value retained
-- ---------------------------------------------------------------------------
-- Same four values as 0008 enforced, re-stated explicitly and documented so
-- the legacy decision is visible in the schema itself (see the header for why
-- `source_stage_unpublished` is kept rather than remapped).
alter table public.live_sessions
  drop constraint if exists live_sessions_ended_reason_check;

do $$ begin
  alter table public.live_sessions
    add constraint live_sessions_ended_reason_check
    check (ended_reason in ('producer_ended', 'duration_cap', 'source_stage_unpublished', 'moderation'));
exception
  when duplicate_object then null;
end $$;

comment on constraint live_sessions_ended_reason_check on public.live_sessions is
  'Live end reasons. producer_ended / duration_cap / moderation are the ACTIVE '
  'lifecycle reasons. source_stage_unpublished is LEGACY-ONLY: it is retained so '
  'historical rows stay valid and auditable, but nothing produces it since Live '
  'was decoupled from Kegiatan / Kelola Proses (2026-10-16) and end_live_session '
  'now refuses it with live_end_reason_invalid.';

-- ---------------------------------------------------------------------------
-- 5. start_live_session — creates a session WITHOUT a stage
-- ---------------------------------------------------------------------------
-- Latest effective definition: 0049 (which replaced 0008's body and made the
-- authority predicate accept an ACTIVE delegated operator). This definition
-- changes ONLY the stage handling:
--   * the published-stage lookup and the `live_stage_not_published` raise are
--     removed, so a Place with zero stages — or with every stage paused,
--     archived, or unpublished — starts exactly like any other;
--   * `stage_id` is always inserted as NULL;
--   * the audit detail no longer claims a stage;
--   * `p_stage_id` keeps its position but gains DEFAULT NULL and is otherwise
--     ignored (backward compatibility: existing callers and the existing
--     `grant execute on function public.start_live_session(text, text, text,
--     text)` remain valid). Postgres requires that parameters AFTER one with a
--     default also have defaults, hence the DEFAULT on `p_idempotency_key` and
--     `p_live_input_id`; the body still enforces a non-blank idempotency key
--     with the same `live_idempotency_key_required` error as before.
-- Everything else — authority via can_operate_live_for_place, the derived
-- producer identity, the eligibility gate, the global start lock, the global
-- (5) and per-Place (1) caps, the unique-violation backstop, idempotent
-- replay, the audit row, and the return shape — is unchanged.
create or replace function public.start_live_session(
  p_place_id text,
  p_stage_id text default null,
  p_idempotency_key text default null,
  p_live_input_id text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_membership text;
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

  -- NOTE (product decision 2026-10-16): there is deliberately NO Production
  -- Stage precondition here. Kegiatan / Kelola Proses are informational and
  -- must not gate Live; `p_stage_id` is accepted for compatibility only and is
  -- never validated or stored.

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
      (p_place_id, v_membership, null, 'live', p_live_input_id, p_idempotency_key)
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
    jsonb_build_object('live_input_id', p_live_input_id));

  return jsonb_build_object('sessionId', v_session_id, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. end_live_session — no stage-unpublication path
-- ---------------------------------------------------------------------------
-- Latest effective definition: 0049 (0012's idempotent body with 0049's
-- operator-aware authorization). The ONLY change here is the removal of the
-- `elsif p_reason = 'source_stage_unpublished'` branch: with the guard trigger
-- gone, nothing can end a session that way, and an explicit attempt now falls
-- through to the existing `else raise exception 'live_end_reason_invalid'`.
-- Idempotency, the remaining reason checks, the audit row, and the realtime
-- status broadcast are unchanged.
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
    -- Authorization is derived from the SESSION's own Place, and accepts an
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
  else
    -- Includes the LEGACY 'source_stage_unpublished': it stays valid on
    -- historical rows (see section 4) but can no longer be produced.
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
-- 7. Privileges — posture restated verbatim (nothing widened)
-- ---------------------------------------------------------------------------
-- Same 4-argument signatures as before, so the existing ACLs are preserved by
-- `create or replace`; these statements are restated so the posture is explicit
-- and provable after apply: `authenticated` only, never PUBLIC/anon.
revoke execute on function public.start_live_session(text, text, text, text) from public, anon;
grant execute on function public.start_live_session(text, text, text, text) to authenticated;

revoke execute on function public.end_live_session(text, text, text, text) from public, anon;
grant execute on function public.end_live_session(text, text, text, text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 8. Post-apply verification (DEVELOPMENT only — DO NOT run here)
-- ---------------------------------------------------------------------------
--   -- the coupling is gone
--   select count(*) from pg_trigger
--    where tgname = 'live_stage_guard_trigger';                  -- expect 0
--   select count(*) from pg_proc where proname = 'live_stage_guard';  -- expect 0
--   select count(*) from pg_constraint
--    where conname = 'live_sessions_stage_place_fkey';           -- expect 0
--   select is_nullable from information_schema.columns
--    where table_name = 'live_sessions' and column_name = 'stage_id';  -- expect YES
--
--   -- historical rows survive and keep their reason
--   select count(*) from public.live_sessions
--    where ended_reason = 'source_stage_unpublished';             -- expect unchanged
--
--   -- a stage-free start succeeds for an authorized, eligible Place
--   -- (an owner/manager on a Place with ZERO production_stages), and the new
--   -- row's stage_id is null:
--   select public.start_live_session('<place_id>', null, 'verify-060-key', 'verify-input');
--   select stage_id from public.live_sessions where idempotency_key = 'verify-060-key';
--
--   -- the removed reason is refused
--   select public.end_live_session('<session_id>', 'verify-060-end', 'source_stage_unpublished');
--     -- expect: live_end_reason_invalid
--
--   -- posture unchanged
--   select has_function_privilege('anon', 'public.start_live_session(text,text,text,text)', 'EXECUTE');          -- false
--   select has_function_privilege('authenticated', 'public.start_live_session(text,text,text,text)', 'EXECUTE'); -- true
--   select has_function_privilege('anon', 'public.end_live_session(text,text,text,text)', 'EXECUTE');            -- false
--   select has_function_privilege('authenticated', 'public.end_live_session(text,text,text,text)', 'EXECUTE');   -- true
