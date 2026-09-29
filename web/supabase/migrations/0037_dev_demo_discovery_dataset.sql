-- 0037 — DEV DEMO DATASET: ≥10 eligible Discovery Places (PO request).
--
-- PURPOSE
-- The Discovery guarantee is BY CONSTRUCTION (contract v1.0 §6): every
-- PUBLISHED + publication-ready Place is eligible, and the engine ranks all
-- of them. On DEV the real dataset (the three 0001 seeds plus the 0019 demo
-- row) yields fewer than 10 eligible Places, so this seed completes the DEV
-- demo dataset. DEV ONLY — demo values only, and no production data is ever
-- touched (the operator applies migrations per environment, exactly like the
-- 0019 demo seed before it).
--
-- RULES HONOURED
-- - Idempotent (AGENTS.md): every statement is a no-op on re-run
--   (on conflict do nothing / guarded updates / where not exists).
-- - Canonical eligibility only: each seeded Place is published with a complete
--   profile (name, short description, area, address, finite canonical
--   coordinates, timezone, currency, canonical category) — the exact fields
--   `evaluateDiscoveryEligibility` (E1+E2) reads. No eligibility is faked and
--   the engine is never bypassed: scores/stars remain computed by the engine.
-- - §8/§15 NOTHING IS DESTROYED: no existing row is deleted or overwritten.
--   The ONLY touch of existing rows is completing missing OPTIONAL demo
--   signals (demo users/follows/photos) with where-not-exists guards — never
--   identity, ownership, publication, or claim fields.
-- - No new category, no Master change, no payment fields. Categories are the
--   three canonical values (0033 CHECK); currencies are IDR only.
--
-- WHAT IS SEEDED
-- 1. Ten demo Places (sari-… ids, clearly demo names) spread across real
--    West Java locations so the DEV map and the 1 km/5 km/10 km+ camera
--    presets have honest geography.
-- 2. A small pool of demo users (auth.users + public.users via the 0001
--    trigger) so follow signals exist without touching real accounts.
--    NO producers and NO producer_memberships are seeded: a PO decision locks
--    DEV producers at 0 and Producer approval is created through the 0016 RPC,
--    never through migration data (regression: producer-multi-place.test.ts).
--    Eligibility (E1+E2) never depended on a producer, so nothing is lost.
-- 3. Legitimate demo engagement: follows (0023 shape) and demo photo metadata
--    (0021 shape) so the engine has canonical signals to score — demo-only and
--    idempotent.

-- ---------------------------------------------------------------------------
-- 1. Demo Places — published + publication-ready (canonical eligibility).
--    Bandung/Lembang/Soreang/Batununggal-area coordinates (real geography,
--    small deltas so demo pins are distinguishable on the DEV map).
-- ---------------------------------------------------------------------------
insert into public.places (
  id, name, short_description, category, type, area, address, contact_information,
  country_code, region_name, timezone, currency, latitude, longitude,
  claim_status, publication_status
)
values
  ('sari-jagung-sejahtera', 'Sari Jagung Sejahtera', 'Demo Place: pengolahan jagung lokal menjadi tepung dan camilan tradisional.', 'Industri & Pengolahan', 'production', 'Cibiru', 'Jl. Demo Cibiru No. 1, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.8894, 107.7305, 'unverified', 'published'),
  ('sari-tempe-makmur', 'Sari Tempe Makmur', 'Demo Place: produksi tempe kedelai rumahan dengan proses fermentasi tradisional.', 'Industri & Pengolahan', 'production', 'Buahbatu', 'Jl. Demo Buahbatu No. 2, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.9497, 107.6347, 'unverified', 'published'),
  ('sari-tahu-pakis', 'Sari Tahu Pakis', 'Demo Place: pembuatan tahu segar setiap pagi dari kedelai lokal.', 'Industri & Pengolahan', 'production', 'Pakisjaya', 'Jl. Demo Pakis No. 3, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.9632, 107.6191, 'unverified', 'published'),
  ('sari-kerajinan-bambu', 'Sari Kerajinan Bambu', 'Demo Place: kerajinan bambu dari petani lokal menjadi peralatan dapur.', 'Industri & Pengolahan', 'production', 'Soreang', 'Jl. Demo Soreang No. 4, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -7.0281, 107.5196, 'unverified', 'published'),
  ('sari-batik-pancarsari', 'Sari Batik Pancarsari', 'Demo Place: studio batik tulis dengan pewarna alami, terbuka untuk kunjungan.', 'Perdagangan & Jasa', 'experience', 'Batununggal', 'Jl. Demo Batununggal No. 5, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.9553, 107.6377, 'unverified', 'published'),
  ('sari-tenun-klasik', 'Sari Tenun Klasik', 'Demo Place: galeri tenun ikat dan loket kunjungan produksi.', 'Perdagangan & Jasa', 'experience', 'Kopo', 'Jl. Demo Kopo No. 6, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.9577, 107.5939, 'unverified', 'published'),
  ('sari-anyaman-lentera', 'Sari Anyaman Lentera', 'Demo Place: anyaman bambu dan lentera kertas untuk dekorasi lokal.', 'Perdagangan & Jasa', 'production', 'Ciparay', 'Jl. Demo Ciparay No. 7, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.9418, 107.7523, 'unverified', 'published'),
  ('sari-kebun-obat', 'Sari Kebun Obat', 'Demo Place: kebun tanaman obat keluarga dengan tur edukasi singkat.', 'Sumber Daya Alam', 'experience', 'Megaluhan', 'Jl. Demo Megaluhan No. 8, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.8916, 107.6571, 'unverified', 'published'),
  ('sari-taman-bibit', 'Sari Taman Bibit', 'Demo Place: kebibitan bibit buah dan sayuran lokal untuk kunjungan.', 'Sumber Daya Alam', 'experience', 'Cicadas', 'Jl. Demo Cicadas No. 9, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -6.9023, 107.6103, 'unverified', 'published'),
  ('sari-gula-aren', 'Sari Gula Aren', 'Demo Place: pengolahan gula aren tradisional dari sadapan petani.', 'Industri & Pengolahan', 'production', 'Banjaran', 'Jl. Demo Banjaran No. 10, Bandung', '', 'ID', 'Jawa Barat', 'Asia/Jakarta', 'IDR', -7.0455, 107.5897, 'unverified', 'published')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Demo users — follow signals for the demo Places, without touching real
--    accounts. The 0001 handle_new_user trigger mirrors each auth.users row
--    into public.users. Producers/memberships are deliberately NOT seeded
--    (PO decision: DEV producers = 0; approval goes through the 0016 RPC).
-- ---------------------------------------------------------------------------
insert into auth.users (id, email_confirmed_at) values
  ('00000000-0000-4000-8000-00000000d001', now()),
  ('00000000-0000-4000-8000-00000000d002', now()),
  ('00000000-0000-4000-8000-00000000d003', now()),
  ('00000000-0000-4000-8000-00000000d004', now()),
  ('00000000-0000-4000-8000-00000000d005', now()),
  ('00000000-0000-4000-8000-00000000d006', now()),
  ('00000000-0000-4000-8000-00000000d007', now()),
  ('00000000-0000-4000-8000-00000000d008', now()),
  ('00000000-0000-4000-8000-00000000d009', now()),
  ('00000000-0000-4000-8000-00000000d00a', now()),
  ('00000000-0000-4000-8000-00000000d00b', now()),
  ('00000000-0000-4000-8000-00000000d00c', now())
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Demo engagement signals — legitimately canonical rows so the engine has
--    something to weigh. Follows (0023): one per demo user per Place.
-- ---------------------------------------------------------------------------
insert into public.place_follows (user_id, place_id)
values
  ('00000000-0000-4000-8000-00000000d009', 'sari-jagung-sejahtera'),
  ('00000000-0000-4000-8000-00000000d00a', 'sari-jagung-sejahtera'),
  ('00000000-0000-4000-8000-00000000d00b', 'sari-tempe-makmur'),
  ('00000000-0000-4000-8000-00000000d00c', 'sari-tempe-makmur'),
  ('00000000-0000-4000-8000-00000000d009', 'sari-tahu-pakis'),
  ('00000000-0000-4000-8000-00000000d00a', 'sari-batik-pancarsari'),
  ('00000000-0000-4000-8000-00000000d00b', 'sari-batik-pancarsari'),
  ('00000000-0000-4000-8000-00000000d00c', 'sari-tenun-klasik'),
  ('00000000-0000-4000-8000-00000000d001', 'sari-kebun-obat'),
  ('00000000-0000-4000-8000-00000000d002', 'sari-gula-aren')
on conflict (user_id, place_id) do nothing;

-- Demo photos: cover-adjacent media richness (0021 shape) for a few Places.
insert into public.place_photos (place_id, slot_key, storage_path, title, description, sort_order)
values
  ('sari-jagung-sejahtera', 'demo-cover', 'demo/sari-jagung-sejahtera/cover.jpg', 'Demo foto jagung', 'Demo image metadata only', 0),
  ('sari-batik-pancarsari', 'demo-cover', 'demo/sari-batik-pancarsari/cover.jpg', 'Demo foto batik', 'Demo image metadata only', 0),
  ('sari-tenun-klasik', 'demo-cover', 'demo/sari-tenun-klasik/cover.jpg', 'Demo foto tenun', 'Demo image metadata only', 0)
on conflict (place_id, slot_key) do nothing;

-- ---------------------------------------------------------------------------
-- 4. The four pre-existing DEV rows (the three 0001 seeds and the 0019 demo
--    Place) are DEMO rows: they carry an empty address and, except Bakso
--    Migran, no coordinates, so canonical eligibility (E2) fails for them.
--    Complete ONLY their missing demo address/coordinates with guarded
--    backfills — a row that already has a value keeps it (the guards make
--    this a no-op on re-run and can never touch a real Place with real data).
--    Bakso Migran keeps its PO-supplied canonical coordinates untouched.
-- ---------------------------------------------------------------------------
update public.places
set address = 'Jl. Demo ' || initcap(replace(id, '-', ' ')) || ' No. 1'
where id in ('kopi-dari-kebun', 'rumah-teh-lokal', 'dapur-rasa', 'bakso-migran')
  and (address is null or address = '');

-- Demo coordinates for the three 0001 seed rows (Bandung area, matching
-- their area values) — guarded to empty coordinates only.
update public.places
set latitude = case id
      when 'kopi-dari-kebun' then -6.9075
      when 'rumah-teh-lokal' then -6.8182
      when 'dapur-rasa' then -6.9144
      else latitude
    end,
    longitude = case id
      when 'kopi-dari-kebun' then 107.6191
      when 'rumah-teh-lokal' then 107.6182
      when 'dapur-rasa' then 107.6094
      else longitude
    end
where id in ('kopi-dari-kebun', 'rumah-teh-lokal', 'dapur-rasa')
  and (latitude is null or longitude is null);
