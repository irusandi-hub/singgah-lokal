-- 0030 — NOTIFICATION REALTIME PUBLICATION
--
-- GAP THIS MIGRATION FIXES
-- 0029 added the whole Master 10 §6 fan-out and the private unread signal:
-- `notify_recipient` writes the canonical row, and
-- `notifications_broadcast_unread` fires `realtime.send(...,
-- 'notifications:' || new.user_id, true)` on the RECIPIENT's own topic. What
-- 0029 never did is register the source table with the `supabase_realtime`
-- publication — the same registration 0008 performs for `live_sessions` and
-- `live_reports`. The result is a project where the private-channel RLS policy
-- exists and the header bell subscribes correctly, yet the table that the
-- database broadcasts from is not a member of the publication. The signal is
-- display-only; the canonical row and the badge count are unaffected, so the
-- failure mode is "the badge silently stops moving", which is exactly the
-- symptom MASTER 10 §9 forbids.
--
-- Verified against Supabase DEVELOPMENT before this file was written:
-- `select ... from pg_publication_tables where pubname='supabase_realtime' and
-- tablename='notifications'` returned no row, while 0008's two tables were
-- present.
--
-- RULES HONOURED (MASTER 10)
-- - §9/§14 the signal is a display transport only. This migration changes no
--   trigger, no function body, no policy, no grant, and no row. The canonical
--   count still comes from the owner-scoped, RLS-backed /api/notifications read,
--   and the `notifications_realtime_receive` policy on `realtime.messages`
--   (0029) remains the only gate: a session may still receive on the topic
--   built from its own `auth.uid()` and on nobody else's.
-- - §17 nothing here can break a business write: a publication membership is
--   not a write path, and the statement is exception-guarded.
-- - 0029 is NOT re-applied by this file and nothing in it is duplicated. This
--   is the one missing statement from 0029, and only that statement.
--
-- SCOPE: one statement, guarded, idempotent (safe re-apply). It matches the
-- 0008 pattern so the chain stays uniform.

do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;
end $$;
