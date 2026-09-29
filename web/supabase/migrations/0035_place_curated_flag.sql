-- 0035 — DISCOVERY CURATED FLAG: `places.is_curated` (Tempat Pilihan).
--
-- GAP THIS MIGRATION FILLS
-- Stage 0 audit: Tempat Pilihan had NO persisted selection — the Home layer
-- showed ALL published Places with a 50 km camera. PO directive (Stage 3):
-- Tempat Pilihan = `publication published` + `isCurated=true`. Discovery
-- (canonical engine, contract v1.0) stays a separate, system-computed layer;
-- one Place may live in BOTH layers; layers never deduplicate against each
-- other.
--
-- RULES HONOURED
-- - Additive only: one new nullable column, one index, no public INSERT/UPDATE
--   grants. No existing column, constraint, policy, or grant is touched.
-- - The flag is metadata about the Tempat Pilihan LAYER — not a Place
--   category, not a publication status. Nothing else about the Place changes.
-- - Discovery stays curated-blind: the engine (web/lib/discovery/scoring.ts)
--   never reads this column, and no trigger or policy couples the two layers.
--
-- WRITE AUTHORITY
-- - Tempat Pilihan is an Admin-promoted layer: the column is writable by the
--   server only (service role). Producers/clients cannot grant themselves
--   curation — there is deliberately no producer-facing UPDATE grant and no
--   admin API in this stage (the flag is managed by the platform operator
--   directly on Supabase DEV until an Admin surface is decided).
--
-- BACKFILL
-- - NULL (unknown) for existing rows: no Place is granted curation by
--   assumption. Tempat Pilihan starts empty on DEV; grants are PO decisions.

alter table public.places
  add column if not exists is_curated boolean not null default false;

create index if not exists places_is_curated_idx
  on public.places (is_curated)
  where is_curated;

comment on column public.places.is_curated is
  'Tempat Pilihan layer membership (PO, Stage 3): true = Admin-promoted. Discovery never reads this column.';
