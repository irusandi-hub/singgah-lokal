-- 0026 — LIVE STARTED → notification for the Users who follow that Place.
--
-- Implements the ONE path whose data is already authoritative
-- (MASTER 10 §2 "notification content must reflect backend source-of-truth
-- state", §12 "business services emit domain events", §14 "recipients must
-- be authorized to receive the underlying information"):
--
--   user → place_follows (0023) → live_sessions (0008) → notifications (0025)
--
-- No push delivery, no client fan-out, no polling, no user-location storage,
-- no "Around"/proximity notification, and no selected-Place relationship:
-- the recipient set is exactly the Place's followers, nothing else.
--
-- Delivery scope is `followed_place` only, and the copy is taken verbatim from
-- the locked Live masters (MASTER_LIVE_POLICY §9 / MASTER_LIVE_TECH §9:
-- "Lihat Live Sekarang" Place-page CTA, "LIVE SEKARANG" Live card label) —
-- no new wording is invented. The Process title comes from the canonical
-- production_stages row, and the payload references the entity rather than
-- duplicating mutable business state (MASTER 10 §5).
--
-- Non-destructive: one new index + one new trigger/function. No existing
-- table, policy, grant, Live rule, or data is altered (0023/0024/0025 and
-- every Live migration stay untouched). Idempotent (safe re-apply).

-- Idempotency/dedup key (MASTER 10 §12: duplicate domain events must not
-- create duplicate notifications). Rows with a NULL source are not
-- constrained by this index (PostgreSQL treats NULLs as distinct), so
-- source-less notifications from 0025 keep working exactly as before.
create unique index if not exists notifications_dedup_idx
on public.notifications (user_id, source_type, source_id, event_type);

-- Server-side notification writer. SECURITY DEFINER because notifications
-- have no client INSERT grant (0025): the row is created by the platform
-- when a Live starts, never by a user. Reached only through the existing
-- Live write path — direct DML on live_sessions is revoked for anon/
-- authenticated (0008), so every trigger firing is a server-side start
-- (start_live_session RPC or service role).
create or replace function public.notify_followed_place_live_started()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_process_title text;
begin
  -- Only a Live START counts: an INSERT that is live, or a transition INTO
  -- 'live'. Ends, moderation updates, viewer peaks, and any other update
  -- never notify (no rule about a Live is changed here).
  if new.status is distinct from 'live' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if old.status is not distinct from 'live' then
      return null;
    end if;
  end if;

  -- A notification failure must never roll back a valid Live start
  -- (MASTER 10 §17): warn and keep the session. Delivery of the in-app
  -- record stays the platform's durable baseline (MASTER 10 §21).
  begin
    select ps.title into v_process_title
    from public.production_stages ps
    where ps.id = new.stage_id;

    insert into public.notifications (
      user_id, category, event_type, title, body,
      place_id, source_type, source_id, metadata
    )
    select
      f.user_id,
      'live_place',
      'live_started_followed_place',
      'Lihat Live Sekarang',
      'LIVE SEKARANG' || case
        when v_process_title is null then ''
        else ' · ' || v_process_title
      end,
      new.place_id,
      'live_session',
      new.id,
      jsonb_build_object(
        'delivery_scope', 'followed_place',
        'place_id', new.place_id,
        'process_title', v_process_title,
        'live_session_id', new.id
      )
    from public.place_follows f
    where f.place_id = new.place_id
      and (
        -- No preference row → the 0024 default (live_place = true) applies.
        not exists (
          select 1 from public.notification_preferences np
          where np.user_id = f.user_id
        )
        or exists (
          select 1 from public.notification_preferences np
          where np.user_id = f.user_id and np.live_place = true
        )
      )
    on conflict (user_id, source_type, source_id, event_type) do nothing;
  exception when others then
    raise warning 'live_followed_notification_failed: %', sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists live_sessions_notify_followed_place on public.live_sessions;
create trigger live_sessions_notify_followed_place
after insert or update on public.live_sessions
for each row
when (new.status = 'live')
execute procedure public.notify_followed_place_live_started();
