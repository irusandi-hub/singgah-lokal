# SINGGAH LOKAL — LIVE MVP HANDOFF

## 1. SOURCE OF TRUTH
- `AGENTS.md`
- `docs/masters/MASTER_INDEX_v1.0.md`
- `docs/masters/MASTER_LIVE_POLICY_v1.0.md`
- `docs/masters/MASTER_LIVE_TECH_v1.0.md`

Jangan mengulang pekerjaan yang sudah selesai.
Selalu audit `main` + Supabase DEV sebelum perubahan baru.

## 2. CURRENT MAIN
Latest verified commit:
`9ce303c` — `fix: make the visible Leaflet viewport the Home map coverage source`
(branch `fix/home-map-viewport-coverage`, PR against `main`; `main` itself is
`2803adb` = merge of PR #1)

NOTE: repository history was squashed into a single root commit; earlier SHAs
such as `aa6cc74...` and `34561997...` are no longer reachable. Audit always
re-reads current `main`, never assumes prior SHAs.

Verified 2026-10-01: web test suite 719/721 — the two failures are
`tests/discovery-aggregate.test.ts` and `tests/discovery-dev-dataset.test.ts`
dying with SIGKILL inside this 1-CPU/2 GB sandbox (identical on the unmodified
baseline, so environment, not regression); `discovery-dev-dataset` passes 5/5
when run alone. Lint 0 errors / 7 warnings (baseline); `tsc --noEmit` clean;
`next build` (28/28).

## 3. LIVE IMPLEMENTATION STATUS

### Completed
- Live schema + RLS
- Live eligibility
- Producer authorization
- Start/end Live
- End idempotency
- Duration cap
- Stage-unpublish auto-end
- Moderation
- Reports
- Viewer admission
- Comment moderation
- Cloudflare Stream integration
- WebRTC/WHIP ingest
- WHEP playback
- Signed playback token
- Private Supabase Realtime
- Realtime viewer admission gate
- Realtime status broadcast from DB
- Realtime end broadcast non-blocking
- Viewer-cap admission race guard (100-concurrent)
- Home map marker escaping
- DB regression harness
- Vercel build/deployment verification

## 4. IMPORTANT SECURITY / POLICY
- Anonymous viewing: OFF
- Unverified email: DENY
- Age eligibility: DENY ALL until Phase 2.1 age-verification mechanism exists
- Minimum viewer age: 18
- Comments: authenticated + verified + eligible
- Max comment: 300 chars
- No monetization/payment/tipping
- Recording: OFF
- Fixed camera only
- One active Live per Place
- Global active Live cap: 5
- Viewer cap: 100
- Max duration: 60 minutes
- Provider secrets server-side only
- Realtime private channels only
- Supabase Realtime public access: OFF

## 5. SUPABASE DEV
Project:
`qiwexmzbysujmqctrsiq`

Status:
ACTIVE_HEALTHY

Live tables:
- `live_sessions`
- `live_viewers`
- `live_reports`
- `live_eligibility`
- `live_audit`

Current Live RPC contract includes:
`end_live_session(text,text,text,text)`

Migration through:
`0037_dev_demo_discovery_dataset.sql`

Full applied chain also includes `0033` (Discovery category/currency),
`0035` (`places.is_curated` — Tempat Pilihan flag), `0036` (Discovery demo
follows) and `0037`. The Live portion ends at
`0027_live_viewer_cap_race_guard.sql`. All are applied in DEV; none may be
recreated.

Verified 2026-09-30 DEV dataset state:
Places 64 · Published 64 · Readiness complete 64 · Demo Discovery Places 10 ·
Demo follows 10 · Duplicate Place ids 0 · Invalid category 0 · Invalid
currency 0.

### Discovery implementation status
LOCKED and implemented (contract `docs/DISCOVERY_CONTRACT_v1.0.md`):
- Discovery engine (eligibility / score / stars / ranking) — single source of
  truth in `web/lib/discovery/scoring.ts`
- Canonical signal assembly through the ONE repository read path
- Home Discovery Place row renders the canonical `discovery.discovery` ids
- Admin read-only Discovery view with an additive score breakdown
- Tempat Pilihan (`is_curated`) stays a separate Admin-promoted layer
- Regression tests: `discovery-scoring`, `discovery-home-integration`,
  `discovery-admin-breakdown`, `discovery-dev-dataset`

## 6. OPERATIONAL BLOCKERS
These are intentionally not solved by changing application policy:

### B1
Age-verification mechanism is not implemented.
Therefore viewer admission remains fail-closed.

### B4
Cloudflare Stream production credentials/signing key must exist before real Live start:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_STREAM_SIGNING_KEY`
- `CLOUDFLARE_STREAM_SIGNING_KEY_ID`

Do not request credentials in source code or commit them.

### B2
Platform moderator role assignment remains an operational task when moderation is tested.

## 7. REALTIME
Realtime:
- private channels
- topic: `live_session:<sessionId>`
- status/comment broadcast
- DB remains canonical
- Realtime is display transport only
- Supabase Dashboard: Allow public access OFF

## 8. NEXT AUDIT TARGET
Before coding anything new, inspect current `main` and Supabase DEV.

Priority files:
- `web/app/api/live/playback/route.ts`
- `web/app/api/producer/live/sessions/route.ts`
- `web/lib/live/session-service.ts`
- `web/lib/live/cloudflare.ts`
- `web/lib/live/comment-moderation.ts`
- `web/app/api/live/reports/route.ts`
- Home/map components

Verify:
1. Cloudflare input lifecycle + orphan cleanup
2. Playback admission/token flow
3. Comment rate limiting
4. Realtime publish failure handling
5. Viewer-cap semantics
6. Home filter bar matches the current locked set exactly
   (PO 2026-09-26 removed the 500 m radius — see `lib/live/ui.ts`):
   `LIVE | Tempat Pilihan | 1 km | 5 km | 10 km+`
7. No stale `Di sekitar saya`
8. No stale time filters
9. No TODO/FIXME or duplicate implementation
10. Regression tests remain aligned with current RPC signatures
11. The Discovery Place row still renders only canonical eligible ids (no
    published-list fallback), and an empty curated set stays empty

## 9. DO NOT
- Do not redesign UI/brand.
- Do not add payment/checkout.
- Do not add generic tourism/product categories.
- Do not weaken Live safety gates.
- Do not expose provider secrets.
- Do not bypass server-side authorization.
- Do not delete migrations/data/infrastructure.
- Do not repeat completed implementation.
- Do not modify policy/master decisions without explicit evidence.
- Do not commit until tests pass.

## 10. WORKFLOW
For every new task:

AUDIT latest `main`
→ compare Master
→ inspect Supabase DEV
→ identify concrete gap
→ implement only the gap
→ lint/test/build/regression
→ commit
→ push
→ re-read latest `main`
→ verify Supabase if DB-related

Every completed stage must be committed/pushed so the next audit starts from fresh `main`.

## 11. CURRENT PRINCIPLE
The target is functional MVP flow:

Home/Map
→ nearby Place
→ distance/LIVE
→ process
→ Place
→ Live process
→ Experience
→ SINGGAH
→ Visit Intent
→ Producer

Focus on real technical gaps only.

## 12. NON-NEGOTIABLE WORK DISCIPLINE
1. Latest actual project state adalah source of truth. Chat history hanya context dan tidak boleh mengalahkan evidence terbaru dari repository, tests, atau Supabase.
2. Untuk setiap task, tentukan SATU concrete unfinished MVP gap berdasarkan main terbaru + Master yang relevan.
3. Jangan mengulang pekerjaan yang sudah selesai, stale audit, atau fix yang sudah terverifikasi.
4. Jangan memperluas scope ke area yang tidak berhubungan langsung dengan task aktif.
5. Jangan mengarang product decision, copy, category, flow, preference, atau technical requirement.
6. One task = one goal = one scope = finish. Setelah selesai, lanjut ke gap nyata berikutnya.
7. Jika pekerjaan dapat dilakukan langsung, lakukan langsung. Jangan mendelegasikan tanpa alasan akses.
8. Jika agent diperlukan, satu prompt harus lengkap: CODING → TEST → COMMIT → PUSH → VERIFY. Jangan meminta user mengirim prompt berulang untuk task yang sama.
9. Setelah agent selesai, verifikasi hasil terbaru sebelum menentukan task berikutnya.
10. Item yang sudah selesai dianggap LOCKED. Jangan disentuh lagi kecuali ada regression atau requirement baru yang dibuktikan.
11. Jika benar-benar blocked oleh keputusan produk, catat blocker secara spesifik dan jangan membuat implementasi berdasarkan asumsi.
12. Semua keputusan kerja harus berdasarkan data terbaru, bukan daftar task lama atau riwayat percakapan.

## 13. OPEN BLOCKER — TEMPAT PILIHAN MAP IS EMPTY ON DEV (needs product decision)

Audited 2026-09-30 on `main` (`b6c8c93`) with Supabase DEV at 64 published
Places and **0 `places.is_curated = true`**.

Reported state: a Place is visible at the 1 km / 5 km / 10 km+ tabs, but
"Tempat Pilihan" widens the camera and the map becomes empty.

Traced chain (all in `web/components/home-discovery.tsx`):

`discovery.curatedPlaceIds` → `curatedIdSet` (∅ on DEV) → `visiblePlaces`
(`if (curatedOnly) return searchFiltered.filter(...)` → `[]`) →
`curatedListed` = `[]`, `discoveryRowPlaces` = [] while `curatedOnly`
(curated mode renders only the curated row) → `mapPlaces` = [] →
`mapEmptyStateVisible = mapPlaces.length === 0 || ...` = true → the overlay
"Belum ada Tempat Pilihan di sekitar area ini" shows and zero markers render.
The wider frame is the locked 50 km `CURATED_CAMERA_RADIUS_M` preset.

**Conclusion: this is the truthful, locked behavior, not a defect.** The empty
curated layer produces an empty curated map, and the 50 km camera value is
CAMERA-ONLY — it can never widen the dataset (`docs/DISCOVERY_CONTRACT_v1.0.md`
§0.4/§0.5, test case 13/16). Discovery Places and Tempat Pilihan are two
independent layers.

**The conflict, stated exactly:** making "Tempat Pilihan" show Discovery
Places when no Place is curated (a) contradicts contract §0.4 ("Tempat Pilihan
stays separate — nothing here changes it") and §0.5 (layer independence),
(b) contradicts test case 16 (an empty curated set must never fall back to the
full published set), and (c) would require a new curation rule that no Master
defines. No code change was made for it; regression coverage now locks the
whole chain (`tests/discovery-home-integration.test.ts`, curated-empty-set
cases) so the empty state can never silently become a published fallback.

**Decision needed from the product owner:** either (1) keep the empty state
until an Admin promotes Places to `is_curated` (data action, no code), or
(2) define an explicit new rule for what the curated layer shows when no Place
is curated. Option 2 is a Master/contract change and must not be implemented
from an assumption.

## 14. RESOLVED BY PRODUCT DECISION — HOME CAMERA 10 KM + CURATED MAP (2026-09-30)

The product owner decided the blocker in §13 explicitly. This supersedes the
earlier "instant camera / 50 km curated / 15 km locate" values; nothing else in
the Discovery contract changed.

1. **Three Home camera contexts, all 10,000 m** — `Tempat Pilihan`, the `10 km+`
   tab, and `Lokasi Saya` frame the SAME 10 km coverage around the real Current
   Location (`CAMERA_PRESET_RADIUS_M["10 km+"]`, `CURATED_CAMERA_RADIUS_M`,
   `CURRENT_LOCATION_CAMERA_RADIUS_M` = `10_000`). The retired values are the
   12 km tab coverage, the 50 km curated frame, and the 15 km locate coverage.
   Distance tabs stay strictly ordered 1 km < 5 km < 10 km.
2. **Curated map = curated + ordinary Places in coverage.** On the
   "Tempat Pilihan" map the dataset is every curated published Place PLUS the
   NON-curated published Places within `CURATED_MAP_COVERAGE_RADIUS_M` (10 km)
   of the real fix (`curatedCoveragePlaces` in `web/components/home-discovery.tsx`).
   With no real fix there is no coverage to measure, so every published Place
   with canonical coordinates is shown.
3. **Curated membership is unchanged.** It still comes only from canonical
   `places.is_curated` through the view model. The coverage Places keep their
   ordinary marker treatment, never become curated, and never enter the curated
   LIST or its counter — the curated list stays curated-only, and Discovery is
   never used as a fallback. This satisfies contract test case 16: the curated
   RESULT is still an empty set when nothing is curated.
4. **Exactly two Place marker treatments**, chosen per PLACE (not per mode):
   NORMAL (brown) and CURATED (secondary green + ✦ accent) on the same
   teardrop base pin. `curatedMarkers` (mode-level) was removed.
5. **Lokasi Saya** centers on the newest REAL fix at the 10 km coverage with one
   SHORT, light transition (`LOCATE_TRANSITION_MS = 350 ms`), disabled when the
   viewer prefers reduced motion (instant apply instead). Preset/tab changes
   stay instant. No fly-through, no marker fitBounds, no invented coordinates,
   and the selected tab/filter state is never mutated.
6. **Current Location pin pulse** is bounded (`LOCATE_PULSE_MS = 900 ms`, two
   cycles, never infinite), starts BEFORE the camera move so it covers the
   transition, and is PENDING when the pin element does not exist yet — the
   user-marker effect applies it when the asynchronous marker is created.

The "instant camera" rule from 2026-09-30 applies to preset changes only; the
locate recenter intentionally animates. Regression coverage:
`tests/map-current-location.test.ts` (camera values, transition bounds,
reduced motion, pulse lifecycle, per-Place marker treatment) and
`tests/discovery-home-integration.test.ts` (curated map vs curated list,
membership, Discovery independence).

## 15. RESOLVED BY PRODUCT DECISION — VIEWPORT AS HOME COVERAGE (2026-10-01)

This supersedes §14 items 2 and 5 only. Everything else in §14 (instant preset
camera, per-Place marker treatment, bounded one-shot pulse, curated membership
from `places.is_curated` only) still holds.

1. **The visible Leaflet viewport is the ONLY geographic coverage source.**
   `HomeMap` reports its real bounds (`onViewportChange`) on readiness, on
   every finished move/zoom, and on resize, deduped by exact bounds equality.
   The markers, the Discovery Place row, and the "Tempat Pilihan" row are all
   narrowed by that viewport. 1 km / 5 km / 10 km+ remain CAMERA presets
   (`CAMERA_PRESET_RADIUS_M`) and no longer decide any Place. Viewport
   narrowing can only REMOVE canonical entries — never add, re-order, or make
   an ineligible Place eligible. A Place without canonical coordinates is
   never placed and never listed.
2. **Curated map coverage** is the non-curated remainder INSIDE the viewport
   (`curatedCoveragePlaces`), so the curated map still shows curated + ordinary
   Places while the curated LIST stays curated-only and never falls back to
   all published Places. `CURATED_MAP_COVERAGE_RADIUS_M` is deleted.
3. **"Lokasi Saya"** centers the newest real fix on the CURRENT zoom
   (`Math.max(map.getZoom(), LOCATE_MIN_ZOOM)` — it can raise a farther zoom to
   a close floor but never zooms out). `CURRENT_LOCATION_CAMERA_RADIUS_M` is
   deleted. A denied/timeout fix writes no position and moves no camera; the
   selected tab is never read or mutated.
4. **Map interaction root cause fixed:** the floating search/filter wrapper
   spanned the whole map window (it also holds the invisible map-height
   spacer) and intercepted every zoom click, drag, and pinch on the map. It is
   `pointer-events-none` now; the search bar and filter row opt back in with
   `pointer-events-auto`, and the empty state, coverage box, scale, and badge
   are click-through too. The map container keeps `touch-none`
   (`touch-action: none`), so a pinch on the map zooms the map, never the page.
5. **User marker layer:** a dedicated `singgah-user-pane` (z-index 640) puts the
   Current Location disc above every Place pin (markerPane 600) and below
   tooltips (650). Previously the disc rendered in overlayPane (400) and could
   disappear behind Place pins.

Master note (do NOT edit the Masters): `MASTER_LIVE_POLICY` §12.5 row 1 and
`MASTER_LIVE_TECH` §9 still describe the distance tabs as a radius list gate.
That wording is superseded by this decision for the HOME list/map path only —
the tab set, their radius values, and their camera presets are unchanged. A
Master version note is required before those rows can be reworded.

Regression coverage: `tests/map-viewport-coverage.test.ts` (15 numbered items:
canonical-only narrowing, viewport-only coverage, finished-gesture updates,
curated membership + overlap, no published fallback, search/LIVE, coordinate
fail-closed, locate without zoom-out, user-marker pane, control reachability,
no RLS/scoring/canonical-read regression, map lifecycle, and the two distinct
empty states) plus the updated `map-current-location`, `map-empty-state`,
`map-stacking`, `home-map-first-ui`, `live-hardening`, and
`discovery-home-integration` suites.
