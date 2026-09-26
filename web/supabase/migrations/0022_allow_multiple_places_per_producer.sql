-- 0022 — 1 PRODUCER = N PLACE (PO decision, 2026-09-26).
--
-- Supersedes the one-membership-per-user rule introduced by migration 0020
-- (PO request, 2026-09-25). 0020 stays in the migration history untouched;
-- this migration only retires its unique index so one account may hold
-- producer_memberships for MULTIPLE Places. The foundation PK
-- (user_id, place_id) from 0001 is preserved: it keeps preventing duplicate
-- rows for the same (user, place) pair, and stays idempotency-safe for
-- membership upserts.
--
-- No authorization change: RLS on places/producer_memberships is untouched.
-- A Producer still manages only the Places of their own membership rows;
-- ownership grants on create (service-role) keep the canonical
-- one-owner-membership-per-Place shape.
--
-- Idempotent (safe to re-run): the index is dropped only when it exists.
-- No data migration is performed — existing membership rows are kept.

drop index if exists public.producer_memberships_one_per_user_idx;
