-- 0021 — PLACE MEDIA: standard photo slots per Place (PO request, 2026-09-25).
--
-- Files live in Supabase Storage (bucket `place-media`, object layout
-- places/<place_id>/<slot_key>-<hash>.<ext>); this table stores the CANONICAL
-- references: one row per standard slot. Every slot carries a title and a
-- description, following the existing Production Story content structure
-- (hook → content sections) — no new content structure is introduced.
--
-- Visibility model mirrors 0018 (cover_image_url): a saved reference is read
-- together with its Place (public read of published Places), so the bucket
-- must serve the objects it references publicly. Writes happen exclusively
-- through the server-side upload API (service-role, after the Producer-gate
-- check) — clients get NO direct bucket access.
create table if not exists public.place_photos (
  id uuid primary key default gen_random_uuid(),
  place_id text not null references public.places(id) on delete cascade,
  slot_key text not null check (char_length(slot_key) between 1 and 64),
  storage_path text not null check (char_length(storage_path) between 1 and 512),
  title text not null check (char_length(title) <= 120),
  description text not null check (char_length(description) <= 1000),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (place_id, slot_key)
);

create index if not exists place_photos_place_order_idx
on public.place_photos (place_id, sort_order, id);

alter table public.place_photos enable row level security;

-- Same visibility rule as the Place itself: published Places are public;
-- members of the Place can also read their own draft Place photos.
create policy place_photos_public_read on public.place_photos
for select using (
  exists (
    select 1 from public.places p
    where p.id = place_photos.place_id
      and (p.publication_status = 'published'
        or exists (
          select 1 from public.producer_memberships m
          where m.user_id = auth.uid() and m.place_id = place_photos.place_id
        ))
  )
);

-- No client write policies: uploads/replaces/removals and metadata edits go
-- through the server-side API (service-role) after Producer-gate checks.
