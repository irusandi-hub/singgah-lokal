-- 0019 — DEV DEMO DATA (PO request): "Bakso Migran" demo Place.
-- Not a schema change; a single idempotent seed row so the demo Place can
-- appear in discovery and be used to verify radius/nearby behavior.
-- Coordinates are the exact canonical Place coordinates supplied by the
-- product owner — never a stand-in for a user position and never the map's
-- discovery default. Area, timezone, and currency follow the Place's real
-- location (locked rule: currency follows Place; Place timezone governs).
-- Run ONCE on Supabase DEV; re-running is a no-op (on conflict do nothing).
insert into public.places (
  id, name, short_description, category, type, area, address, contact_information,
  timezone, currency, latitude, longitude, claim_status, publication_status
)
values (
  'bakso-migran',
  'Bakso Migran',
  'bakso asli cita rasa indonesia, produksi bahan asli rempah indonesia, oleh tukang masak berpengalaman. membuat berbagai macam jenis bakso.',
  'Kuliner',
  'production',
  'Al Khobar',
  '',
  '',
  'Asia/Riyadh',
  'SAR',
  26.3642121,
  50.1988771,
  'unverified',
  'published'
)
on conflict (id) do nothing;
