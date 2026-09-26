-- 0027 — VIEWER CAP RACE GUARD: the 100-concurrent admission cap must not be
-- passable by a race (MASTER_LIVE_POLICY §6 "Capacity checks are enforced
-- server-side and fail closed at the limits above"; MASTER_LIVE_TECH §4.1
-- item 4 + §7 "100 viewers: admission RPC hard gate").
--
-- Audit finding: `admit_live_viewer` counted admissions and THEN inserted,
-- with no serialization between the two steps. Two concurrent admissions
-- could therefore both observe 99 and both be admitted, letting the locked
-- cap be exceeded. The Live START path already serializes its global cap
-- under `pg_try_advisory_xact_lock` (migration 0008, audit B3) and the
-- per-Place cap is race-proof via the partial unique index; the viewer cap
-- was the only remaining unlocked gate.
--
-- Fix: same function, same signature (`p_session_id text`), same behaviour —
-- only the capacity check + ledger insert are now serialized per session by a
-- session-scoped transaction advisory lock (the same `hashtextextended` key
-- derivation already used by migration 0007).
--
-- Deliberate choices:
-- - BLOCKING `pg_advisory_xact_lock` (not the try-variant used for Live
--   start): contention must queue an admission, never deny a legitimate
--   viewer. Denial stays reserved for the real cap.
-- - Key is scoped to the session id, so admissions to DIFFERENT sessions
--   never block each other, and the lock is transaction-scoped (released on
--   commit/rollback; no session-state to leak).
--
-- Fail-closed gates are UNCHANGED and run first: `assert_viewer_eligible`
-- (session live, verified email, content gate, B1 age deny-all, capacity)
-- is still the gate; nothing here weakens age/email/auth or moderation.
--
-- Non-destructive: replaces one function body only. No table, policy, grant,
-- constraint, or data is altered, and no RPC signature changes, so every
-- existing caller and regression harness stays valid. Idempotent.
create or replace function public.admit_live_viewer(p_session_id text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_concurrent integer;
begin
  perform public.assert_viewer_eligible(p_session_id);

  -- Serialize this session's capacity check + ledger insert. Without it two
  -- concurrent admissions can both pass the 100-concurrent gate (audit fix,
  -- same reasoning as the global start cap lock in 0008).
  perform pg_advisory_xact_lock(
    hashtextextended('live_viewer_admission_lock:' || p_session_id, 0)
  );

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
