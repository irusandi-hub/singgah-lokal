create or replace function public.create_production_stage(
  p_id text,
  p_place_id text,
  p_title text,
  p_description text,
  p_experience_ids text[] default '{}'
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  next_sort_order integer;
  requested_experience_ids text[] := coalesce(p_experience_ids, '{}');
begin
  if not exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = p_place_id and m.role in ('owner', 'manager', 'editor')
  ) then
    raise exception 'Producer authorization is required';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or p_title is null or p_description is null or char_length(trim(p_title)) = 0 or char_length(trim(p_description)) = 0 then
    raise exception 'Production Stage content is invalid';
  end if;
  if coalesce(array_length(requested_experience_ids, 1), 0) <> (select count(distinct id) from unnest(requested_experience_ids) requested(id)) then
    raise exception 'Production Stage Experiences must be unique';
  end if;
  if exists (
    select 1 from unnest(requested_experience_ids) requested(id)
    left join public.experiences e on e.id = requested.id and e.place_id = p_place_id
    where e.id is null
  ) then
    raise exception 'Production Stage Experience does not belong to Place';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_place_id, 0));
  select coalesce(max(sort_order), -1) + 1 into next_sort_order
  from public.production_stages
  where place_id = p_place_id;

  insert into public.production_stages (id, place_id, title, description, sort_order, status)
  values (p_id, p_place_id, trim(p_title), trim(p_description), next_sort_order, 'draft');

  insert into public.production_stage_experiences (production_stage_id, experience_id)
  select p_id, requested.id from unnest(requested_experience_ids) requested(id);
end;
$$;

create or replace function public.update_production_stage(
  p_id text,
  p_place_id text,
  p_title text,
  p_description text,
  p_experience_ids text[] default '{}'
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  requested_experience_ids text[] := coalesce(p_experience_ids, '{}');
begin
  if not exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = p_place_id and m.role in ('owner', 'manager', 'editor')
  ) then
    raise exception 'Producer authorization is required';
  end if;
  if not exists (select 1 from public.production_stages s where s.id = p_id and s.place_id = p_place_id) then
    raise exception 'Production Stage not found';
  end if;
  if char_length(trim(p_title)) = 0 or char_length(trim(p_description)) = 0 then
    raise exception 'Production Stage content is invalid';
  end if;
  if coalesce(array_length(requested_experience_ids, 1), 0) <> (select count(distinct id) from unnest(requested_experience_ids) requested(id)) then
    raise exception 'Production Stage Experiences must be unique';
  end if;
  if exists (
    select 1 from unnest(requested_experience_ids) requested(id)
    left join public.experiences e on e.id = requested.id and e.place_id = p_place_id
    where e.id is null
  ) then
    raise exception 'Production Stage Experience does not belong to Place';
  end if;

  update public.production_stages
  set title = trim(p_title), description = trim(p_description), updated_at = now()
  where id = p_id and place_id = p_place_id;

  delete from public.production_stage_experiences where production_stage_id = p_id;
  insert into public.production_stage_experiences (production_stage_id, experience_id)
  select p_id, requested.id from unnest(requested_experience_ids) requested(id);
end;
$$;
