alter table public.places
  add column if not exists address text not null default '',
  add column if not exists contact_information text not null default '';

create index if not exists places_producer_id_idx on public.places (producer_id);

create policy places_producer_insert on public.places
for insert with check (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.producer_id = places.producer_id and m.role = 'owner'
  )
);

create policy places_producer_update on public.places
for update using (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = places.id and m.role in ('owner', 'manager', 'editor')
  )
) with check (
  exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = places.id and m.role in ('owner', 'manager', 'editor')
  )
);

create or replace function public.prevent_editor_place_restricted_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid() and m.place_id = old.id and m.role = 'editor'
  ) and (
    new.area is distinct from old.area or
    new.address is distinct from old.address or
    new.contact_information is distinct from old.contact_information or
    new.timezone is distinct from old.timezone or
    new.currency is distinct from old.currency or
    new.latitude is distinct from old.latitude or
    new.longitude is distinct from old.longitude or
    new.publication_status is distinct from old.publication_status
  ) then
    raise exception 'Editor cannot change restricted Place fields';
  end if;
  return new;
end;
$$;

drop trigger if exists editor_place_restricted_change on public.places;
create trigger editor_place_restricted_change
before update on public.places
for each row execute procedure public.prevent_editor_place_restricted_change();