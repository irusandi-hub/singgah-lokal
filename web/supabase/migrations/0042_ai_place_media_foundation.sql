-- 0042 — AI PLACE MEDIA: foundation for generated Place media (AI Place Media,
-- SINGGAH LOKAL).
--
-- LOCKED CONTRACT
--   inputs (source photos): place, material, process, result
--   outputs (generated):    hook, place_story
--   source limits:          5 MB, image/jpeg|image/png|image/webp|image/avif
--   regeneration:           initially LOCKED (server-side gate only)
--
-- DESIGN NOTES (locked product + engineering rules honored)
--  - The original 4 photos remain unchanged. Generated media is DERIVED media
--    stored in its own tables + private buckets, so the canonical photo slots
--    (0021 place_photos) and the original uploads are never touched.
--  - AI must not invent factual Place information: generation produces a DRAFT
--    (ai_media.status = 'draft') and NOTHING is published automatically. The
--    only path that may set status = 'approved' or write places.cover_image_url
--    is the explicit Producer approval RPC — never generation.
--  - Generation is Producer-account bound: every row carries the authorized
--    Producer's producer_id, and every RPC re-checks membership against the
--    session-derived user id passed by server code (never a client identity).
--  - Quota/cost controls exist in the schema (ai_media_quota: quota_tokens,
--    used_tokens, last_used_at; claim_ai_media_quota is fail-closed) so the
--    platform can throttle Producer AI usage.
--  - Provider abstraction: the provider is a stored configuration row
--    (ai_media_provider_config), not a hardcoded vendor. This migration makes
--    NO provider call. ai_media records which provider produced an output.
--  - "Generate Ulang" exists in the architecture (ai_media_generation_jobs +
--    regenerate_ai_media RPC) but is LOCKED by server-owned config
--    (ai_media_provider_config.regeneration_enabled = false by default). The
--    lock is enforced inside the database, so no client parameter, header, or
--    cookie can bypass it.
--  - Regeneration generates BOTH outputs (hook + place_story) when eventually
--    unlocked; the job detail records both output keys.
--  - Source media is NEVER public. Sources AND generated outputs live in
--    PRIVATE Supabase Storage buckets. Only an APPROVED output is promoted, by
--    server code, into the public `place-media` bucket so its https URL can be
--    referenced by the Place (cover/story). Every table here is server-only:
--    RLS is enabled with NO policies and ALL client privileges are revoked, so
--    anon/authenticated can neither read nor write any AI media row.
--  - Re-running this migration is a no-op (idempotent DDL).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.ai_media_sources (
  id uuid primary key default gen_random_uuid(),
  place_id text not null references public.places(id) on delete cascade,
  producer_id text not null references public.producers(id) on delete cascade,
  source_key text not null check (source_key in ('place', 'material', 'process', 'result')),
  storage_path text not null check (char_length(storage_path) between 1 and 512),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 5 * 1024 * 1024),
  uploaded_at timestamptz not null default now(),
  unique (place_id, producer_id, source_key)
);

create table if not exists public.ai_media (
  id uuid primary key default gen_random_uuid(),
  place_id text not null references public.places(id) on delete cascade,
  producer_id text not null references public.producers(id) on delete cascade,
  output_key text not null check (output_key in ('hook', 'place_story')),
  storage_path text not null check (char_length(storage_path) between 1 and 512),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/avif')),
  byte_size integer not null check (byte_size > 0 and byte_size <= 5 * 1024 * 1024),
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  provider text check (provider is null or char_length(provider) between 1 and 64),
  provider_token_cost integer not null default 0 check (provider_token_cost >= 0),
  generated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by text,
  -- Public https URL minted at approval time (promoted object). Never set by
  -- generation; only approve_ai_media_output fills it.
  approved_public_url text check (approved_public_url is null or approved_public_url ~* '^https://'),
  rejection_note text check (rejection_note is null or char_length(rejection_note) <= 1000),
  unique (place_id, producer_id, output_key)
);

create table if not exists public.ai_media_provider_config (
  id text primary key default 'primary',
  provider text not null check (char_length(provider) between 1 and 64),
  provider_features text not null default '[]'::text check (char_length(provider_features) <= 2000),
  enabled boolean not null default true,
  -- Server-owned feature gate for "Generate Ulang". Default LOCKED.
  regeneration_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_media_quota (
  producer_id text primary key references public.producers(id) on delete cascade,
  quota_tokens integer not null check (quota_tokens >= 0),
  used_tokens integer not null default 0 check (used_tokens >= 0),
  last_used_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_media_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  place_id text not null references public.places(id) on delete cascade,
  producer_id text not null references public.producers(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  kind text not null default 'regeneration' check (kind in ('initial', 'regeneration')),
  status text not null default 'pending' check (status in ('pending', 'queued', 'running', 'done', 'failed', 'locked')),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 64),
  detail jsonb not null default '{}'::jsonb,
  unique (place_id, producer_id, idempotency_key)
);

create index if not exists ai_media_sources_place_idx on public.ai_media_sources (place_id);
create index if not exists ai_media_sources_producer_idx on public.ai_media_sources (producer_id);
create index if not exists ai_media_place_producer_idx on public.ai_media (place_id, producer_id);
create index if not exists ai_media_generation_jobs_producer_idx on public.ai_media_generation_jobs (producer_id);
create index if not exists ai_media_generation_jobs_status_idx on public.ai_media_generation_jobs (status);

-- ---------------------------------------------------------------------------
-- Server-only lockdown: RLS enabled, no policies, all client privileges
-- revoked. Every read/write goes through server code (service role) after the
-- API layer verified the session's Producer access to the Place. Mirrors the
-- place_claims posture (0028).
-- ---------------------------------------------------------------------------

alter table public.ai_media_sources enable row level security;
alter table public.ai_media enable row level security;
alter table public.ai_media_provider_config enable row level security;
alter table public.ai_media_quota enable row level security;
alter table public.ai_media_generation_jobs enable row level security;

revoke all on public.ai_media_sources from anon, authenticated;
revoke all on public.ai_media from anon, authenticated;
revoke all on public.ai_media_provider_config from anon, authenticated;
revoke all on public.ai_media_quota from anon, authenticated;
revoke all on public.ai_media_generation_jobs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- PRIVATE Storage buckets. Source media is never public; generated outputs are
-- private until an APPROVED output is promoted into the public `place-media`
-- bucket by server code. No storage.objects policy is created, so anon and
-- authenticated get zero direct bucket access — only the service role can
-- read/write these objects. `on conflict do nothing` keeps this idempotent and
-- never rewrites an existing bucket.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ai-media-sources',
  'ai-media-sources',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']::text[]
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ai-media-outputs',
  'ai-media-outputs',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']::text[]
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Security-definer RPCs. search_path pinned. These are SERVER-ONLY: EXECUTE is
-- revoked from public/anon/authenticated at the end of this file, so only the
-- service role (server code) can call them. The caller's session user id is
-- passed explicitly by server code, never by the client.
-- ---------------------------------------------------------------------------

-- The one gate that decides whether "Generate Ulang" may run. Server-owned
-- config; a missing row means LOCKED.
create or replace function public.ai_media_regeneration_unlocked()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select c.regeneration_enabled from public.ai_media_provider_config c where c.id = 'primary'),
    false
  );
$$;

-- Persist (or replace) ONE of the 4 source photos for a Place. Producer-bound:
-- the caller's user id must hold an owner/manager/editor membership for the
-- Place + Producer. Idempotent per (place_id, producer_id, source_key).
create or replace function public.upload_ai_media_source(
  p_user_id uuid,
  p_place_id text,
  p_producer_id text,
  p_source_key text,
  p_storage_path text,
  p_mime_type text,
  p_byte_size integer
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted uuid;
begin
  if p_user_id is null then
    raise exception 'producer_authorization_required';
  end if;
  if p_source_key not in ('place', 'material', 'process', 'result') then
    raise exception 'ai_media_source_key_invalid';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'image/webp', 'image/avif') then
    raise exception 'ai_media_source_type_invalid';
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 5 * 1024 * 1024 then
    raise exception 'ai_media_source_size_invalid';
  end if;
  -- Source objects must live under this Place's private folder.
  if p_storage_path is null or p_storage_path not like ('sources/' || p_place_id || '/%') then
    raise exception 'ai_media_source_upload_failed';
  end if;

  if not exists (
    select 1 from public.producer_memberships m
    where m.user_id = p_user_id
      and m.place_id = p_place_id
      and m.producer_id = p_producer_id
      and m.role in ('owner', 'manager', 'editor')
  ) then
    raise exception 'producer_authorization_required';
  end if;

  insert into public.ai_media_sources (place_id, producer_id, source_key, storage_path, mime_type, byte_size)
    values (p_place_id, p_producer_id, p_source_key, p_storage_path, p_mime_type, p_byte_size)
    on conflict (place_id, producer_id, source_key) do update
      set storage_path = excluded.storage_path,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size,
          uploaded_at = now()
    returning id into inserted;

  return inserted;
end;
$$;

-- Persist a GENERATED output as a DRAFT. This is the server job worker's write
-- path; the client never reaches it. Status is forced to 'draft' — generation
-- can never self-publish, and this RPC never touches the Place cover.
create or replace function public.save_ai_media_output(
  p_place_id text,
  p_producer_id text,
  p_output_key text,
  p_storage_path text,
  p_mime_type text,
  p_byte_size integer,
  p_provider text default null,
  p_provider_token_cost integer default 0
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

  insert into public.ai_media (place_id, producer_id, output_key, storage_path, mime_type, byte_size, status, provider, provider_token_cost)
    values (p_place_id, p_producer_id, p_output_key, p_storage_path, p_mime_type, p_byte_size, 'draft', p_provider, p_provider_token_cost)
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
          approved_public_url = null
    returning id into inserted;

  return inserted;
end;
$$;

-- Approve or reject ONE draft output. This is the ONLY path that may set
-- status = 'approved' and the ONLY path that may write the canonical Place
-- cover. p_public_url is the https URL of the approved output's object,
-- promoted into the public bucket by server code. Hook approval updates
-- places.cover_image_url; place_story approval only stores the asset URL.
create or replace function public.approve_ai_media_output(
  p_user_id uuid,
  p_place_id text,
  p_producer_id text,
  p_output_key text,
  p_status text,
  p_public_url text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.ai_media;
begin
  if p_user_id is null then
    raise exception 'producer_authorization_required';
  end if;
  if p_status not in ('approved', 'rejected') then
    raise exception 'ai_media_status_invalid';
  end if;

  -- Approval is a publication-grade action: owner/manager only.
  if not exists (
    select 1 from public.producer_memberships m
    where m.user_id = p_user_id
      and m.place_id = p_place_id
      and m.producer_id = p_producer_id
      and m.role in ('owner', 'manager')
  ) then
    raise exception 'producer_authorization_required';
  end if;

  select * into row from public.ai_media
    where place_id = p_place_id
      and producer_id = p_producer_id
      and output_key = p_output_key
    for update;

  if not found then
    raise exception 'ai_media_output_not_found';
  end if;

  if row.status <> 'draft' then
    raise exception 'ai_media_output_not_draft';
  end if;

  if p_status = 'approved' then
    -- Publishing requires a real public https URL; fail closed otherwise.
    if p_public_url is null or p_public_url !~* '^https://' then
      raise exception 'ai_media_output_public_url_invalid';
    end if;

    update public.ai_media
      set status = 'approved',
          approved_at = now(),
          approved_by = p_user_id::text,
          approved_public_url = p_public_url
      where id = row.id;

    -- Hook approval is the ONLY path that updates the canonical Place cover.
    -- Generated outputs are derived media; they never auto-publish.
    if p_output_key = 'hook' then
      update public.places
        set cover_image_url = p_public_url
        where id = p_place_id;
    end if;
  else
    update public.ai_media
      set status = 'rejected',
          approved_at = now(),
          approved_by = p_user_id::text,
          approved_public_url = null
      where id = row.id;
  end if;

  return true;
end;
$$;

-- Generate Ulang. Architecturally present; LOCKED by server-owned config until
-- unlocked. When unlocked it records a job that must produce BOTH outputs
-- (hook + place_story). Client code cannot reach this RPC (EXECUTE revoked) and
-- cannot flip the config flag.
create or replace function public.regenerate_ai_media(
  p_user_id uuid,
  p_place_id text,
  p_producer_id text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  job_id uuid;
begin
  if p_user_id is null then
    raise exception 'producer_authorization_required';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'ai_media_generation_locked';
  end if;

  if not exists (
    select 1 from public.producer_memberships m
    where m.user_id = p_user_id
      and m.place_id = p_place_id
      and m.producer_id = p_producer_id
      and m.role in ('owner', 'manager', 'editor')
  ) then
    raise exception 'producer_authorization_required';
  end if;

  -- Server-owned lock. The client cannot bypass it by any parameter/header.
  if not public.ai_media_regeneration_unlocked() then
    raise exception 'ai_media_regeneration_locked';
  end if;

  -- Regeneration generates BOTH outputs (hook + place_story).
  insert into public.ai_media_generation_jobs (place_id, producer_id, idempotency_key, kind, status, detail)
    values (
      p_place_id,
      p_producer_id,
      btrim(p_idempotency_key),
      'regeneration',
      'queued',
      '{"outputs":["hook","place_story"],"regeneration":true}'::jsonb
    )
    on conflict (place_id, producer_id, idempotency_key) do update
      set status = 'queued',
          requested_at = now(),
          detail = excluded.detail
    returning id into job_id;

  return job_id;
end;
$$;

-- Producer-side quota/cost control: claim tokens for a generation attempt.
-- Fail-closed: raises when quota is exhausted or unconfigured, so the platform
-- never carries uncontrolled Producer AI cost.
create or replace function public.claim_ai_media_quota(
  p_producer_id text,
  p_token_count integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.ai_media_quota;
begin
  if p_token_count is null or p_token_count <= 0 then
    raise exception 'ai_media_quota_invalid';
  end if;

  select * into row from public.ai_media_quota where producer_id = p_producer_id for update;
  if not found then
    raise exception 'ai_media_quota_exhausted';
  end if;

  if row.quota_tokens <= 0 or row.used_tokens + p_token_count > row.quota_tokens then
    raise exception 'ai_media_quota_exhausted';
  end if;

  update public.ai_media_quota
    set used_tokens = used_tokens + p_token_count,
        last_used_at = now(),
        updated_at = now()
    where producer_id = p_producer_id;

  return true;
end;
$$;

-- Service-role bootstrap for a Producer quota (dev/admin only). Production
-- grants are admin-controlled; no client can call this (EXECUTE revoked).
create or replace function public.set_ai_media_quota(
  p_producer_id text,
  p_quota_tokens integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_quota_tokens is null or p_quota_tokens < 0 then
    raise exception 'ai_media_quota_invalid';
  end if;
  if not exists (select 1 from public.producers p where p.id = p_producer_id) then
    raise exception 'ai_media_quota_invalid';
  end if;
  insert into public.ai_media_quota (producer_id, quota_tokens, used_tokens, updated_at)
    values (p_producer_id, p_quota_tokens, 0, now())
    on conflict (producer_id) do update
      set quota_tokens = excluded.quota_tokens,
          used_tokens = 0,
          updated_at = now();
end;
$$;

-- Server-only privilege lockdown (repo pattern 0013 / 0028).
revoke all on function public.ai_media_regeneration_unlocked() from public, anon, authenticated;
revoke all on function public.upload_ai_media_source(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.save_ai_media_output(text, text, text, text, text, integer, text, integer) from public, anon, authenticated;
revoke all on function public.approve_ai_media_output(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.regenerate_ai_media(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_ai_media_quota(text, integer) from public, anon, authenticated;
revoke all on function public.set_ai_media_quota(text, integer) from public, anon, authenticated;
