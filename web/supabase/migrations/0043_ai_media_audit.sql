-- 0043 — AI PLACE MEDIA AUDIT: an append-only, attributable trail of AI media
-- action (MASTER 09 §13 / the AI Place Media foundation 0042).
--
-- GAP THIS MIGRATION FILLS
-- 0042 gave AI Place Media its sources, drafts, quota, provider config and the
-- locked regeneration gate, but a Producer's AI media *actions* left no durable
-- record of WHO did WHAT. An approval is a publication-grade decision (it is
-- the only path that may write a Place's canonical cover), a source upload
-- introduces private input material, and a blocked regeneration attempt is
-- exactly the kind of action that must be explainable later. This migration
-- adds the missing trail, in the same shape as 0031's `place_audit` and
-- 0008's `live_audit`.
--
-- RULES HONOURED
-- - APPEND-ONLY. A `before update or delete` trigger raises for every writer,
--   the service role included. A trail that can be rewritten is not a trail.
-- - ATTRIBUTION IS NOT OPTIONAL. `actor_id` is NOT NULL and references
--   `public.users(id)` ON DELETE RESTRICT: the Producer account that performed
--   the action cannot be deleted out from under its history. `place_id` is NOT
--   NULL and references `public.places(id)` with the default NO ACTION, so the
--   trail cannot be silently orphaned by a Place deletion either.
-- - FAIL CLOSED ON ACCESS. RLS is enabled with NO policy and the table is
--   revoked from `public`, `anon` and `authenticated`, so no client — signed in
--   or not — can read or write a row. Reads and writes go through server code
--   (service role) only, after the API layer's Producer authorization check.
-- - NO NEW GRANT TO CLIENTS. The only write path is the server-only
--   `record_ai_media_audit` RPC, whose EXECUTE is revoked from clients.
-- - NOTHING DESTROYED. This is purely additive: it creates one table, two
--   indexes, one append-only trigger and one RPC. It rewrites no existing
--   table, policy, function body or grant, and re-applying it is a no-op.
--
-- PRIVACY: `detail` carries only operator-facing context (source/output keys,
-- statuses, the provider name and cost when a real provider ran). No email, no
-- credential, and no infrastructure value is ever written here.

create table if not exists public.ai_media_audit (
  id bigserial primary key,
  place_id text not null references public.places(id),
  producer_id text references public.producers(id) on delete set null,
  actor_id uuid not null references public.users(id) on delete restrict,
  action text not null check (action in (
    'ai_source_uploaded',
    'ai_source_removed',
    'ai_output_saved',
    'ai_output_approved',
    'ai_output_rejected',
    'ai_regeneration_requested',
    'ai_regeneration_blocked',
    'ai_generation_quota_blocked'
  )),
  -- What the action was about, when it targeted a specific AI media object.
  target_type text check (target_type is null or target_type in ('source', 'output', 'job', 'quota')),
  target_key text check (target_key is null or char_length(target_key) <= 200),
  job_id uuid references public.ai_media_generation_jobs(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_media_audit_place_created_idx
on public.ai_media_audit (place_id, created_at desc);

create index if not exists ai_media_audit_actor_created_idx
on public.ai_media_audit (actor_id, created_at desc);

-- Append-only (MASTER 09 §13): written once, never corrected in place. A wrong
-- entry is superseded by a later one, which is why history is kept.
create or replace function public.block_ai_media_audit_mutation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  raise exception 'ai_media_audit is append-only';
end;
$$;

drop trigger if exists ai_media_audit_block_mutation on public.ai_media_audit;
create trigger ai_media_audit_block_mutation
before update or delete on public.ai_media_audit
for each row execute procedure public.block_ai_media_audit_mutation();

-- Fail closed, mirroring 0031's `place_audit`: RLS on, zero policies, every
-- client role stripped. The service role is the only writer/reader.
alter table public.ai_media_audit enable row level security;

revoke all on public.ai_media_audit from public, anon, authenticated;

-- The one server-only write path. The caller's session-derived user id is
-- passed explicitly by server code — never by the client — and the action
-- vocabulary is re-validated here so an unknown action cannot be recorded.
create or replace function public.record_ai_media_audit(
  p_place_id text,
  p_actor_id uuid,
  p_action text,
  p_producer_id text default null,
  p_target_type text default null,
  p_target_key text default null,
  p_job_id uuid default null,
  p_detail jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  inserted bigint;
begin
  if p_place_id is null or length(btrim(p_place_id)) = 0 or p_actor_id is null then
    raise exception 'ai_media_audit_actor_required';
  end if;
  if p_action is null or p_action not in (
    'ai_source_uploaded',
    'ai_source_removed',
    'ai_output_saved',
    'ai_output_approved',
    'ai_output_rejected',
    'ai_regeneration_requested',
    'ai_regeneration_blocked',
    'ai_generation_quota_blocked'
  ) then
    raise exception 'ai_media_audit_action_invalid';
  end if;
  if p_target_type is not null and p_target_type not in ('source', 'output', 'job', 'quota') then
    raise exception 'ai_media_audit_action_invalid';
  end if;
  if not exists (select 1 from public.places p where p.id = p_place_id) then
    raise exception 'ai_media_audit_place_not_found';
  end if;

  insert into public.ai_media_audit
    (place_id, producer_id, actor_id, action, target_type, target_key, job_id, detail)
    values (
      p_place_id,
      p_producer_id,
      p_actor_id,
      p_action,
      p_target_type,
      case when p_target_key is null then null else left(p_target_key, 200) end,
      p_job_id,
      coalesce(p_detail, '{}'::jsonb)
    )
  returning id into inserted;

  return inserted;
end;
$$;

revoke all on function public.record_ai_media_audit(text, uuid, text, text, text, text, uuid, jsonb)
from public, anon, authenticated;

-- Trigger functions are never called directly; trigger execution runs as the
-- table owner and is unaffected by EXECUTE grants (same reasoning as 0013/0031).
revoke execute on function public.block_ai_media_audit_mutation()
from public, anon, authenticated;
