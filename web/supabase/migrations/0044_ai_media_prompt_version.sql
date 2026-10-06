-- 0044 — AI PLACE MEDIA: prompt/version tracking + request metadata.
--
-- GAP THIS MIGRATION FILLS
-- 0042 recorded the sources, the generated outputs, the provider, the status and
-- the quota, but not WHICH prompt/version produced an output, nor the request
-- metadata that surrounded the generation. Without that, a generated image is
-- not reproducible or explainable: two runs of the same Place could differ with
-- no way to tell which prompt revision was used.
--
-- WHAT THIS ADDS (purely additive)
-- - `ai_media.prompt_key`, `prompt_version`, `request_metadata` — the artifact
--   records the exact prompt revision and request context it came from.
-- - `ai_media_generation_jobs.prompt_key`, `prompt_version`,
--   `request_metadata` — the request records the same, so a queued/failed run
--   is explainable before any output exists.
-- - One server-only RPC, `record_ai_media_generation_metadata`, so the job
--   worker (when a real provider is approved) can attach that metadata to the
--   job and/or the saved output after a real generation. It performs no
--   generation and is not reachable by any client.
--
-- RULES HONOURED
-- - NO PROVIDER, NO FAKE GENERATION. This migration calls no provider and adds
--   no endpoint; it only widens the persisted record.
-- - No prompt vocabulary is hardcoded in the database: `prompt_key` is a bounded
--   text column, so prompt revisions live in code (the single source of truth)
--   and are not pinned by a CHECK that a future revision would have to rewrite.
-- - Idempotency: every change is `if not exists` / guarded, and re-applying the
--   file is a no-op. No existing column, table, policy, function body or grant
--   is rewritten and nothing is deleted.
-- - Every touched table stays server-only (RLS on, zero policies, client
--   privileges already revoked in 0042); the new RPC's EXECUTE is revoked from
--   clients here.

-- ---------------------------------------------------------------------------
-- 1. Artifact record — which prompt revision produced this output, and the
--    request context around it.
-- ---------------------------------------------------------------------------
alter table public.ai_media
  add column if not exists prompt_key text;
alter table public.ai_media
  add column if not exists prompt_version integer;
alter table public.ai_media
  add column if not exists request_metadata jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. Request record — the same metadata on the job, so a queued or failed run
--    is explainable before an output exists.
-- ---------------------------------------------------------------------------
alter table public.ai_media_generation_jobs
  add column if not exists prompt_key text;
alter table public.ai_media_generation_jobs
  add column if not exists prompt_version integer;
alter table public.ai_media_generation_jobs
  add column if not exists request_metadata jsonb not null default '{}'::jsonb;

-- Bounded prompt key: non-empty, short, never an unbounded dump.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_media_prompt_key_bounded') then
    alter table public.ai_media
      add constraint ai_media_prompt_key_bounded
      check (prompt_key is null or char_length(prompt_key) between 1 and 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_media_generation_jobs_prompt_key_bounded') then
    alter table public.ai_media_generation_jobs
      add constraint ai_media_generation_jobs_prompt_key_bounded
      check (prompt_key is null or char_length(prompt_key) between 1 and 80);
  end if;
end
$$;

-- A prompt version is a positive integer; "version 0" is not a revision.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_media_prompt_version_positive') then
    alter table public.ai_media
      add constraint ai_media_prompt_version_positive
      check (prompt_version is null or prompt_version > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_media_generation_jobs_prompt_version_positive') then
    alter table public.ai_media_generation_jobs
      add constraint ai_media_generation_jobs_prompt_version_positive
      check (prompt_version is null or prompt_version > 0);
  end if;
end
$$;

create index if not exists ai_media_prompt_version_idx
on public.ai_media (prompt_key, prompt_version);

-- ---------------------------------------------------------------------------
-- 3. Server-only worker RPC. Attaches prompt/version/request metadata to a job
--    and/or a saved output after a REAL generation. Not reachable by a client:
--    EXECUTE is revoked from public/anon/authenticated below, and 0042 already
--    locked every AI media table to the service role.
-- ---------------------------------------------------------------------------
create or replace function public.record_ai_media_generation_metadata(
  p_job_id uuid default null,
  p_place_id text default null,
  p_producer_id text default null,
  p_output_key text default null,
  p_prompt_key text default null,
  p_prompt_version integer default null,
  p_request_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- At least one target must be named: this RPC only annotates existing rows.
  if p_job_id is null and p_output_key is null then
    raise exception 'ai_media_generation_metadata_target_required';
  end if;
  if p_prompt_version is not null and p_prompt_version <= 0 then
    raise exception 'ai_media_prompt_version_invalid';
  end if;
  if p_prompt_key is not null and (length(btrim(p_prompt_key)) = 0 or length(p_prompt_key) > 80) then
    raise exception 'ai_media_prompt_key_invalid';
  end if;
  if p_place_id is not null and not exists (select 1 from public.places p where p.id = p_place_id) then
    raise exception 'ai_media_generation_metadata_place_not_found';
  end if;

  if p_job_id is not null then
    update public.ai_media_generation_jobs
      set prompt_key = coalesce(p_prompt_key, prompt_key),
          prompt_version = coalesce(p_prompt_version, prompt_version),
          request_metadata = coalesce(p_request_metadata, request_metadata)
      where id = p_job_id;
    if not found then
      raise exception 'ai_media_generation_metadata_job_not_found';
    end if;
  end if;

  if p_output_key is not null then
    if p_place_id is null or p_producer_id is null then
      raise exception 'ai_media_generation_metadata_target_required';
    end if;
    if p_output_key not in ('hook', 'place_story') then
      raise exception 'ai_media_output_key_invalid';
    end if;
    update public.ai_media
      set prompt_key = coalesce(p_prompt_key, prompt_key),
          prompt_version = coalesce(p_prompt_version, prompt_version),
          request_metadata = coalesce(p_request_metadata, request_metadata)
      where place_id = p_place_id and producer_id = p_producer_id and output_key = p_output_key;
    if not found then
      raise exception 'ai_media_generation_metadata_output_not_found';
    end if;
  end if;
end;
$$;

revoke all on function public.record_ai_media_generation_metadata(uuid, text, text, text, text, integer, jsonb)
from public, anon, authenticated;
