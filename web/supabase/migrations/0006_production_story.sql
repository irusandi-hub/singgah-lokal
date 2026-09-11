create table if not exists public.production_stages (
  id text primary key,
  place_id text not null references public.places(id) on delete cascade,
  title text not null,
  description text not null,
  sort_order integer not null check (sort_order >= 0),
  status text not null default 'draft' check (status in ('draft', 'review', 'published', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (place_id, sort_order)
);

create table if not exists public.production_stage_experiences (
  production_stage_id text not null references public.production_stages(id) on delete cascade,
  experience_id text not null references public.experiences(id) on delete cascade,
  primary key (production_stage_id, experience_id)
);

create index if not exists production_stages_place_order_idx on public.production_stages (place_id, sort_order, id);

alter table public.production_stages enable row level security;
alter table public.production_stage_experiences enable row level security;

create policy production_stages_public_read on public.production_stages for select using (
  status = 'published' and exists (select 1 from public.places p where p.id = production_stages.place_id and p.publication_status = 'published')
);
create policy production_stages_producer_read on public.production_stages for select using (
  exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = production_stages.place_id and m.role in ('owner', 'manager', 'editor'))
);
create policy production_stages_producer_insert on public.production_stages for insert with check (
  exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = production_stages.place_id and m.role in ('owner', 'manager', 'editor'))
);
create policy production_stages_producer_update on public.production_stages for update using (
  exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = production_stages.place_id and m.role in ('owner', 'manager', 'editor'))
) with check (
  exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = production_stages.place_id and m.role in ('owner', 'manager', 'editor'))
);

create policy production_stage_experiences_public_read on public.production_stage_experiences for select using (
  exists (select 1 from public.production_stages s join public.places p on p.id = s.place_id where s.id = production_stage_experiences.production_stage_id and s.status = 'published' and p.publication_status = 'published')
);
create policy production_stage_experiences_producer_access on public.production_stage_experiences for all using (
  exists (select 1 from public.production_stages s join public.producer_memberships m on m.place_id = s.place_id where s.id = production_stage_experiences.production_stage_id and m.user_id = auth.uid() and m.role in ('owner', 'manager', 'editor'))
) with check (
  exists (select 1 from public.production_stages s join public.producer_memberships m on m.place_id = s.place_id where s.id = production_stage_experiences.production_stage_id and m.user_id = auth.uid() and m.role in ('owner', 'manager', 'editor'))
);

create or replace function public.prevent_editor_production_stage_publication()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = old.place_id and m.role = 'editor')
    and old.status not in ('draft', 'review') then
    raise exception 'Editor cannot edit published Production Stage';
  end if;
  if exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = new.place_id and m.role = 'editor')
    and new.status not in ('draft', 'review') then
    raise exception 'Editor cannot publish or archive Production Stage';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.place_id is distinct from old.place_id) then
    raise exception 'Production Stage identity is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.prevent_cross_place_production_stage_experience()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.production_stages s
    join public.experiences e on e.place_id = s.place_id
    where s.id = new.production_stage_id and e.id = new.experience_id
  ) then
    raise exception 'Production Stage Experience must belong to the same Place';
  end if;
  return new;
end;
$$;

drop trigger if exists production_stage_identity_and_publication on public.production_stages;
create trigger production_stage_identity_and_publication before insert or update on public.production_stages
for each row execute procedure public.prevent_editor_production_stage_publication();

drop trigger if exists production_stage_experience_place_guard on public.production_stage_experiences;
create trigger production_stage_experience_place_guard before insert or update on public.production_stage_experiences
for each row execute procedure public.prevent_cross_place_production_stage_experience();

create or replace function public.reorder_production_stages(p_place_id text, p_stage_ids text[])
returns void language plpgsql security invoker set search_path = public as $$
declare
  stage_id text;
  stage_index integer := 0;
begin
  if not exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = p_place_id and m.role in ('owner', 'manager', 'editor')) then
    raise exception 'Producer authorization is required';
  end if;
  if (select count(*) from public.production_stages where place_id = p_place_id) <> coalesce(array_length(p_stage_ids, 1), 0)
    or (select count(distinct requested.id) from unnest(p_stage_ids) requested(id)) <> coalesce(array_length(p_stage_ids, 1), 0)
    or exists (select 1 from unnest(p_stage_ids) requested(id) left join public.production_stages s on s.id = requested.id and s.place_id = p_place_id where s.id is null) then
    raise exception 'Production Stage order must include each Place stage exactly once';
  end if;
  update public.production_stages s
  set sort_order = 1000000 + ordering.row_number
  from (
    select id, row_number() over (order by id)::integer as row_number
    from public.production_stages
    where place_id = p_place_id
  ) ordering
  where s.id = ordering.id and s.place_id = p_place_id;
  foreach stage_id in array p_stage_ids loop
    update public.production_stages set sort_order = stage_index, updated_at = now() where id = stage_id and place_id = p_place_id;
    stage_index := stage_index + 1;
  end loop;
end;
$$;