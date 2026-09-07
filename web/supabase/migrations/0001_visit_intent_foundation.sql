create extension if not exists pgcrypto;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create table public.producers (
  id text primary key,
  display_name text not null,
  claim_status text not null default 'unverified' check (claim_status in ('unverified', 'claimed', 'verified')),
  created_at timestamptz not null default now()
);

create table public.places (
  id text primary key,
  name text not null,
  short_description text not null,
  category text not null,
  type text not null check (type in ('production', 'experience')),
  area text not null,
  timezone text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  latitude double precision,
  longitude double precision,
  producer_id text references public.producers(id),
  claim_status text not null default 'unverified' check (claim_status in ('unverified', 'claimed', 'verified')),
  publication_status text not null default 'published' check (publication_status in ('draft', 'published', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180)
);

create table public.experiences (
  id text primary key,
  place_id text not null references public.places(id),
  title text not null,
  short_description text not null,
  description text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  capacity integer check (capacity is null or capacity > 0),
  min_party_size integer not null check (min_party_size >= 1),
  max_party_size integer not null check (max_party_size >= min_party_size),
  age_requirement text,
  prerequisites text[] not null default '{}',
  meeting_point text not null,
  highlights text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'published', 'paused', 'archived')),
  publication_status text not null default 'draft' check (publication_status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.experience_schedules (
  id uuid primary key default gen_random_uuid(),
  experience_id text not null references public.experiences(id) on delete cascade,
  day_of_week text not null,
  start_time time not null,
  end_time time not null,
  timezone text not null,
  status text not null check (status in ('available', 'not_available', 'requires_confirmation')),
  check (start_time < end_time)
);

create table public.producer_memberships (
  user_id uuid not null references public.users(id) on delete cascade,
  producer_id text not null references public.producers(id) on delete cascade,
  place_id text not null references public.places(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'editor')),
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);

create table public.visit_intents (
  id text primary key,
  user_id uuid not null references public.users(id),
  place_id text not null references public.places(id),
  experience_id text not null references public.experiences(id),
  requested_date date not null,
  requested_start_time time not null,
  requested_end_time time not null,
  party_size integer not null check (party_size >= 1),
  optional_note text check (optional_note is null or char_length(optional_note) <= 500),
  timezone text not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'requires_confirmation', 'cancelled', 'expired')),
  producer_response_note text check (producer_response_note is null or char_length(producer_response_note) <= 1000),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  check (requested_start_time < requested_end_time)
);

create unique index visit_intents_active_duplicate_idx
on public.visit_intents (user_id, place_id, experience_id, requested_date, requested_start_time, requested_end_time)
where status in ('pending', 'requires_confirmation', 'accepted');

create table public.visit_intent_status_history (
  id uuid primary key default gen_random_uuid(),
  visit_intent_id text not null references public.visit_intents(id) on delete cascade,
  status text not null check (status in ('pending', 'accepted', 'declined', 'requires_confirmation', 'cancelled', 'expired')),
  actor_user_id uuid references public.users(id),
  response_note text,
  created_at timestamptz not null default now()
);

create or replace function public.record_visit_intent_status()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    insert into public.visit_intent_status_history (visit_intent_id, status, actor_user_id, response_note)
    values (new.id, new.status, auth.uid(), new.producer_response_note);
  end if;
  return new;
end;
$$;

create or replace trigger visit_intent_status_history_on_insert
after insert on public.visit_intents
for each row execute procedure public.record_visit_intent_status();

create or replace trigger visit_intent_status_history_on_update
after update on public.visit_intents
for each row execute procedure public.record_visit_intent_status();

create or replace function public.prevent_visit_intent_identity_change()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.place_id is distinct from old.place_id
    or new.experience_id is distinct from old.experience_id
    or new.requested_date is distinct from old.requested_date
    or new.requested_start_time is distinct from old.requested_start_time
    or new.requested_end_time is distinct from old.requested_end_time
    or new.party_size is distinct from old.party_size
    or new.timezone is distinct from old.timezone
    or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'Visit Intent identity fields are immutable';
  end if;
  return new;
end;
$$;

create or replace trigger visit_intent_identity_immutable
before update on public.visit_intents
for each row execute procedure public.prevent_visit_intent_identity_change();

insert into public.places (id, name, short_description, category, type, area, timezone, currency, latitude, longitude, claim_status, publication_status)
values
  ('kopi-dari-kebun', 'Kopi dari Kebun', 'Temukan cerita dan produksi lokal dari tempat ini.', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', null, null, 'unverified', 'published'),
  ('rumah-teh-lokal', 'Rumah Teh Lokal', 'Temukan cerita dan produksi lokal dari tempat ini.', 'Teh', 'experience', 'Lembang', 'Asia/Jakarta', 'IDR', null, null, 'unverified', 'published'),
  ('dapur-rasa', 'Dapur Rasa', 'Temukan cerita dan produksi lokal dari tempat ini.', 'Kuliner', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', null, null, 'unverified', 'published')
on conflict (id) do nothing;

insert into public.experiences (id, place_id, title, short_description, description, duration_minutes, capacity, min_party_size, max_party_size, age_requirement, prerequisites, meeting_point, highlights, status, publication_status)
values (
  'kunjungan-pengenalan-rumah-teh',
  'rumah-teh-lokal',
  'Kunjungan pengenalan Rumah Teh Lokal',
  'Kenali pengalaman yang tersedia di Rumah Teh Lokal sebelum menentukan niat berkunjung.',
  'Halaman pengenalan ini membantu calon pengunjung memahami bentuk kunjungan di Place ini. Detail operasional dan ketersediaan perlu dikonfirmasi kepada Producer.',
  60, null, 1, 6, null, '{}', 'Konfirmasi titik temu kepada Producer sebelum berkunjung.', '{Memahami alur kunjungan,Menentukan waktu yang ingin diajukan,Meneruskan niat berkunjung ke Producer}', 'published', 'published'
) on conflict (id) do nothing;

insert into public.experience_schedules (experience_id, day_of_week, start_time, end_time, timezone, status)
select 'kunjungan-pengenalan-rumah-teh', 'Hari operasional mengikuti konfirmasi Producer', '09:00', '15:00', 'Asia/Jakarta', 'requires_confirmation'
where not exists (select 1 from public.experience_schedules where experience_id = 'kunjungan-pengenalan-rumah-teh');

alter table public.users enable row level security;
alter table public.producers enable row level security;
alter table public.places enable row level security;
alter table public.experiences enable row level security;
alter table public.experience_schedules enable row level security;
alter table public.producer_memberships enable row level security;
alter table public.visit_intents enable row level security;
alter table public.visit_intent_status_history enable row level security;

create policy users_self_access on public.users for select using (id = auth.uid());
create policy producers_public_read on public.producers for select using (true);
create policy places_public_read on public.places for select using (publication_status = 'published' or exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = places.id));
create policy experiences_public_read on public.experiences for select using (publication_status = 'published' or exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = experiences.place_id));
create policy schedules_public_read on public.experience_schedules for select using (exists (select 1 from public.experiences e where e.id = experience_schedules.experience_id and e.publication_status = 'published') or exists (select 1 from public.producer_memberships m join public.experiences e on e.place_id = m.place_id where m.user_id = auth.uid() and e.id = experience_schedules.experience_id));
create policy memberships_self_read on public.producer_memberships for select using (user_id = auth.uid());
create policy visit_intents_user_read on public.visit_intents for select using (user_id = auth.uid());
create policy visit_intents_producer_read on public.visit_intents for select using (exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = visit_intents.place_id and m.role in ('owner', 'manager')));
create policy visit_intents_user_insert on public.visit_intents for insert with check (
  user_id = auth.uid()
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
create policy visit_intents_producer_update on public.visit_intents for update using (exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = visit_intents.place_id and m.role in ('owner', 'manager'))) with check (exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = visit_intents.place_id and m.role in ('owner', 'manager')));
create policy visit_intent_history_read on public.visit_intent_status_history for select using (exists (select 1 from public.visit_intents i where i.id = visit_intent_status_history.visit_intent_id and (i.user_id = auth.uid() or exists (select 1 from public.producer_memberships m where m.user_id = auth.uid() and m.place_id = i.place_id and m.role in ('owner', 'manager')))));
