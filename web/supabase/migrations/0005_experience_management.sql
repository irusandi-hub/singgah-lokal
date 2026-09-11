alter table public.experience_schedules
  add constraint experience_schedules_day_of_week_check
  check (day_of_week in ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'));

create policy experiences_producer_insert on public.experiences
for insert with check (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = experiences.place_id and m.role in ('owner', 'manager', 'editor')
  )
);

create policy experiences_producer_update on public.experiences
for update using (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = experiences.place_id and m.role in ('owner', 'manager', 'editor')
  )
) with check (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = experiences.place_id and m.role in ('owner', 'manager', 'editor')
  )
);

create policy schedules_producer_insert on public.experience_schedules
for insert with check (
  exists (
    select 1 from public.experiences e
    join public.producer_memberships m on m.place_id = e.place_id
    where e.id = experience_schedules.experience_id and m.user_id = auth.uid() and m.role in ('owner', 'manager', 'editor')
  )
);

create policy schedules_producer_update on public.experience_schedules
for update using (
  exists (
    select 1 from public.experiences e
    join public.producer_memberships m on m.place_id = e.place_id
    where e.id = experience_schedules.experience_id and m.user_id = auth.uid() and m.role in ('owner', 'manager', 'editor')
  )
) with check (
  exists (
    select 1 from public.experiences e
    join public.producer_memberships m on m.place_id = e.place_id
    where e.id = experience_schedules.experience_id and m.user_id = auth.uid() and m.role in ('owner', 'manager', 'editor')
  )
);

create policy schedules_producer_delete on public.experience_schedules
for delete using (
  exists (
    select 1 from public.experiences e
    join public.producer_memberships m on m.place_id = e.place_id
    where e.id = experience_schedules.experience_id and m.user_id = auth.uid() and m.role in ('owner', 'manager', 'editor')
  )
);

create or replace function public.prevent_editor_experience_restricted_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = old.place_id and m.role = 'editor'
  ) and (
    new.duration_minutes is distinct from old.duration_minutes or
    new.capacity is distinct from old.capacity or
    new.min_party_size is distinct from old.min_party_size or
    new.max_party_size is distinct from old.max_party_size or
    new.age_requirement is distinct from old.age_requirement or
    new.meeting_point is distinct from old.meeting_point or
    new.status is distinct from old.status or
    new.publication_status is distinct from old.publication_status
  ) then
    raise exception 'Editor cannot change restricted Experience fields';
  end if;
  if new.place_id is distinct from old.place_id then
    raise exception 'Experience Place is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists experience_restricted_change on public.experiences;
create trigger experience_restricted_change
before update on public.experiences
for each row execute procedure public.prevent_editor_experience_restricted_change();

create or replace function public.prevent_editor_schedule_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  place_id text;
begin
  select e.place_id into place_id from public.experiences e where e.id = coalesce(new.experience_id, old.experience_id);
  if exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = place_id and m.role = 'editor'
  ) then
    raise exception 'Editor cannot change Experience schedules';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists editor_schedule_update on public.experience_schedules;
create trigger editor_schedule_update
before update on public.experience_schedules
for each row execute procedure public.prevent_editor_schedule_change();

drop trigger if exists editor_schedule_delete on public.experience_schedules;
create trigger editor_schedule_delete
before delete on public.experience_schedules
for each row execute procedure public.prevent_editor_schedule_change();