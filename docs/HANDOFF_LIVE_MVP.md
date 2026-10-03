# SINGGAH LOKAL — LIVE MVP HANDOFF

## 1. SOURCE OF TRUTH
- `AGENTS.md`
- `docs/masters/MASTER_INDEX_v1.0.md`
- `docs/masters/MASTER_LIVE_POLICY_v1.0.md`
- `docs/masters/MASTER_LIVE_TECH_v1.0.md`

Jangan mengulang pekerjaan yang sudah selesai.
Selalu audit `main` + Supabase DEV sebelum perubahan baru.

## 2. CURRENT MAIN
Latest verified commit on the Home/Map branch:
`fix/home-map-viewport-coverage` (PR #2, against `main`; `main` itself is
`2803adb` = merge of PR #1)

NOTE: repository history was squashed into a single root commit; earlier SHAs
such as `aa6cc74...` and `34561997...` are no longer reachable. Audit always
re-reads current `main`, never assumes prior SHAs.

Verified 2026-10-01 (PR #2): web test suite 721/722. The single failure is
`tests/discovery-aggregate.test.ts` dying with SIGKILL under whole-suite memory
pressure in this 1-CPU/2 GB sandbox; run alone it passes 8/8 (and
`tests/discovery-dev-dataset.test.ts` passes 5/5 alone and in the full run), so
it is an environment limit, not a regression. Lint 0 errors / 7 warnings
(baseline); `tsc --noEmit` clean; `next build` (28/28).

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
5. **Container resize:** the Home map box is sized in `vh`/`clamp`, so it can
   change size WITHOUT a `window` resize event (mobile browser chrome
   collapsing, orientation change, on-screen keyboard). Leaflet only
   re-measures on window resize, which used to leave the reported viewport —
   and therefore both Place rows — narrowed to an area that was no longer on
   screen. A `ResizeObserver` on the map container now re-measures and
   re-reports on a real size change (guarded, no polling, disconnected in
   teardown, no new global listener).
6. **User marker layer:** a dedicated `singgah-user-pane` (z-index 640) puts the
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

## 16. RESOLVED BY PRODUCT DECISION — AUTO-FIT VIEWPORT + HOME UI REFINEMENT (2026-10-03)

**Root cause.** The Home camera only ever framed ONE point: a fixed radius
(`CURATED_CAMERA_RADIUS_M` = 10 km for "Tempat Pilihan") around the active
center, or — for a city search — the geocoder's center alone. Because §15
made the visible viewport the ONLY coverage source for the markers and both
Place rows, a curated or regional Place that sat OUTSIDE that single frame was
never on screen and therefore missing from the list until the user zoomed out
by hand. Presenting that frame as the whole region was also simply wrong on a
country-wide dataset.

**The decision.** The camera frames the SPREAD of the relevant Places'
canonical coordinates.

1. **"Tempat Pilihan"** fits `cameraFitPlaces` — the map dataset with the
   VIEWPORT GATE REMOVED (canonical curated membership + the ordinary
   remainder). The curated 10 km value is no longer this tab's camera frame.
2. **Location search** fits `searchFitPlaces` — the canonical Places inside the
   searched region's own coverage box, not just the geocoding point. A search
   with no Place holding coordinates keeps that center.
3. **One shared mechanism** (`fitCamera` in `home-map.tsx`): 0 Places → the
   camera does not move at all; 1 Place → focused on that coordinate at
   `FIT_SINGLE_PLACE_ZOOM` (a degenerate box would jump to maxZoom); many →
   `fitBounds` with padding that reserves the floating chrome and the map
   controls (`resolveCameraFitPadding`, clamped to the real container size).
4. **No circular dependency:** the bounds dataset never reads `mapViewport` /
   `coverageViewport`; the markers still do. This is the whole point of the
   split.
5. **No recenter loop, manual pan/zoom respected:** both fits are gated on a
   NONCE the caller bumps only on an explicit action (choosing the tab, a new
   search answer). Marker refreshes, discovery polls, and viewport reports
   carry no nonce, and each trigger is recorded so it can never apply twice.
6. **No invented coordinates anywhere:** `boundsOfPoints([]) === null`, the
   collector is fail-closed on non-finite lat/lng, and no fallback city,
   country, or world view is ever produced.

**Also in this decision (presentation only):** Leaflet's `+/-` stack moved
BELOW both locate controls (offsets form one ladder: 190px → 240px → the 290px
CSS offset), the search info panel is now full-bleed on an OPAQUE background
(it was `bg-white/85` inside the capped content column, so the map showed
through), and both Place strips sit in a visible, `overflow-hidden` carousel
frame that keeps the horizontal snap-scroll.

**Explicitly NOT changed:** curated MEMBERSHIP still reads only the canonical
`places.is_curated` ids; the Discovery contract, ranking, and eligibility are
untouched; the distance tabs keep their ordered radius presets (1 < 5 < 10 km)
and still own the camera in normal modes; "Lokasi Saya" still centers the
newest real fix at the CURRENT zoom and never widens the frame; the viewport
is still the only coverage source for markers and rows; no backend, database,
RLS, Place-status, copy, logo, or route changed.

**Superseded wording (do NOT read these as current):** §14 items 1 and 2 (the
curated camera framing the same 10 km coverage, and the explicit "no marker
fitBounds" invariant) and the §15 sentence that a search recenters "at a zoom
that frames the search window" are superseded FOR THE CAMERA ONLY, for the two
paths named above. Everything else in §14/§15 stands. The distance tabs, their
radius values, and their camera presets are unchanged, so the same Master note
applies: `MASTER_LIVE_POLICY` §12.5 row 1 and `MASTER_LIVE_TECH` §9 still
describe the tabs as a radius list gate, and a Master version note is required
before those rows can be reworded.

Regression coverage: the new `tests/map-auto-fit-camera.test.ts` (the ten
acceptance rules, numbered AC 1–AC 10, including the executable 0/1/many
matrix and the padding-share arithmetic) plus amended assertions — never
deleted tests — in `map-current-location`, `map-viewport-coverage`,
`discovery-home-integration`, `home-location-search`, `home-map-first-ui`, and
`home-map-gesture`, which previously locked "no `fitBounds` anywhere",
"a fixed 10 km curated frame", and the old control offsets.

## 17. CORRECTION — LOCAL AREA COVERAGE + TRUTHFUL OVERLAYS (2026-10-03)

This section CORRECTS §16. Everything in §14/§15/§16 that is not named here
still stands, including the curated membership rule, the viewport-as-coverage
rule for markers and rows, the 0/1/many fit matrix, the chrome padding, the
control ladder, the carousel frames, and "Lokasi Saya" centering the newest real
fix at the CURRENT zoom.

1. **Root cause.** The bounds dataset from §16 was the whole content-filtered
   Place list. One focus ("Lokasi Saya" / "Tempat Pilihan") could therefore
   frame West Java and Riyadh in a SINGLE fit: a world view in which the
   viewer's own neighbourhood was a couple of pixels wide. There was also no
   trusted local-area boundary anywhere in the product to frame instead.
2. **The camera is now bounded by GEOGRAPHY, not by a radius**
   (`resolveLocalAreaCoverage` in `lib/live/ui.ts`, pure and unit-tested):
   - **Trusted boundary first** — the anchor Place (the nearest one to the real
     fix) carries canonical ISO 3166-1 `country_code` + ISO 3166-2 `region_name`
     values, validated server-side on every Place write against
     `country-region-data` (`lib/geo/countries.ts`). EVERY Place of that
     subdivision is framed, which is what "cover the local area as completely as
     possible" means for the real data;
   - **Adaptive fallback** — for an anchor without that geography, the area is
     the contiguous cluster around the fix, ending at the first Place at least
     `LOCAL_AREA_SEPARATION_RATIO` (3) times farther than the one before it. That
     rule is SCALE-FREE (it describes the shape of the data, not a distance in
     metres), so it is not a 10 km cap and not an arbitrary replacement radius;
   - **Fail-closed** — no usable fix (geolocation denied, nothing searched) or no
     Place with canonical coordinates yields an EMPTY dataset, so the camera
     keeps its current view. There is no fallback to the whole database and no
     invented coordinate anywhere.
3. **"Lokasi Saya" itself is unchanged:** it still centers the newest real fix
   at the CURRENT zoom and can never zoom out (§15 item 3), so it can never
   frame anything global. What changed is that every fit it can trigger is
   bounded to the local area.
4. **The frame an explicit request produced now STAYS.** `cameraRequestNonce`
   is bumped only by the three hand-driven camera actions (a distance tab,
   "Tempat Pilihan", "Lokasi Saya") and is the only thing that releases the
   manual-interaction latch, which is re-armed the moment such a request
   applies. A fresh geolocation fix, a marker refresh, a discovery poll, or a
   viewport report can no longer take the camera back — that was the last
   "the frame jumps again a moment later" behaviour, and it needed no timer.
5. **Coverage caption.** A radius may be named only while a radius preset owns
   the frame. "Tempat Pilihan" and "Lokasi Saya" frame the local area, so the
   retired fixed "10 km" wording (which claimed a radius the camera was not
   using) is replaced by `AREA_COVERAGE_CAPTION` — "Menampilkan tempat di area
   peta". The distance tabs keep their radius caption, because per §16 they
   still own the camera in those modes.
6. **The corner bar is a REAL scale bar now** (`resolveMapScale` + the new
   `onScaleChange` callback). It used to print the active camera radius as if
   it were the map's scale; it now states a round distance measured from the
   map's own viewport bounds and measured width, drawn at that distance's exact
   pixel length, and draws nothing at all when nothing is measurable.
7. **Results panel compacted.** The map window moved one clamp band lower
   (36vh / 240 / 440 / 38vh on ≥sm) and the panel, its handle, its header
   block, and both carousel frames gave up the padding they did not need. The
   title, the count, the "Ke hasil" link, the category labels, both strips, and
   the `-mt-5` tuck are unchanged — nothing was cut or made scrollable.
8. **Explicitly NOT changed:** curated MEMBERSHIP still reads only the canonical
   `places.is_curated` ids; the Discovery contract, ranking, and eligibility are
   untouched; the search mechanism, its ±0.05° box, and the Riyadh result set
   are byte-for-byte the pre-existing ones; the distance tabs keep their ordered
   radius presets; no backend, database, RLS, Place-status, copy, logo, or route
   changed; no Place coordinate is invented, defaulted, or rounded.
9. **Known environment limitation (not a product defect):** the managed preview
   serves this Next.js app without hydrating in any headless browser available
   in the sandbox (verified identical on the unmodified baseline), so no real
   mobile screenshot of a live Leaflet map could be captured. The framing rule
   itself is covered executably instead — `tests/map-local-area-coverage.test.ts`
   runs the real resolver against the real migration 0040 Riyadh coordinates and
   the West Java fixtures.

Regression coverage: the new `tests/map-local-area-coverage.test.ts` (the ten
acceptance rules of this correction) plus amended — never deleted — assertions in
`map-auto-fit-camera`, `map-current-location`, `map-viewport-coverage`,
`discovery-home-integration`, `home-map-first-ui`, and `home-search-clarity`,
which previously locked "no `fitBounds` anywhere", the fixed 10 km curated
frame, the old control offsets, the old map window, and the radius-as-scale
readout.

## 18. CORRECTION — "LOKASI SAYA" REFITS THE LOCAL AREA; SELECTED-PLACES FIT (2026-10-03)

This section corrects the §17 items it names. Everything else in §14–§17 still
stands: the curated membership rule, the viewport-as-coverage rule for markers
and rows, the 0/1/many fit matrix, the chrome padding, the control ladder, the
carousel frames, the local-area resolver, the real scale bar, and the neutral
area caption.

1. **§17 item 3 is SUPERSEDED: "Lokasi Saya" now REFITS, it does not only
   recentre.** The explicit "My Location" press frames the eligible local Place
   distribution around the user's own coordinate. The previous behaviour (a
   `setView`/`flyTo` at the preserved zoom) is exactly what left the map at a
   broad, inappropriate level with distant Places on screen, so it is gone:
   there is no "preserve the current zoom" rule on this path any more.
2. **It reuses ONE mechanism.** The same `fitCamera`, the same
   `resolveCameraFitPadding` chrome/control padding, the same instant apply
   (`animate: false`) and the same one-shot pin pulse as the curated refocus.
   No second camera system was added; the new `locateFitPlaces` prop only
   separates the TRIGGER and the FALLBACK, so neither path can fire for the
   other's reason.
3. **The explicit case matrix**, all inside the locate effect:
   - many local Places → `fitBounds` over them, padded, zoomed out as far as
     that distribution requires;
   - one local Place → the frame is that Place plus the user's coordinate
     (`VIEWER_FIT_POINT_ID`, geometry only, never a Place row), focused at a
     sensible level; `LOCATE_FIT_MAX_ZOOM` is a ZOOM LEVEL, never a radius, and
     can only widen the frame, so no candidate can be dropped by it;
   - no local Place → `setView` on the USER'S OWN coordinate at the close
     floor and stop: never a distant Place, never the whole dataset, never an
     invented point;
   - no fix at all (denied/timeout) → the request stays PENDING and no camera
     move happens; there is no global fit in any branch.
4. **Still no radius and still no loop.** No fixed 10 km boundary exists on this
   path, the fit is keyed on `locateNonce` alone, and the frame is LATCHED, so
   marker refreshes, viewport reports, discovery polls, and a later geolocation
   fix cannot take it back. Manual pan/zoom survives until the user asks again.
5. **"Tempat Pilihan" now fits the eligible SELECTED Places only.** The camera
   pool is `visiblePlaces`, which in that mode already resolves canonical
   `places.is_curated` membership. The ordinary non-curated remainder remains a
   MARKER-layer rule (§15 item 2, still in `mapPlaces`) and must not steer the
   camera. Curated eligibility, the curated list, and the row counts are
   unchanged.
6. **The eased "Lokasi Saya" transition is retired** (`LOCATE_TRANSITION_MS`,
   `prefersReducedMotion`). A frame that can span a whole neighbourhood must not
   be animated: every camera apply in this component is now instant, and the
   bounded pin pulse is the feedback. `prefers-reduced-motion` therefore holds
   unconditionally.
7. **Panel compacted further** (`pt-2 pb-1`, handle `mb-1.5`, header `mb-2`,
   frames `py-1.5`, strips `pb-1`) on top of the §17 map-window change. The map
   window stays at 36vh/240/440 deliberately: the floating control ladder
   (190 / 240 / 290 px) plus the coverage box needs ~420 px of map height, so
   shrinking it further would put the zoom controls ON the overlay.
8. **Explicitly NOT changed:** search (mechanism, ±0.05° box, Riyadh results,
   camera), the distance tabs and their ordered radius presets, the overlay
   text (`AREA_COVERAGE_CAPTION` = "Menampilkan tempat di area peta") and the
   measured scale bar, curated membership, the Discovery contract, Place data,
   database, RLS, branding, and routes.

Regression coverage: `tests/map-local-area-coverage.test.ts` gained the
executable "My Location" matrix (refit, all candidates, single Place, no Place,
denied geolocation, apply-once/latch) and the Selected-Places fit pool; the
assertions in `map-current-location`, `map-viewport-coverage`,
`map-auto-fit-camera`, and `home-map-first-ui` that locked the OLD locate
behaviour (zoom-preserving recentre, one bounded flyTo, radius-at-the-time) were
amended, never deleted.
