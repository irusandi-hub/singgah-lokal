-- 0038: Discovery signal AGGREGATION (Home performance, N+1 fix).
--
-- Root cause: SupabasePlaceExperienceRepository.listDiscoveryInputs() ran
-- FIVE queries per published Place (live session, place_follows count,
-- visit_intents count, place_photos count, published-experiences count).
-- With the 64 published DEV Places that is ~321 round trips for ONE Home
-- render. This migration adds ONE security-definer RPC that returns the SAME
-- canonical signals for EVERY published Place in ONE round trip.
--
-- Parity contract (LOCKED — the signals MUST match the per-Place queries
-- they replace exactly, so scoring/eligibility is bit-identical):
--   live          = latest live_sessions row per Place by started_at desc
--                   (fetchLiveSignal: order started_at desc, limit 1)
--   followers     = count(place_follows where place_id = p)
--   visit_intents = count(visit_intents where place_id = p)
--   photos        = count(place_photos where place_id = p)
--   published_experiences = count(experiences where place_id = p and
--                   status='published' and publication_status='published')
--   places scope  = publication_status = 'published', ordered by id
--                   (listDiscoveryInputs' canonical read).
--
-- No identity/user data is returned: the result carries place_id, signal
-- counts, and the live status/timestamp only. Every engagement aggregate sits
-- behind self-only RLS (0002/0023), so the RPC is SECURITY DEFINER with a
-- fixed search_path and EXECUTE is revoked from anon/public/authenticated —
-- only the server-side service role can call it (same fail-closed privilege
-- pattern as 0008/0013). It performs no writes.

create or replace function public.list_discovery_signal_aggregates()
returns table (
  place_id text,
  live_status text,
  live_started_at timestamptz,
  followers bigint,
  visit_intents bigint,
  published_experiences bigint,
  photos bigint
)
language sql
security definer
set search_path = public
as $$
  select
    p.id::text as place_id,
    live.status as live_status,
    live.started_at as live_started_at,
    coalesce(f.followers, 0::bigint) as followers,
    coalesce(v.visit_intents, 0::bigint) as visit_intents,
    coalesce(e.published_experiences, 0::bigint) as published_experiences,
    coalesce(ph.photos, 0::bigint) as photos
  from public.places p
  left join lateral (
    select s.status, s.started_at
    from public.live_sessions s
    where s.place_id = p.id
    order by s.started_at desc
    limit 1
  ) live on true
  left join lateral (
    select count(*) as followers
    from public.place_follows f
    where f.place_id = p.id
  ) f on true
  left join lateral (
    select count(*) as visit_intents
    from public.visit_intents v
    where v.place_id = p.id
  ) v on true
  left join lateral (
    select count(*) as photos
    from public.place_photos ph
    where ph.place_id = p.id
  ) ph on true
  left join lateral (
    select count(*) as published_experiences
    from public.experiences e
    where e.place_id = p.id
      and e.status = 'published'
      and e.publication_status = 'published'
  ) e on true
  where p.publication_status = 'published'
  order by p.id
$$;

-- Fail-closed privilege lockdown (0008/0013 pattern): the aggregate exposes
-- engagement counts that sit behind self-only RLS, so NO direct role may
-- execute it. The Supabase service role bypasses RLS and is not a named
-- grant target here; server code calls it through the service client.
revoke execute on function public.list_discovery_signal_aggregates()
from public, anon, authenticated;
