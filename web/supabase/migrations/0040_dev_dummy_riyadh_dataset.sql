-- 0040 — DEV-ONLY: Riyadh Dummy Place dataset for Discovery testing.
--
-- MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0 §7.
--
-- ⚠ DEV ONLY — DO NOT APPLY TO PRODUCTION.
-- The operator applies migrations per environment, exactly as with the 0019
-- and 0037 demo seeds before it. On production these ten rows would inject
-- obviously fictional Places into the Discovery layer, which is why this file
-- is kept separate from the schema migration (0039) rather than appended to
-- it: the schema is safe everywhere, this data is not.
--
-- PURPOSE
-- Discovery search coverage needs a Place set inside a city that is NOT the
-- operator's usual location, so the "search a city, results follow the search
-- centre, not the device" behaviour can be exercised on a real map. The DEV
-- dataset (0037) is West Java only; a Riyadh set makes the search-centre path
-- unambiguous, because a viewer in Dammam is unmistakably not nearby.
--
-- HONESTY RULES (Master §5, §7)
-- - Every row is flagged `is_dummy = true` — the canonical marker, not a word.
-- - Every NAME begins with the literal prefix "Dummy Riyadh —", so no row can
--   ever be mistaken for a real Producer, a real business, or a real listing.
--   This is a naming convention for human legibility only; authorization never
--   reads it.
-- - No producer_id and no claim: these are not owned by, and not claimed by,
--   anyone. They are test fixtures.
-- - Coordinates are real Riyadh coordinates (the city genuinely exists at them)
--   spread across real districts, so the map framing is meaningful. The PLACES
--   are fictional; the geography is not.
-- - Currency SAR / timezone Asia/Riyadh follow the Place's own geography
--   (Master 01: "Currency follows Place"). Nothing is forced to IDR.
--
-- RULES HONOURED
-- - AGENTS.md IDEMPOTENCY: `on conflict (id) do nothing`, so re-applying
--   never duplicates and never overwrites a curated flag an operator has set.
-- - Canonical eligibility only: published + complete profile + finite
--   coordinates, the exact fields `evaluateDiscoveryEligibility` reads. No
--   eligibility is faked and the engine is never bypassed — scores and stars
--   stay computed by the engine.
-- - The three canonical categories only (0033 CHECK); no new category.
-- - Nothing is destroyed: no existing row is updated or deleted, and no
--   non-Dummy Place is touched.

insert into public.places (
  id, name, short_description, category, type, area, address, contact_information,
  country_code, region_name, timezone, currency, latitude, longitude,
  claim_status, publication_status, is_dummy
)
values
  ('dummy-riyadh-olaya', 'Dummy Riyadh — Olaya', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Olaya, Riyadh. Not a real business.', 'Perdagangan & Jasa', 'experience', 'Olaya', 'Test fixture — Olaya, Riyadh 12211', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.6937, 46.6853, 'unverified', 'published', true),
  ('dummy-riyadh-king-fahd', 'Dummy Riyadh — King Fahd', 'Dummy Place (test data only): fixture for Discovery search-centre testing in King Fahd District, Riyadh. Not a real business.', 'Perdagangan & Jasa', 'experience', 'King Fahd', 'Test fixture — King Fahd, Riyadh 12272', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.7136, 46.6753, 'unverified', 'published', true),
  ('dummy-riyadh-malaz', 'Dummy Riyadh — Al Malaz', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Al Malaz, Riyadh. Not a real business.', 'Industri & Pengolahan', 'production', 'Al Malaz', 'Test fixture — Al Malaz, Riyadh 11564', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.6895, 46.7211, 'unverified', 'published', true),
  ('dummy-riyadh-nakheel', 'Dummy Riyadh — Nakheel', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Nakheel, Riyadh. Not a real business.', 'Sumber Daya Alam', 'experience', 'Nakheel', 'Test fixture — Nakheel, Riyadh 11581', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.8325, 46.6400, 'unverified', 'published', true),
  ('dummy-riyadh-kafd', 'Dummy Riyadh — Al Kafd', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Al Kafd, Riyadh. Not a real business.', 'Perdagangan & Jasa', 'experience', 'Al Kafd', 'Test fixture — Al Kafd, Riyadh 12271', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.7152, 46.6801, 'unverified', 'published', true),
  ('dummy-riyadh-yasmin', 'Dummy Riyadh — Yasmin', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Yasmin, Riyadh. Not a real business.', 'Industri & Pengolahan', 'production', 'Yasmin', 'Test fixture — Yasmin, Riyadh 12251', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.7058, 46.6918, 'unverified', 'published', true),
  ('dummy-riyadh-sulaymaniyah', 'Dummy Riyadh — Ad Sulaymaniyah', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Ad Sulaymaniyah, Riyadh. Not a real business.', 'Perdagangan & Jasa', 'experience', 'Ad Sulaymaniyah', 'Test fixture — Ad Sulaymaniyah, Riyadh 12241', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.7089, 46.6790, 'unverified', 'published', true),
  ('dummy-riyadh-umm-al-hamam', 'Dummy Riyadh — Umm Al Hamam', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Umm Al Hamam, Riyadh. Not a real business.', 'Industri & Pengolahan', 'production', 'Umm Al Hamam', 'Test fixture — Umm Al Hamam, Riyadh 12382', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.7833, 46.6661, 'unverified', 'published', true),
  ('dummy-riyadh-al-izza', 'Dummy Riyadh — Al Izza', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Al Izza, Riyadh. Not a real business.', 'Sumber Daya Alam', 'experience', 'Al Izza', 'Test fixture — Al Izza, Riyadh 14221', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.8241, 46.6432, 'unverified', 'published', true),
  ('dummy-riyadh-tahlia', 'Dummy Riyadh — Tahlia', 'Dummy Place (test data only): fixture for Discovery search-centre testing in Tahlia, Riyadh. Not a real business.', 'Perdagangan & Jasa', 'experience', 'Tahlia', 'Test fixture — Tahlia, Riyadh 12278', '', 'SA', 'Ash Sharqiyah', 'Asia/Riyadh', 'SAR', 24.7247, 46.6823, 'unverified', 'published', true)
on conflict (id) do nothing;