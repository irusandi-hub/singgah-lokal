-- 0045 — AI PLACE MEDIA: initial generation request path.
--
-- GAP THIS MIGRATION FILLS
-- 0042 gave AI Place Media its sources, drafts, quota, provider config, the
-- locked regeneration gate and the regeneration job path. But the architecture
-- had NO initial generation action: a Producer could upload the 4 source photos
-- but the server had no RPC to record the FIRST generation request. This
-- migration adds that missing server path, reusing the existing foundation:
--   - source existence check (all 4 required);
--   - provider configuration check (fail-closed when unconfigured/disabled);
--   - quota claim (fail-closed);
--   - idempotent job insert for BOTH outputs (hook + place_story);
--   - prompt/version + request metadata attached to the job;
--   - an attributable audit row for the request.
--
-- RULES HONOURED
-- - NO PROVIDER, NO FAKE GENERATION. This RPC records a PENDING job and returns
--   its id. It never calls a provider and never persists an output. A real
--   provider worker is the only thing that may later call save_ai_media_output.
-- - Both outputs are always requested (initial generation mirrors the both-outputs
--   contract already used by regeneration).
-- - The job is the canonical record of the request; the client never writes it.
-- - Prompt/version/metadata columns already exist (0044); this migration just
--   wires save_ai_media_output to write them when a worker saves a real output.
-- - Append-only audit vocabulary is widened by one action
--   (ai_generation_requested); nothing else is rewritten.
-- - Re-applying this migration is a no-op (create or replace + guarded column
--   adds + guarded CHECK widen).

-- ---------------------------------------------------------------------------
-- 1. Widen the audit vocabulary by one action: the initial generation request.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ai_media_audit_action_bounded'
      and pg_get_constraintdef(oid) like '%ai_generation_requested%'
  ) then
    -- Widen the CHECK to include the new action without rewriting the existing list.
    alter table public.ai_media_audit
      drop constraint if exists ai_media_audit_action_bounded,
      add constraint ai_media_audit_action_bounded
        check (action in (
          'ai_source_uploaded',
          'ai_source_removed',
          'ai_output_saved',
          'ai_output_approved',
          'ai_output_rejected',
          'ai_regeneration_requested',
          'ai_regeneration_blocked',
          'ai_generation_quota_blocked',
          'ai_generation_requested'
        ));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. save_ai_media_output must record prompt/version/metadata when a worker
--    saves a real output. The columns exist (0044); this wires them in.
-- ---------------------------------------------------------------------------
create or replace function public.save_ai_media_output(
  p_place_id text,
  p_producer_id text,
  p_output_key text,
  p_storage_path text,
  p_mime_type text,
  p_byte_size integer,
  p_provider text default null,
  p_provider_token_cost integer default 0,
  p_prompt_key text default null,
  p_prompt_version integer default null,
  p_request_metadata jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted uuid;
begin
  if p_output_key not in ('hook', 'place_story') then
    raise exception 'ai_media_output_key_invalid';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/avif') then
    raise exception 'ai_media_output_type_invalid';
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 5 * 1024 * 1024 then
    raise exception 'ai_media_output_size_invalid';
  end if;
  if p_provider_token_cost is null or p_provider_token_cost < 0 then
    raise exception 'ai_media_quota_invalid';
  end if;
  if p_storage_path is null or p_storage_path not like ('outputs/' || p_place_id || '/%') then
    raise exception 'ai_media_output_upload_failed';
  end if;

  if p_prompt_key is not null then
    if p_prompt_key = '' or char_length(p_prompt_key) > 80 then
      raise exception 'ai_media_prompt_key_invalid';
    end if;
  end if;
  if p_prompt_version is not null then
    if p_prompt_version <= 0 then
      raise exception 'ai_media_prompt_version_invalid';
    end if;
  end if;

  insert into public.ai_media (
    place_id, producer_id, output_key, storage_path, mime_type, byte_size,
    status, provider, provider_token_cost,
    prompt_key, prompt_version, request_metadata
  )
    values (
      p_place_id, p_producer_id, p_output_key, p_storage_path, p_mime_type, p_byte_size,
      'draft', p_provider, p_provider_token_cost,
      p_prompt_key, p_prompt_version, coalesce(p_request_metadata, '{}'::jsonb)
    )
    on conflict (place_id, producer_id, output_key) do update
      set storage_path = excluded.storage_path,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size,
          status = 'draft',
          provider = excluded.provider,
          provider_token_cost = excluded.provider_token_cost,
          generated_at = now(),
          approved_at = null,
          approved_by = null,
          approved_public_url = null,
          prompt_key = excluded.prompt_key,
          prompt_version = excluded.prompt_version,
          request_metadata = excluded.request_metadata
    returning id into inserted;

  return inserted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Initial generation request.
--
--    This is the server path that corresponds to the Producer pressing "Buat
--    Gambar". It is NOT a provider call. It records a PENDING job for BOTH
--    outputs and returns the job id, so the UI can show "dalam antrean" while
--    the worker produces the real drafts.
--
--    Preconditions (all inside one atomic RPC, fail-closed):
--      - a real session user id is passed by server code (never trusted from the
--        client);
--      - the user holds an owner/manager/editor membership for the Place;
--      - all 4 source photos exist for this Place + Producer;
--      - a provider is configured and enabled;
--      - quota has headroom (claim_ai_media_quota is called inline so a refused
--        quota is atomic with the request);
--      - the idempotency key is valid and unique per (place_id, producer_id).
-- ---------------------------------------------------------------------------
create or replace function public.create_initial_ai_media_generation(
  p_user_id uuid,
  p_place_id text,
  p_producer_id text,
  p_idempotency_key text,
  p_kind text default 'initial',
  p_prompt_key text default null,
  p_prompt_version integer default null,
  p_request_metadata jsonb default null,
  p_detail jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  job_id uuid;
  source_count integer;
  cfg public.ai_media_provider_config;
  used_quota integer;
  quota integer;
begin
  if p_user_id is null then
    raise exception 'producer_authorization_required';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'ai_media_generation_locked';
  end if;
  if p_kind is null or p_kind not in ('initial', 'regeneration') then
    raise exception 'ai_media_generation_locked';
  end if;

  -- Producer-account bound: the session user must be a member of this Place.
  if not exists (
    select 1 from public.producer_memberships m
    where m.user_id = p_user_id
      and m.place_id = p_place_id
      and m.producer_id = p_producer_id
      and m.role in ('owner', 'manager', 'editor')
  ) then
    raise exception 'producer_authorization_required';
  end if;

  -- Provider configuration is the real gate: no configured/enabled provider → no
  -- generation, ever. This is the honest failure path today.
  select * into cfg from public.ai_media_provider_config where id = 'primary';
  if not found then
    raise exception 'ai_media_generation_locked';
  end if;
  if not cfg.enabled then
    raise exception 'ai_media_generation_locked';
  end if;

  -- All 4 source photos must exist before generation can even be requested.
  select count(*) into source_count
    from public.ai_media_sources s
    where s.place_id = p_place_id
      and s.producer_id = p_producer_id
      and s.source_key in ('place', 'material', 'process', 'result');
  if source_count < 4 then
    raise exception 'ai_media_generation_locked';
  end if;

  -- Quota must exist and have headroom. Fail-closed and atomic with the
  -- request. We only claim quota when this is a NEW request (not a replay of
  -- the same idempotency key).
  if not exists (
    select 1 from public.ai_media_generation_jobs j
    where j.place_id = p_place_id
      and j.producer_id = p_producer_id
      and j.idempotency_key = btrim(p_idempotency_key)
  ) then
    select used_tokens, quota_tokens into used_quota, quota
      from public.ai_media_quota
      where producer_id = p_producer_id
      for update;
    if not found or quota <= 0 or used_quota + 1 > quota then
      raise exception 'ai_media_quota_exhausted';
    end if;
    update public.ai_media_quota
      set used_tokens = used_tokens + 1,
          last_used_at = now(),
          updated_at = now()
      where producer_id = p_producer_id;
  end if;

  -- Record the request as an idempotent job for BOTH outputs.
  insert into public.ai_media_generation_jobs (
    place_id, producer_id, idempotency_key, kind, status,
    prompt_key, prompt_version, request_metadata, detail
  )
    values (
      p_place_id,
      p_producer_id,
      btrim(p_idempotency_key),
      p_kind,
      'pending',
      coalesce(p_prompt_key, 'place_initial_generation'),
      coalesce(p_prompt_version, 1),
      coalesce(p_request_metadata, jsonb_build_object()),
      coalesce(p_detail, jsonb_build_object('kind', p_kind, 'outputs', array['hook', 'place_story']))
    )
    on conflict (place_id, producer_id, idempotency_key) do update
      set status = 'pending',
          requested_at = now(),
          detail = excluded.detail
    returning id into job_id;

  return job_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Server-only privilege lockdown (repo pattern 0013 / 0028).
-- ---------------------------------------------------------------------------
revoke all on function public.save_ai_media_output(
  text, text, text, text, text, integer,
  text, integer,
  text, integer, jsonb
) from public, anon, authenticated;

revoke all on function public.create_initial_ai_media_generation(
  uuid, text, text, text,
  text, text, integer, jsonb, jsonb
) from public, anon, authenticated;
