-- 0023 — PLACE FOLLOWS: authoritative User ↔ Place follow relationship.
--
-- Foundation for the notification path User → Followed Place → Live Session →
-- Notification (MASTER 10 recipient authorization: a User may only ever be
-- notified about Places they deliberately follow). This migration creates the
-- relationship ONLY — no notification records, no push system, no polling.
--
-- One follow state per (user, Place): the composite primary key is the
-- single authoritative relationship; follow/unfollow is row presence, so
-- there is no mutable follow state and no UPDATE policy or grant. Follows are
-- a private User resource: RLS restricts SELECT/INSERT/DELETE to the owner
-- (auth.uid()); anon has no grant and no policy at all.
--
-- Non-destructive: creates one new table + indexes/policies only. No existing
-- table, constraint, policy, or data is altered. Idempotent (safe re-apply).
create table if not exists public.place_follows (
  user_id uuid not null references public.users(id) on delete cascade,
  place_id text not null references public.places(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, place_id)
);

-- Forward-path read for the future notification layer (Followed Place →
-- Live Session fan-out). Canonical state stays Supabase (AGENTS.md).
create index if not exists place_follows_place_idx
on public.place_follows (place_id);

alter table public.place_follows enable row level security;

-- Read: only the owner's own follows. Never public; never cross-user.
create policy place_follows_self_read on public.place_follows
for select using (user_id = auth.uid());

-- Insert: only the owner's own row, against a real Place (FK).
create policy place_follows_self_insert on public.place_follows
for insert with check (user_id = auth.uid());

-- Delete: only the owner's own row (unfollow). Other users' rows are both
-- invisible (SELECT policy) and un-deletable (this policy).
create policy place_follows_self_delete on public.place_follows
for delete using (user_id = auth.uid());

-- Hardening (0002 pattern): no default table privileges for anon/authenticated;
-- authenticated gets exactly the columns it needs. anon keeps nothing — a
-- signed-out visitor can never create or read a follow.
revoke all on public.place_follows from anon;
revoke all on public.place_follows from authenticated;

grant select, delete on public.place_follows to authenticated;
grant insert (user_id, place_id) on public.place_follows to authenticated;
