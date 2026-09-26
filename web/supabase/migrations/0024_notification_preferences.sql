-- 0024 — NOTIFICATION PREFERENCES: one preferences row per User.
--
-- Foundation for MASTER 10 §10 (Preferences): optional communication
-- categories are user-controlled, stored server-side, and applied before
-- any optional external delivery. This migration creates the preference
-- storage ONLY — no notification records, no push delivery, no polling,
-- no event fan-out, and no new notification category (the columns below
-- mirror the task-specified category set exactly).
--
-- Mandatory safety/security rule (MASTER 10 §10): these preferences must
-- never become a bypass for critical safety/account events. Nothing reads
-- them yet; when the notification layer arrives, `safety_account` (and any
-- future mandatory category) must be enforced server-side as non-disableable
-- rather than consulted as an opt-out.
--
-- One row per User: user_id is the primary key → public.users(id).
-- Defaults keep every mandatory category ON; promotional defaults OFF.
-- RLS restricts SELECT/INSERT/UPDATE to the owner (auth.uid()); anon holds
-- no grants and no policy. There is deliberately NO DELETE policy or grant —
-- a user's preference row is not deletable through the client API.
--
-- Non-destructive: creates one new table + trigger only. No existing table,
-- policy, or data is altered. Idempotent (safe re-apply).
create table if not exists public.notification_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  live_place boolean not null default true,
  visit_experience boolean not null default true,
  help_support boolean not null default true,
  system boolean not null default true,
  safety_account boolean not null default true,
  promotional boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notification_preferences enable row level security;

-- Read: only the owner's own preferences. Never public; never cross-user.
create policy notification_preferences_self_read on public.notification_preferences
for select using (user_id = auth.uid());

-- Insert: only the owner's own row (defaults fill the category flags).
create policy notification_preferences_self_insert on public.notification_preferences
for insert with check (user_id = auth.uid());

-- Update: only the owner's own row, both sides of the check.
create policy notification_preferences_self_update on public.notification_preferences
for update using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Server-side bookkeeping: updated_at is maintained by the database so a
-- client can never forge or freeze it.
create or replace function public.touch_notification_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists notification_preferences_touch_updated_at on public.notification_preferences;
create trigger notification_preferences_touch_updated_at
before update on public.notification_preferences
for each row execute procedure public.touch_notification_preferences_updated_at();

-- Hardening (0002/0023 pattern): no default table privileges; authenticated
-- gets exactly what the contract needs. anon keeps nothing — a signed-out
-- visitor can never read or write any preference.
revoke all on public.notification_preferences from anon;
revoke all on public.notification_preferences from authenticated;

grant select on public.notification_preferences to authenticated;
grant insert (user_id) on public.notification_preferences to authenticated;
grant update (live_place, visit_experience, help_support, system, safety_account, promotional)
on public.notification_preferences to authenticated;
