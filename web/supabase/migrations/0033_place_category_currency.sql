-- 0033 — PLACE CATEGORY + CURRENCY CANONICALIZATION (PO, 2026-09-28).
--
-- GAP THIS MIGRATION FILLS
-- The Place category model is replaced TOTAL: the only valid categories are
-- now 'Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa'. The
-- former Kopi/Teh/Kuliner values are retired everywhere — model, forms,
-- server validator, and now the database. Currency is narrowed the same way
-- to exactly 'IDR' and 'USD'.
--
-- RULES HONOURED
-- - §8/§15 NOTHING IS DESTROYED. No Place, Experience, Visit Intent, claim,
--   membership, Live, audit, or history row is deleted. Places are only
--   RECLASSIFIED into one of the three canonical categories.
-- - AGENTS.md IDEMPOTENCY. The reclassification is guarded so a value an
--   operator has already corrected is never overwritten; the constraints use
--   drop-if-exists-then-add so re-applying is a no-op.
-- - NOT A SILENT RULE CHANGE: the three category values are the exact
--   strings lib/places.ts (PlaceCategory) validates and the forms render.
--
-- SCOPE: data reclassification on public.places, two CHECK constraints,
-- two idempotency DO blocks. Safe re-apply.

-- ---------------------------------------------------------------------------
-- 1. Reclassify the four named existing Places (PO decision, 2026-09-28).
--    Guarded: a category that is already one of the three canonical values
--    (a re-apply, or an operator correction) is never overwritten.
-- ---------------------------------------------------------------------------

-- Kopi dari Kebun — a coffee farm/plantation: a natural resource.
update public.places
set category = 'Sumber Daya Alam'
where name = 'Kopi dari Kebun'
  and coalesce(category, '') not in ('Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa');

-- Bakso Migran — a production/kitchen operation: industry & processing.
update public.places
set category = 'Industri & Pengolahan'
where name = 'Bakso Migran'
  and coalesce(category, '') not in ('Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa');

-- Rumah Teh Lokal — a shop/retail operation: trade & services.
update public.places
set category = 'Perdagangan & Jasa'
where name = 'Rumah Teh Lokal'
  and coalesce(category, '') not in ('Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa');

-- Dapur Rasa — a food business/retail operation: trade & services.
update public.places
set category = 'Perdagangan & Jasa'
where name = 'Dapur Rasa'
  and coalesce(category, '') not in ('Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa');

-- ---------------------------------------------------------------------------
-- 2. Any OTHER Place still carrying a retired category is reclassified by
--    the character of its activity, without inventing a new category:
--    the saved id still tells the activity type. 'production' Places are
--    processing/industry; the rest are trade & services. (The four named
--    Places above are already canonical, so this clause cannot move them.)
--    'Sumber Daya Alam' is never assigned automatically — that
--    classification is an operator decision on a real Place.
-- ---------------------------------------------------------------------------
update public.places
set category = case when type = 'production' then 'Industri & Pengolahan' else 'Perdagangan & Jasa' end
where category is null
   or category not in ('Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa');

-- ---------------------------------------------------------------------------
-- 3. Currency: any existing value outside the new vocabulary maps onto the
--    closest valid one, by the country the Place is registered in (column
--    from migration 0032), then to the platform default for the remainder.
--    Values already 'IDR'/'USD' are never touched.
-- ---------------------------------------------------------------------------
update public.places
set currency = case
  when country_code = 'ID' then 'IDR'
  when country_code = 'US' then 'USD'
  else 'IDR' -- platform default (places.currency default 'IDR', migration 0001)
end
where currency is null
   or currency not in ('IDR', 'USD');

-- ---------------------------------------------------------------------------
-- 4. Constraints: the database itself now refuses anything outside the
--    three categories and the two currencies. DROP-if-exists first keeps the
--    statements idempotent (and lets a future migration widen the vocabulary
--    by re-issuing the same two lines).
-- ---------------------------------------------------------------------------
alter table public.places drop constraint if exists places_category_check;
alter table public.places
  add constraint places_category_check
  check (category in ('Sumber Daya Alam', 'Industri & Pengolahan', 'Perdagangan & Jasa'));

alter table public.places drop constraint if exists places_currency_check;
alter table public.places
  add constraint places_currency_check
  check (currency in ('IDR', 'USD'));
