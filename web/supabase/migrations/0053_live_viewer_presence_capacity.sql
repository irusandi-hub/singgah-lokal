-- 0053 — A-04: the 100-concurrent cap counts ACTIVE PRESENCE, not a rolling
-- admission window.
--
-- Audit finding (docs/audits/LIVE_AUTH_AUDIT_v1.md A-04): `admit_live_viewer`
-- counted `live_viewers` rows with `admitted_at > now() - interval '5 minutes'`.
-- The locked limit is 100 CONCURRENT viewers (MASTER_LIVE_POLICY §6, §12.2 #1),
-- and MASTER_LIVE_TECH §6 states the mechanism explicitly: "100 = concurrent
-- viewers (admission gate counts active presence, not live_viewers ledger
-- rows) … live_viewers ledger rows are historical metadata only and never count
-- toward the cap". The old proxy therefore stopped counting a viewer who kept
-- watching past 5 minutes: 100 admissions at T plus 100 more at T+6min yielded
-- ~200 real viewers counted as 100, and viewer_peak was understated (policy
-- §12.1 item 7).
--
-- Fix, exactly as the audit prescribes ("an explicit lease/heartbeat with
-- server-side expiry"):
--   1. `live_viewers.last_seen_at` — the viewer's presence lease, refreshed by
--      the server on admission and on every authenticated presence heartbeat;
--   2. the cap counts rows whose lease is still inside the re-admission grace
--      window (TUNABLE, unchanged default 5 minutes), so a viewer who keeps
--      watching keeps counting, while a viewer who left (stops heartbeating)
--      stops counting after the grace window — presence semantics, fail closed;
--   3. `public.touch_live_viewer_presence(text)` — the ONLY renewal path. It
--      renews the caller's own lease for a session that is STILL live, and is
--      refused otherwise. It is deliberately NOT an admission: admission stays
--      exclusively in `admit_live_viewer`, which runs the full fail-closed gate
--      first (so this migration cannot be a way around email/age/content/
--      capacity checks);
--   4. the private Realtime channel policies (0009) now evaluate the SAME
--      presence lease, so a viewer who is watching keeps receiving comments and
--      one who left stops — one definition of "present", used twice.
--
-- Not changed: the locked 100 cap, the TUNABLE 5-minute grace value, the global
-- 5 / per-Place 1 caps, the advisory-lock serialization of admission (0027),
-- the idempotent upsert, the audit row on capacity denial, viewer_peak
-- accounting, and every fail-closed gate (assert_viewer_eligible is still the
-- first statement of admit_live_viewer, and B1 still denies all viewers).
--
-- Forward-only, least privilege, non-destructive (one added column + one new
-- RPC + two policy re-creations). DEV apply only.

begin;

-- ---------------------------------------------------------------------------
-- 1. Presence lease on the existing ledger
-- ---------------------------------------------------------------------------
alter table public.live_viewers
  add column if not exists last_seen_at timestamptz;

-- Backfill: the ledger's historical rows get their admission time, never "now"
-- (a migration must not invent presence for viewers who are not watching).
update public.live_viewers
set last_seen_at = admitted_at
where last_seen_at is null;

alter table public.live_viewers
  alter column last_seen_at set default now();
alter table public.live_viewers
  alter column last_seen_at set not null;

-- Presence counting is always scoped to one session; this keeps the cap query
-- index-backed as the ledger grows (one row per viewer per session).
create index if not exists live_viewers_presence_idx
  on public.live_viewers (live_session_id, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- 2. admit_live_viewer — same signature/behaviour, presence-based capacity
-- ---------------------------------------------------------------------------
create or replace function public.admit_live_viewer(p_session_id text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_concurrent integer;
begin
  perform public.assert_viewer_eligible(p_session_id);

  -- Serialize this session's capacity check + ledger insert (0027), so two
  -- concurrent admissions can never both pass the 100-concurrent gate.
  perform pg_advisory_xact_lock(
    hashtextextended('live_viewer_admission_lock:' || p_session_id, 0)
  );

  -- Concurrent capacity (PO 2026-09-18: "100 viewers" = concurrent; tech §6:
  -- count ACTIVE PRESENCE, never the ledger itself). A viewer counts while its
  -- presence lease is inside the re-admission grace window (TUNABLE, default 5
  -- minutes) and is renewed by touch_live_viewer_presence() while watching —
  -- so a viewer watching longer than the window KEEPS counting (A-04), while
  -- one who stopped heartbeating drops out after the window.
  select count(*) into v_concurrent
  from public.live_viewers
  where live_session_id = p_session_id
    and last_seen_at > now() - interval '5 minutes';

  if v_concurrent >= 100 then
    insert into public.live_audit (live_session_id, actor_id, action, detail)
    values (p_session_id, auth.uid(), 'admission_denied', jsonb_build_object('reason', 'capacity_full'));
    raise exception 'live_capacity_full' using errcode = 'P0001';
  end if;

  insert into public.live_viewers (live_session_id, user_id, last_seen_at)
  values (p_session_id, auth.uid(), now())
  on conflict (live_session_id, user_id) do update
    set admitted_at = now(),
        last_seen_at = now();

  -- MR2: persist viewer peak (policy §12.1 item 7 retention). Now that the
  -- count is real concurrent presence, the peak is no longer understated;
  -- hard-bounded by the viewer_peak <= 100 check.
  update public.live_sessions
  set viewer_peak = greatest(viewer_peak, v_concurrent + 1)
  where id = p_session_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Presence heartbeat — the only renewal path (NOT an admission)
-- ---------------------------------------------------------------------------
create or replace function public.touch_live_viewer_presence(p_session_id text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_live boolean;
begin
  -- Fail closed: anonymous callers can never renew presence.
  if auth.uid() is null then
    raise exception 'live_viewer_denied' using errcode = 'P0001';
  end if;

  select (status = 'live') into v_live
  from public.live_sessions
  where id = p_session_id;

  if v_live is null or not v_live then
    raise exception 'live_session_not_live' using errcode = 'P0001';
  end if;

  -- Only the caller's OWN lease for THIS session is renewed, and only when the
  -- viewer is already on the ledger (admitted through the full gate). A caller
  -- with no admission gets nothing — this function can never grant presence
  -- nor admission to anyone else.
  update public.live_viewers
  set last_seen_at = now()
  where live_session_id = p_session_id
    and user_id = auth.uid();

  if not found then
    raise exception 'live_viewer_denied' using errcode = 'P0001';
  end if;

  return true;
end;
$$;

-- Same posture as every other client-facing Live RPC: authenticated only, no
-- PUBLIC/anon EXECUTE (the implicit PUBLIC default is revoked explicitly).
revoke execute on function public.touch_live_viewer_presence(text) from public, anon;
grant execute on function public.touch_live_viewer_presence(text) to authenticated;
grant execute on function public.touch_live_viewer_presence(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Realtime policies (0009) evaluate the SAME presence lease
-- ---------------------------------------------------------------------------
-- Re-created (not weakened): the admitted-viewer predicate now reads the
-- presence lease instead of the admission timestamp, so the channel gate and
-- the capacity gate can never disagree about who is present. The producer
-- branch, the broadcast-extension restriction and the topic check are
-- unchanged, and every non-live session stays denied on the send path.
drop policy if exists live_realtime_receive on realtime.messages;
create policy live_realtime_receive
on realtime.messages
for select
to authenticated
using (
  realtime.topic() like 'live_session:%'
  and exists (
    select 1
    from public.live_viewers v
    join public.live_sessions s on s.id = v.live_session_id
    where v.live_session_id = substring(realtime.topic() from 14)
      and v.user_id = auth.uid()
      and v.last_seen_at > now() - interval '5 minutes'
      and realtime.messages.extension = 'broadcast'
  )
);

drop policy if exists live_realtime_send on realtime.messages;
create policy live_realtime_send
on realtime.messages
for insert
to authenticated
with check (
  realtime.topic() like 'live_session:%'
  and realtime.messages.extension = 'broadcast'
  and (
    exists (
      select 1
      from public.live_viewers v
      join public.live_sessions s on s.id = v.live_session_id
      where v.live_session_id = substring(realtime.topic() from 14)
        and v.user_id = auth.uid()
        and v.last_seen_at > now() - interval '5 minutes'
        and s.status = 'live'
    )
    or exists (
      select 1
      from public.live_sessions s
      join public.producer_memberships m on m.place_id = s.place_id
      where s.id = substring(realtime.topic() from 14)
        and m.user_id = auth.uid()
        and m.role in ('owner', 'manager')
    )
  )
);

commit;
