create or replace function public.validate_place_timezone()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid Place timezone: %', new.timezone;
  end if;
  return new;
end;
$$;

drop trigger if exists place_timezone_validation on public.places;
create trigger place_timezone_validation
before insert or update of timezone on public.places
for each row execute procedure public.validate_place_timezone();

alter table public.experiences
  add constraint experiences_id_place_id_key unique (id, place_id);

alter table public.visit_intents
  add constraint visit_intents_experience_place_fkey
  foreign key (experience_id, place_id)
  references public.experiences (id, place_id);

create or replace function public.validate_experience_schedule_timezone()
returns trigger
language plpgsql
as $$
declare
  place_timezone text;
begin
  select p.timezone into place_timezone
  from public.experiences e
  join public.places p on p.id = e.place_id
  where e.id = new.experience_id;

  if place_timezone is null or new.timezone <> place_timezone then
    raise exception 'Experience schedule timezone must match its Place timezone';
  end if;
  return new;
end;
$$;

drop trigger if exists experience_schedule_timezone_validation on public.experience_schedules;
create trigger experience_schedule_timezone_validation
before insert or update of experience_id, timezone on public.experience_schedules
for each row execute procedure public.validate_experience_schedule_timezone();

create or replace function public.validate_visit_intent_timezone()
returns trigger
language plpgsql
as $$
declare
  place_timezone text;
begin
  select timezone into place_timezone
  from public.places
  where id = new.place_id;

  if place_timezone is null or new.timezone <> place_timezone then
    raise exception 'Visit Intent timezone must match its Place timezone';
  end if;
  return new;
end;
$$;

drop trigger if exists visit_intent_timezone_validation on public.visit_intents;
create trigger visit_intent_timezone_validation
before insert or update of place_id, timezone on public.visit_intents
for each row execute procedure public.validate_visit_intent_timezone();

alter table public.visit_intents
  add constraint visit_intents_idempotency_key_not_blank
  check (length(btrim(idempotency_key)) > 0);

create index if not exists experiences_place_id_idx on public.experiences (place_id);
create index if not exists experience_schedules_experience_id_idx on public.experience_schedules (experience_id);
create index if not exists producer_memberships_user_place_idx on public.producer_memberships (user_id, place_id);
create index if not exists visit_intents_user_id_created_at_idx on public.visit_intents (user_id, created_at desc);
create index if not exists visit_intents_place_id_created_at_idx on public.visit_intents (place_id, created_at desc);