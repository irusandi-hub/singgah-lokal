-- 0020 — 1 AKUN = 1 PLACE (PO request, 2026-09-25).
--
-- One SINGGAH LOKAL account may hold AT MOST ONE producer_membership row.
-- The foundation PK (user_id, place_id) in 0001 only prevents duplicates of
-- the same (user, place) pair; this unique index closes the remaining hole
-- where one account could accumulate memberships across several Places.
-- No Producer account/credential is created anywhere — this constrains
-- existing membership rows only.
--
-- Idempotent (safe to re-run): the index is created only when absent. DEV
-- producers data was reset by the PO (producers=0, memberships=0), so the
-- index applies to an empty table there; no data migration is performed.

create unique index if not exists producer_memberships_one_per_user_idx
on public.producer_memberships (user_id);
