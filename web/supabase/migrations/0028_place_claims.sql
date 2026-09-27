-- 0028 — PLACE CLAIM: a Producer claims an EXISTING Place (PO request).
--
-- Scope (locked by the PO for this task):
-- - A claim NEVER creates a Place and NEVER edits a Place. It only files a
--   request row for an existing Place that has no active ownership.
-- - The canonical Place (name, category, type, area) is read as-is; the claim
--   path has no category selector and never writes a Place column.
-- - Filing a claim grants NOTHING. The Place stays unowned while the claim is
--   'pending' and stays unowned after 'rejected'. Ownership is granted only by
--   'approved' — the single path that inserts the existing ownership
--   authorization row (producer_memberships), exactly like the Create Place
--   and Producer Application paths.
-- - Proof of ownership is MANDATORY and lives in a PRIVATE Supabase Storage
--   bucket. No public URL is ever produced for it; no storage.objects policy
--   is created, so clients have zero direct bucket access and every read is
--   minted server-side after an authorization check.
--
-- Ownership model (unchanged, reused as-is): a Place is owned when it has at
-- least one producer_memberships row, or a non-null places.producer_id. That
-- definition is the single one used by the claim list, the claim submit gate,
-- and the approval gate, so the list can never offer a Place that the submit
-- API would then refuse.
--
-- Race guard: the submit and the approval paths both take a row lock on the
-- Place (`select ... for update`). Two approvals for the same Place therefore
-- serialize, and the loser re-reads ownership inside the lock and is refused
-- with 'place_already_owned' — so a Place can never end up with two ownership
-- grants. A partial unique index additionally caps one active claim per
-- account. Both are additive; no existing table, policy, or function body is
-- altered, and re-running this migration is a no-op.

create table if not exists public.place_claims (
  id uuid primary key default gen_random_uuid(),
  place_id text not null references public.places(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  -- Private storage object reference (bucket is private; no public URL).
  evidence_path text not null
    check (char_length(evidence_path) between 1 and 512 and evidence_path !~ '^/'),
  evidence_file_name text check (evidence_file_name is null or char_length(evidence_file_name) <= 255),
  evidence_mime_type text check (evidence_mime_type is null or char_length(evidence_mime_type) <= 120),
  evidence_size_bytes integer check (evidence_size_bytes is null or evidence_size_bytes > 0),
  note text check (note is null or char_length(note) <= 1000),
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists place_claims_place_created_idx
on public.place_claims (place_id, created_at);

create index if not exists place_claims_user_created_idx
on public.place_claims (user_id, created_at);

-- One ACTIVE claim per account: a second filing while a pending/approved
-- claim exists is refused by the RPC and, if a race slips past it, by this
-- index. A rejected claim does not block a refile.
create unique index if not exists place_claims_one_active_per_user_idx
on public.place_claims (user_id)
where status in ('pending', 'approved');

-- Fail-closed RLS: no policies on purpose, mirroring producer_applications
-- (0016). Claims and their evidence references are read/written only through
-- server code (service-role), after the API layer verified the session.
alter table public.place_claims enable row level security;
revoke all on public.place_claims from anon, authenticated;

-- PRIVATE proof-of-ownership bucket. The existing `place-media` bucket is
-- PUBLIC by design (0018/0021 cover + slot photos render with the Place), so
-- it cannot hold ownership documents: a private bucket is the one piece of
-- infrastructure that genuinely cannot be reused. `on conflict do nothing`
-- keeps this idempotent and never rewrites an existing bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'place-claim-evidence',
  'place-claim-evidence',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']::text[]
)
on conflict (id) do nothing;

-- NOTE: no policy is created on storage.objects for this bucket. With RLS on
-- and zero policies, anon/authenticated can neither read nor write any
-- evidence object; only the service role (server code) can. No public URL is
-- built for the bucket anywhere in the codebase.

-- The one ownership predicate shared by the list, the submit gate and the
-- approval gate. Revoked from clients like every function below.
create or replace function public.place_has_active_ownership(p_place_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.producer_memberships m where m.place_id = p_place_id
  ) or exists (
    select 1 from public.places p where p.id = p_place_id and p.producer_id is not null
  );
$$;

-- Claim list: ONLY Places without active ownership. The filter is server-side
-- and lives inside the database, so it cannot be bypassed by calling the API
-- directly, and it returns canonical Place data only (no category is settable
-- here — the Producer never chooses or changes it).
create or replace function public.list_claimable_places()
returns table (
  place_id text,
  name text,
  short_description text,
  category text,
  type text,
  area text,
  publication_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.name, p.short_description, p.category, p.type, p.area, p.publication_status
  from public.places p
  where not public.place_has_active_ownership(p.id)
  order by p.name, p.id;
$$;

-- File a claim. Server-side only: the API layer passes the SESSION's user id,
-- never a client-supplied identity, and uploads the proof to the private
-- bucket before calling this. Granting nothing is the point — the insert is
-- status 'pending' and no membership row is written here.
create or replace function public.submit_place_claim(
  p_user_id uuid,
  p_place_id text,
  p_evidence_path text,
  p_evidence_file_name text default null,
  p_evidence_mime_type text default null,
  p_evidence_size_bytes integer default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id uuid;
begin
  if p_user_id is null then
    raise exception 'place_claim_user_required';
  end if;

  -- Proof of ownership is mandatory: a claim without evidence is refused.
  if p_evidence_path is null or length(btrim(p_evidence_path)) = 0 then
    raise exception 'place_claim_evidence_required';
  end if;

  -- Row lock on the Place serializes this gate with the approval gate, so a
  -- Place cannot become owned between the ownership check and the insert.
  perform 1 from public.places where id = p_place_id for update;
  if not found then
    raise exception 'place_not_found';
  end if;

  -- Direct API guard: an owned Place is never claimable, even if the caller
  -- skipped the list entirely.
  if public.place_has_active_ownership(p_place_id) then
    raise exception 'place_already_owned';
  end if;

  -- Idempotency guard: one active claim per account (mirrors 0016).
  if exists (
    select 1 from public.place_claims
    where user_id = p_user_id and status in ('pending', 'approved')
  ) then
    raise exception 'place_claim_already_active';
  end if;

  insert into public.place_claims (
    user_id, place_id, status, evidence_path,
    evidence_file_name, evidence_mime_type, evidence_size_bytes, note
  )
  values (
    p_user_id, p_place_id, 'pending', btrim(p_evidence_path),
    p_evidence_file_name, p_evidence_mime_type, p_evidence_size_bytes, p_note
  )
  returning id into v_claim_id;

  -- Explicitly NOT granted here: producer_memberships. Ownership waits for
  -- review_place_claim('approved').
  return v_claim_id;
end;
$$;

-- The caller's OWN claims, with the canonical Place name. Scoped by the
-- session-derived user id on the server, so one Producer can never read
-- another Producer's claim row (and therefore never their evidence).
create or replace function public.list_user_place_claims(p_user_id uuid)
returns table (
  id uuid,
  place_id text,
  place_name text,
  category text,
  type text,
  status text,
  evidence_path text,
  evidence_file_name text,
  evidence_mime_type text,
  evidence_size_bytes integer,
  created_at timestamptz,
  reviewed_at timestamptz,
  review_note text
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.place_id, p.name, p.category, p.type, c.status, c.evidence_path,
         c.evidence_file_name, c.evidence_mime_type, c.evidence_size_bytes,
         c.created_at, c.reviewed_at, c.review_note
  from public.place_claims c
  join public.places p on p.id = c.place_id
  where c.user_id = p_user_id
  order by c.created_at desc;
$$;

-- Review queue for the Admin Center. Returns the claimed Place with its
-- canonical category/type, the claimant, the private evidence reference, the
-- submission time and the status — the minimum an Admin needs to assess it.
-- Callers must have passed the Platform Moderator guard first.
create or replace function public.list_place_claims_for_review(p_status text default null)
returns table (
  id uuid,
  place_id text,
  place_name text,
  category text,
  type text,
  user_id uuid,
  status text,
  evidence_path text,
  evidence_file_name text,
  evidence_mime_type text,
  evidence_size_bytes integer,
  note text,
  created_at timestamptz,
  reviewed_at timestamptz,
  review_note text
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.place_id, p.name, p.category, p.type, c.user_id, c.status, c.evidence_path,
         c.evidence_file_name, c.evidence_mime_type, c.evidence_size_bytes, c.note,
         c.created_at, c.reviewed_at, c.review_note
  from public.place_claims c
  join public.places p on p.id = c.place_id
  where p_status is null or c.status = p_status
  order by case when c.status = 'pending' then 0 else 1 end, c.created_at desc;
$$;

-- Admin decision. This is the ONLY path that turns a claim into ownership.
-- 'rejected' never touches producer_memberships. 'approved' inserts the
-- existing ownership authorization row (role 'owner') for the CLAIMANT'S
-- user_id — the same account, no new auth user, no new credential.
create or replace function public.review_place_claim(
  p_claim_id uuid,
  p_decision text,
  p_review_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.place_claims;
  v_producer_id text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'place_claim_decision_invalid';
  end if;

  select * into v_claim from public.place_claims where id = p_claim_id for update;
  if not found or v_claim.status <> 'pending' then
    raise exception 'place_claim_not_pending';
  end if;

  if p_decision = 'approved' then
    -- Row lock on the Place serializes concurrent approvals: the second
    -- approval of the same Place re-reads ownership inside the lock and is
    -- refused, so duplicate ownership is impossible.
    perform 1 from public.places where id = v_claim.place_id for update;
    if not found then
      raise exception 'place_not_found';
    end if;

    if public.place_has_active_ownership(v_claim.place_id) then
      raise exception 'place_already_owned';
    end if;

    -- Ownership binding follows the existing model: the Place's own producer
    -- identity, else the claimant's existing producer identity. No Producer
    -- record is invented here.
    select producer_id into v_producer_id from public.places where id = v_claim.place_id;
    if v_producer_id is null then
      select m.producer_id into v_producer_id
      from public.producer_memberships m
      where m.user_id = v_claim.user_id
      order by m.created_at
      limit 1;
    end if;
    if v_producer_id is null then
      raise exception 'place_claim_producer_identity_unavailable';
    end if;

    insert into public.producer_memberships (user_id, producer_id, place_id, role)
    values (v_claim.user_id, v_producer_id, v_claim.place_id, 'owner');
  end if;

  update public.place_claims
  set status = p_decision,
      review_note = p_review_note,
      reviewed_at = now(),
      updated_at = now()
  where id = p_claim_id;
end;
$$;

revoke all on function public.place_has_active_ownership(text) from public, anon, authenticated;
revoke all on function public.list_claimable_places() from public, anon, authenticated;
revoke all on function public.submit_place_claim(uuid, text, text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.list_user_place_claims(uuid) from public, anon, authenticated;
revoke all on function public.list_place_claims_for_review(text) from public, anon, authenticated;
revoke all on function public.review_place_claim(uuid, text, text) from public, anon, authenticated;
