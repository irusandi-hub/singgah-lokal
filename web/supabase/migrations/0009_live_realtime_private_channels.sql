-- 0009: Lock Live Realtime channels to admitted viewers / authorized Place producers.
-- Realtime remains display transport only; Supabase tables stay canonical.

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
      and v.admitted_at > now() - interval '5 minutes'
      and realtime.messages.extension = 'broadcast'
  )
);

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
        and v.admitted_at > now() - interval '5 minutes'
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
