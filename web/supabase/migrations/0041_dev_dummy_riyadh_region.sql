-- 0041 — CORRECTIVE (DEV-ONLY): the ten Riyadh Dummy Places carried the WRONG
-- ISO 3166-2 subdivision.
--
-- MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0 §7 (currency and geography follow
-- the Place) and MASTER 01 ("Currency follows Place").
--
-- ⚠ DEV ONLY — DO NOT APPLY TO PRODUCTION.
-- Like 0040, this file only ever touches the ten DEV fixtures it names. They
-- do not exist outside DEV, so on production it is a no-op.
--
-- THE DEFECT
-- 0040 inserted every Riyadh fixture with `region_name = 'Ash Sharqiyah'`.
-- That value is a REAL ISO 3166-2 subdivision of Saudi Arabia — just not the
-- one these Places are in:
--
--   | ISO 3166-2:SA | subdivision        | where it is                    |
--   | ------------- | ------------------ | ------------------------------ |
--   | SA-01         | Ar Riyad           | Riyadh Region                  |
--   | SA-04         | Ash Sharqiyah      | Eastern Province (Dammam/Khobar)
--
-- So every fixture was filed under the Eastern Province while sitting in Riyadh
-- — roughly 380 km from the boundary it named. That is a real data fault, not a
-- vocabulary fault: `'Ash Sharqiyah'` passes the application's region
-- validation, so nothing downstream could have caught it.
--
-- WHERE THE WRONG VALUE CAME FROM
-- Migration 0032 (place geography) backfilled its two Saudi DEV seeds with
-- `region_name = 'Ash Sharqiyah'` as a placeholder, and 0040 copied that
-- placeholder into the new fixtures instead of resolving the subdivision from
-- the fixtures' own coordinates.
--
-- THE CORRECT VALUE, AND WHY IT IS THIS SPELLING
-- `Ar Riyad` — SA-01, the Riyadh Region. Two independent sources agree:
--   1. ISO 3166-2 itself (SA-01 Ar Riyad / SA-04 Ash Sharqiyah), and
--   2. the reverse-geocoded fixtures, which resolve to `state = "Riyadh Region"`
--      for all ten coordinates (Nominatim).
--
-- The value is stored VERBATIM as the `country-region-data` dataset spells it,
-- because `lib/geo/countries.ts` is the canonical vocabulary: it validates
-- `region_name` against that dataset on every write and fills the Admin /
-- Producer dropdowns from it. Nominatim's own spelling, "Riyadh Region", is
-- NOT in the SA subdivision list and would be refused by
-- `isValidPlaceRegion("SA", ...)` — which would leave these Places un-editable
-- through the one shared Place validator. `'Ar Riyad'` is the only spelling
-- that is both factually right and valid here.
--
-- RULES HONOURED
-- - §5/§8 NOTHING ELSE IS TOUCHED. Exactly one column, `region_name`, on
--   exactly ten enumerated ids. `is_dummy` is not written, `is_curated` is not
--   written, and no Dummy Place is promoted to Tempat Pilihan — the fixtures
--   stay exactly as 0040 left them, awaiting the Creator's audited
--   `markRiyadhDummyPlacesCurated` call if and when that is wanted.
-- - §3 ENUMERATED IDS, NEVER A PREDICATE. The target list is spelled out by id,
--   exactly as 0039's backfill is. Nothing matches on a name, a prefix, or free
--   text, so no real Place can ever be caught by this migration.
-- - `country_code = 'SA'` is part of the guard, so a row that is no longer a
--   Saudi Place is left alone instead of being repainted.
-- - AGENTS.md IDEMPOTENCY, WITHOUT A RATCHET. The update is guarded on the
--   exact wrong value (`region_name = 'Ash Sharqiyah'`), not merely on "not
--   already correct". So a re-apply is a zero-row no-op, AND a value an Admin
--   later chooses for one of these DEV fixtures is never stomped back to
--   `Ar Riyad`. This mirrors the precedent in migration 0032, which backfilled
--   only "where the column is still empty — a Place an Admin has already
--   re-assigned in the UI keeps its value".
-- - AUDITABLE. The change is an explicit, reviewable list of ten ids and one
--   column, and the before/after values are both written down in this file. The
--   post-condition below fails the migration loudly if any targeted Saudi
--   fixture is STILL filed under the Eastern Province after the update, so a
--   bad apply cannot pass silently.
-- - The append-only `place_audit` trail is deliberately NOT written to. Its
--   action vocabulary is closed by 0031 and extended only by 0039 (Master §5,
--   §9 change rule); inventing a "region corrected" key here would widen the
--   audit vocabulary without a Master decision, and these are DEV fixtures that
--   no Producer or Admin authority ever touched.

-- --------------------------------------------------------------------------
-- The correction.
-- --------------------------------------------------------------------------
update public.places
set region_name = 'Ar Riyad',
    updated_at = now()
where id in (
  'dummy-riyadh-olaya',
  'dummy-riyadh-king-fahd',
  'dummy-riyadh-malaz',
  'dummy-riyadh-nakheel',
  'dummy-riyadh-kafd',
  'dummy-riyadh-yasmin',
  'dummy-riyadh-sulaymaniyah',
  'dummy-riyadh-umm-al-hamam',
  'dummy-riyadh-al-izza',
  'dummy-riyadh-tahlia'
)
  and country_code = 'SA'
  and region_name = 'Ash Sharqiyah';

-- --------------------------------------------------------------------------
-- Post-condition. Idempotent: once the update has landed, the count is zero on
-- every later run. It only fires when the defect itself survives the apply.
-- --------------------------------------------------------------------------
do $$
declare
  uncorrected int;
begin
  select count(*) into uncorrected
  from public.places
  where id in (
    'dummy-riyadh-olaya',
    'dummy-riyadh-king-fahd',
    'dummy-riyadh-malaz',
    'dummy-riyadh-nakheel',
    'dummy-riyadh-kafd',
    'dummy-riyadh-yasmin',
    'dummy-riyadh-sulaymaniyah',
    'dummy-riyadh-umm-al-hamam',
    'dummy-riyadh-al-izza',
    'dummy-riyadh-tahlia'
  )
    and country_code = 'SA'
    and region_name = 'Ash Sharqiyah';

  if uncorrected > 0 then
    raise exception
      'dev_dummy_riyadh_region_not_corrected: % Saudi Riyadh fixture(s) are still filed under Ash Sharqiyah (SA-04, Eastern Province) instead of Ar Riyad (SA-01)',
      uncorrected;
  end if;
end;
$$;