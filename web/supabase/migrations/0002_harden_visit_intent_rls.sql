create or replace function public.validate_visit_intent_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.producer_response_note is not null then
      raise exception 'Visit Intent must start pending without a Producer response';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.place_id is distinct from old.place_id
    or new.experience_id is distinct from old.experience_id
    or new.requested_date is distinct from old.requested_date
    or new.requested_start_time is distinct from old.requested_start_time
    or new.requested_end_time is distinct from old.requested_end_time
    or new.party_size is distinct from old.party_size
    or new.optional_note is distinct from old.optional_note
    or new.timezone is distinct from old.timezone
    or new.idempotency_key is distinct from old.idempotency_key
    or new.created_at is distinct from old.created_at then
    raise exception 'Visit Intent creation fields are immutable';
  end if;

  if not (
    (old.status = 'pending' and new.status in ('accepted', 'declined', 'requires_confirmation'))
    or (old.status = 'requires_confirmation' and new.status in ('accepted', 'declined', 'requires_confirmation'))
  ) then
    raise exception 'Invalid Visit Intent status transition';
  end if;

  return new;
end;
$$;

drop trigger if exists visit_intent_write_validation on public.visit_intents;
create trigger visit_intent_write_validation
before insert or update on public.visit_intents
for each row execute procedure public.validate_visit_intent_write();

drop policy if exists visit_intents_user_insert on public.visit_intents;
create policy visit_intents_user_insert on public.visit_intents
for insert
with check (
  user_id = auth.uid()
  and status = 'pending'
  and producer_response_note is null
  and exists (
    select 1
    from public.experiences e
    join public.places p on p.id = e.place_id
    where e.id = visit_intents.experience_id
      and e.place_id = visit_intents.place_id
      and e.status = 'published'
      and e.publication_status = 'published'
      and p.publication_status = 'published'
      and visit_intents.timezone = p.timezone
  )
);

drop policy if exists visit_intents_producer_update on public.visit_intents;
create policy visit_intents_producer_update on public.visit_intents
for update
using (
  exists (
    select 1
    from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = visit_intents.place_id
      and m.role in ('owner', 'manager')
  )
)
with check (
  exists (
    select 1
    from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = visit_intents.place_id
      and m.role in ('owner', 'manager')
  )
);

revoke insert on public.visit_intents from authenticated;
grant insert (
  id,
  user_id,
  place_id,
  experience_id,
  requested_date,
  requested_start_time,
  requested_end_time,
  party_size,
  optional_note,
  timezone,
  idempotency_key
) on public.visit_intents to authenticated;

revoke update on public.visit_intents from authenticated;
grant update (status, producer_response_note, updated_at)
on public.visit_intents to authenticated;