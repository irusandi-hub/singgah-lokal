-- 0032 — PLACE GEOGRAPHY: canonical country + province/state on Place
-- (PO, 2026-09-28).
--
-- GAP THIS MIGRATION FILLS
-- `places.area` is free text and has always been the LOCAL area ("Bandung",
-- "Lembang"). There was no way to say which country a Place is in, or which
-- province/state/wilayah inside that country, so a Place could not be
-- narrowed geographically beyond a hand-typed string. The Admin Place list
-- had no geographic filter at all.
--
-- RULES HONOURED
-- - §5 ADMIN OPERATIONAL AUTHORITY. Country and Region are canonical Place
--   columns, editable by Admin and Producer through the ONE shared Place
--   mutation validator (lib/place-management.parsePlaceMutation), which
--   validates the pair server-side against the dataset.
-- - §8/§15 NOTHING IS DESTROYED. This is additive: two new nullable columns
--   and one index. No existing column, constraint, policy, function, or grant
--   is touched, and no Place row is deleted or rewritten beyond the four
--   named Places below. `places.area` is NOT migrated, renamed, or
--   repurposed — it remains the local area it has always been.
-- - AGENTS.md IDEMPOTENCY. `add column if not exists` / `create index if
--   exists`, and the backfill is guarded so re-applying cannot overwrite a
--   value an Admin has already corrected in the UI.
-- - NOT A NEW BUSINESS RULE. The stored values are ISO 3166-1 alpha-2
--   country codes and ISO 3166-2 subdivision names, exactly as published by
--   the `country-region-data` dataset (MIT) the application validates
--   against. No second naming table exists in the database, so the value is
--   always reproducible from the dataset alone.
--
-- WHY NULLABLE: an existing Place that has not been assigned a country yet
-- must stay readable and editable. The application requires both fields on
-- every create and update, so a null value only ever survives on rows written
-- before this migration.
--
-- SCOPE: two columns, one index, a four-row backfill. Safe re-apply.

alter table public.places
  add column if not exists country_code text,
  add column if not exists region_name text;

-- The Admin Place list filters by country, then narrows by region inside it
-- (Country → Region). The pair is the access path, so it is the index.
create index if not exists places_country_region_idx
on public.places (country_code, region_name);

-- Backfill the four existing Places (PO, 2026-09-28). Matched on `name`,
-- which is what the instruction named, and only where the column is still
-- empty — a Place an Admin has already re-assigned in the UI keeps its value.
update public.places
set country_code = 'SA', region_name = 'Ash Sharqiyah'
where name in ('Bakso Migran', 'Kopi dari Kebun')
  and (country_code is null or country_code = '');

update public.places
set country_code = 'ID', region_name = 'Jawa Barat'
where name in ('Dapur Rasa', 'Rumah Teh Lokal')
  and (country_code is null or country_code = '');
