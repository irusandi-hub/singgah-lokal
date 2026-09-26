-- 0025 — NOTIFICATIONS: per-recipient in-app notification records.
--
-- Foundation for MASTER 10 (Notification & Communication System): the in-app
-- notification center is the mandatory MVP baseline channel (§4, §21) and the
-- notification payload references the underlying entity rather than
-- duplicating mutable business state (§5). This migration creates the
-- canonical storage ONLY — no push delivery, no polling, no event fan-out,
-- no preference changes (0024 is untouched), and no new category beyond the
-- six already locked by 0024.
--
-- Recipient authorization (MASTER 10 §2, §14): a notification row belongs to
-- exactly one recipient user. RLS gives the owner read access and a read_at-
-- only update path; everything else about a notification is written by the
-- server (service role) when a domain event fires — later, not in this
-- migration. Mandatory safety/account events stay non-disableable: the
-- server-side writer decides category handling; preferences never filter
-- writes, so `safety_account` cannot become a bypass (0024 header contract).
--
-- Validation is fail-closed (AGENTS.md): event_type/title/body must not be
-- blank, and source_type/source_id must be provided as a pair.
--
-- Non-destructive: creates one new table + indexes/policies only. No existing
-- table, policy, or data is altered. Idempotent (safe re-apply).
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null check (category in (
    'live_place', 'visit_experience', 'help_support', 'system',
    'safety_account', 'promotional'
  )),
  event_type text not null check (length(btrim(event_type)) between 1 and 120),
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 1000),
  place_id text references public.places(id) on delete set null,
  source_type text check (length(btrim(source_type)) between 1 and 80),
  source_id text check (length(btrim(source_id)) between 1 and 120),
  metadata jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check ((source_type is null) = (source_id is null))
);

-- Recipient inbox ordering (newest first).
create index if not exists notifications_user_created_idx
on public.notifications (user_id, created_at desc);

-- Unread badge / unread list (partial: only unread rows are indexed).
create index if not exists notifications_user_unread_idx
on public.notifications (user_id, created_at desc)
where read_at is null;

-- Category-scoped inbox reads (filter or grouping by category, MASTER 10 §9).
create index if not exists notifications_user_category_created_idx
on public.notifications (user_id, category, created_at desc);

-- Entity lookups: open notifications for a Place (e.g. Live ended for the
-- Place) — only rows that actually carry a Place.
create index if not exists notifications_place_created_idx
on public.notifications (place_id, created_at desc)
where place_id is not null;

alter table public.notifications enable row level security;

-- Read: only the recipient's own notifications. Never public, never cross-user.
create policy notifications_self_read on public.notifications
for select using (user_id = auth.uid());

-- Update: the owner may ONLY mark their own notification read. The column
-- grant below (UPDATE (read_at)) is the primary lock — every other column is
-- ACL-denied to the client before any evaluation — and the identity guard
-- trigger is the second layer against grant drift (MASTER 10 §14: ownership
-- enforced server-side; nothing else about a notification is client-editable).
create policy notifications_self_update_read_at on public.notifications
for update using (user_id = auth.uid())
with check (user_id = auth.uid());

-- The database enforces "read_at is the only client-mutable column" in two
-- layers: the column grant (ACL) rejects every other column outright, and
-- this trigger re-checks identity/content immutability for authenticated
-- sessions if grants ever drift. read_at itself is free-valued (a recipient
-- marks read with their own timestamp — no clock equality is imposed).
-- Server-side (service role) writes are unaffected — the trigger inspects
-- the session role.
create or replace function public.guard_notifications_client_update()
returns trigger
language plpgsql
as $$
begin
  if (select current_setting('role')) = 'authenticated' then
    if new.user_id is distinct from old.user_id
      or new.category is distinct from old.category
      or new.event_type is distinct from old.event_type
      or new.title is distinct from old.title
      or new.body is distinct from old.body
      or new.place_id is distinct from old.place_id
      or new.source_type is distinct from old.source_type
      or new.source_id is distinct from old.source_id
      or new.metadata is distinct from old.metadata
      or new.created_at is distinct from old.created_at
      or new.id is distinct from old.id then
      raise exception 'Notifications allow only read_at changes by the recipient';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists notifications_client_update_guard on public.notifications;
create trigger notifications_client_update_guard
before update on public.notifications
for each row execute procedure public.guard_notifications_client_update();

-- Hardening (0002/0023/0024 pattern): no default table privileges. The client
-- gets exactly SELECT + read_at UPDATE; INSERT and DELETE stay server-side
-- only (notifications are created by the platform when domain events fire,
-- and never deleted by users — retention is a server policy, MASTER 10 §15).
revoke all on public.notifications from anon;
revoke all on public.notifications from authenticated;

grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
