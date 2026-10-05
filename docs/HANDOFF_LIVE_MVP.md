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

### Home discovery improvements (branch `fix/home-discovery-improvements`, 2026-10-04)
- Home location search is now SUBMIT-ONLY: typing never geocodes; the single
  geocode runs on Enter/submit (`handleSearchSubmit`), guarded by the same
  search-epoch + submitted-query checks. No empty submit ever geocodes.
- The search bar's right control is CONDITIONAL: a real clear "×" button while
  the query is non-empty, the decorative (aria-hidden) control icon while empty.
- Both Home result rows (`curatedListed`, `discoveryRowPlaces`) are VERTICAL
  full-width lists instead of horizontal snap-carousels; the old carousel
  frames are gone. Dataset, order, eligibility, and cards are unchanged —
  presentation only.
- Camera/geographic rules, coverage, radius presets, and the server-only
  geocoding path are untouched.
- Files: `web/components/home-discovery.tsx` + 10 home/map test files.
- Verification: targeted home/map suites 191/191 and 144/144; `tsc -b --noEmit`
  clean; `eslint .` 0 errors, 10 pre-existing warnings (none in
  `home-discovery.tsx`).

### Home map polish (2026-10-04, second change set)
- **Tempat Pilihan frames ALL curated Places.** In curated mode the camera fit
  dataset is the full canonical curated set (`places.is_curated` over the full
  published set), not a local-area subset, so the whole selection is on screen
  at a comfortable density (zoom ceiling `CURATED_FIT_MAX_ZOOM = 13`) —
  whether it was entered from the tab, "Lokasi Saya", or a search.
- **Always-visible Place names.** Each Place pin carries its name as a compact
  truncated chip (`.singgah-pin-label`, 11px/700) beneath the anchor; the
  full-name hover/focus tooltip is unchanged.
- **"Lokasi Saya" surrounding area.** The Current Location pin draws a soft
  translucent disc (`.singgah-locate-area`, ~350 m, gently breathing) so the
  press reads as "the area around me". Display only — never a coverage radius.
- **Smooth view-distance transitions.** ONE helper `cameraAnimationOptions()`
  (0.6 s, ease 0.25) owns the camera easing for every view change (preset tabs,
  curated fit, locate, search); `prefers-reduced-motion` falls back to instant.
- Camera authority, the manual-interaction latch, coverage, radius ordering, and
  the server-only geocoding path are untouched.
- Files: `web/components/home-map.tsx`, `web/components/home-discovery.tsx`,
  `web/app/globals.css` + the home/map test files.
- Verification: 364/364 across every home/map/globals suite; `tsc -b --noEmit`
  clean; `eslint .` 0 errors, 10 pre-existing warnings (unchanged).

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

## 19. CORRECTION — CAMERA SCOPE WITH NO ORIGIN + MOBILE MAP BUDGET (2026-10-03)

This section corrects the two items it names in §14–§18. Everything else still
stands: the curated membership rule, the viewport-as-coverage rule for markers
and rows, the 0/1/many fit matrix, the local-area resolver, the chrome padding,
the carousel frames, the measured scale bar, the neutral area caption, "Lokasi
Saya" clearing the city search and refitting the local area, and the curated
tab fitting the selected distribution.

### Phase 1 — audit and root cause

1. **The reported screen was the PREVIOUS production build.** `e8bc6d7`
   (PR #12) rendered the coverage box from `radiusCaption` directly, and in
   "Tempat Pilihan" mode `activeRadiusMeters` is `CURATED_CAMERA_RADIUS_M`
   (10 km) — so that build could print "… dalam radius 10 km dari lokasi Anda"
   while §16's fit framed the WHOLE content-filtered Place list. That is
   literally the reported pair: a world-scale frame with a "10 km dari lokasi
   Anda" caption. §17/§18 (merged as `642c4ae`, PR #13) already removed that
   half: the curated/locate fit is now bounded by `resolveLocalAreaCoverage`
   and the caption is `AREA_COVERAGE_CAPTION` in the local-area modes.
2. **The second half of the defect was still on `main`.** The camera has
   exactly ONE anchor: `activeCenter` = the searched city, else the REAL device
   fix. With geolocation denied (or never granted) and nothing searched,
   `resolveActiveCenter` answers `{ mode: "device_location", center: null }`,
   so in `home-map.tsx` the anchor effect returned at
   `if (!ready || !map || !anchor) return;` — **the chosen distance preset was
   never applied, on first load and on every later tap of a distance tab.** The
   map therefore kept the neutral `map.fitWorld()` frame created at init. That
   viewport contains the entire canonical dataset (production: 74 Places, 12 in
   Jawa Barat and 62 across five Saudi regions, ~13,000 km apart), so
   `narrowToViewport` admitted EVERY Place: markers on two continents and every
   card listed — "markers clustered or geographically disconnected from the
   displayed Place results". Meanwhile the coverage box still printed
   "… dari lokasi Anda" and the count still printed "di sekitar Anda": both
   false, because there is no location at all.
3. **A third, smaller leak in the same path.** The preset guard was
   `if (userInteracted && lastRadius === cameraRadiusMeters) return;`, so ANY
   change of the radius VALUE re-armed the preset. "Tempat Pilihan" passes
   `CURATED_CAMERA_RADIUS_M`, and leaving that layer through the LIVE toggle
   changes the radius back to the distance tab with no camera request at all —
   silently snapping the map to a 1 km device frame and discarding a manual pan.

Nothing was changed until this was established from the code, from the
deployed bundle, and from the canonical dataset.

### Phase 2 — what changed

1. **No origin → no radius claim, anywhere.** `describeCoverageCaption` in
   `lib/live/ui.ts` now owns BOTH halves of the existing rule: a radius is
   named only while a distance-tab preset owns the frame AND an origin exists
   to measure it from. With no origin it returns the approved
   `AREA_COVERAGE_CAPTION` ("Menampilkan tempat di area peta") — the one string
   that is true at any zoom. `describeNearOrigin` gained the matching
   `hasCenter` flag and answers `NO_ORIGIN_AREA_LABEL` ("di area peta") instead
   of "di sekitar Anda". Both default to the previous behaviour, so the
   Master/MOCKUP §11 wording is preserved VERBATIM whenever a real origin
   exists. **No new product term and no new copy were invented.**
2. **No origin → still no invented camera move.** The neutral world overview
   stays (there is no coordinate that could honestly centre a radius, and
   AGENTS.md forbids fabricating one), and the map reports its real bounds and
   scale as before. The empty-coordinate rule from §17 is untouched.
3. **The camera is moved only by an explicit request.** The preset guard is now
   unconditional (`if (userInteractedRef.current) return;`) and the radius
   re-arm line is gone; `cameraRequestNonce` — already bumped by exactly the
   three hand-driven actions (a distance tab, "Tempat Pilihan", "Lokasi Saya")
   — is the only thing that releases the latch. A preset that DID apply now
   also latches, so a later geolocation fix, marker refresh, discovery poll, or
   viewport report cannot re-derive the frame underneath a pan.
4. **Mobile map budget (the confirmed layout defect).** The floating control
   ladder is a fixed slice of the stage height: Re-center 190→234px, "Lokasi
   Saya" 240→~281px, Leaflet's +/- stack 290→~354px, coverage box/scale from
   ~366px. The map window's floor was `min-h-[240px]`, so the section — which
   clips its own overflow — ended ABOVE the bottom of the zoom control and the
   "+/-" stack was cut off on an ordinary phone. The window is now
   `h-[42vh] min-h-[440px] max-h-[560px] sm:h-[46vh]`, which clears the whole
   ladder plus the coverage box at every supported width (360 / 390 / 430 /
   1280) and gives the map more of the screen, as reported. Nothing was hidden,
   collapsed, made scrollable, or redesigned: same sections, same search bar,
   same filter row, same branding, same cards.

### Phase 3 — explicitly NOT changed

Curated MEMBERSHIP still reads only the canonical `places.is_curated` ids; the
Discovery contract, ranking, and eligibility are untouched; the distance tabs
and their ordered radius presets (1 < 5 < 10 km) are unchanged, as is the
search mechanism and its ±0.05° box; markers, the LIVE treatment, Place cards,
navigation, the scale bar, the backend, the database, RLS, Place data,
branding, and routes are all unchanged.

### Phase 4 — regression coverage and verification

`tests/map-local-area-coverage.test.ts` gained section 10 — the nine named
areas (distance-preset centre and radius; searched city vs device; "Tempat
Pilihan"; no valid coordinates; widely spread coordinates; manual pan/zoom
persistence; marker refresh and viewport reports causing no camera loop;
radius caption consistency; mobile viewport and map controls) — with executable
assertions over the caption truth table, `resolveActiveCenter`, the real
two-continent DEV fixtures, and the control-ladder arithmetic. Assertions that
locked the superseded behaviour were amended, never deleted, in
`map-current-location`, `map-auto-fit-camera`, `home-map-first-ui`,
`home-search-clarity`, and `home-results-count-sync`.

Verified on `fix/home-map-camera-scope`: 16 map/search/Discovery suites
258 pass / 0 fail; full suite in four batches 301 / 306 / 154 (1 pre-existing
failure) / 113, the failure being `place-management.test.ts` → "Only IDR and
USD are valid currencies", reproduced identically on unmodified `origin/main`
and unrelated to this work (`discovery-aggregate` and `discovery-dev-dataset`
remain excluded: PGlite is OOM-killed in this 1-CPU/2 GB sandbox);
`eslint .` 0 errors / 10 warnings (baseline unchanged); `tsc -b --noEmit` clean;
`next build` exit 0.

The live screen cannot be re-inspected from here: the managed preview serves
this app without hydrating in any headless browser available in the sandbox
(verified identical on the unmodified baseline `main`). The root cause above
was therefore established from the code, from the deployed bundle, and from the
canonical dataset — not from observation — and every rule is covered
executably instead.

## 20. CORRECTION — CURATED FRAME CONTEXT, ONE INFORMATION AREA, MARKER LADDER (2026-10-03)

This section corrects the three items it names. Everything in §14–§19 still
stands: curated MEMBERSHIP from canonical `places.is_curated` only, the
viewport-as-coverage rule for markers and rows, the 0/1/many fit matrix, the
local-area resolver, the explicit-request camera latch, the chrome padding, the
control ladder, the carousel frames, the measured scale bar, and "Lokasi Saya"
clearing the search and refitting.

1. **ROOT CAUSE — the over-tight curated frame.** Since §18 item 5 the curated
   camera pool was `visiblePlaces`, which in that mode IS the curated set, so
   the fit framed exactly the pins that were already on screen. One curated
   Place therefore collapsed to a single-point frame with no surrounding
   context, which reads as a broken zoom rather than as "here is your
   selection". §13's local-area bounding was NOT the cause and is unchanged.
2. **THE FIX.** `cameraFitPlaces` in curated mode is now the selected local area
   PLUS camera CONTEXT: the ordinary, coordinate-valid Places of that SAME
   local area, resolved by re-running `resolveLocalAreaCoverage` ANCHORED ON
   THE SELECTED ANCHOR PLACE'S OWN COORDINATE. Anchoring on the selection —
   never on the device fix — is what keeps the frame local (a distant Place or
   a viewer on another continent cannot expand it) and is why "Tempat Pilihan"
   is no longer framed by the device alone. The context is CAMERA geometry
   only: it never enters the curated list, the curated count, curated
   membership, Discovery, or any row, so §14 item 3 and the OVERLAP rule are
   untouched. Fail-closed: an empty local area, or a selected anchor without
   real coordinates, frames the selection alone or nothing at all. The pool
   still reads no viewport state and is still keyed on `fitNonce` alone.
   `locateFitPlaces` is unchanged in meaning (§18): it is the selected local
   area, now named `selectedFitPlaces`.
3. **ROOT CAUSE — two information panels.** A floating coverage box over the
   map and the results panel header each stated the same geographic fact in a
   different shape, permanently covering the bottom-left of the map.
4. **THE CONSOLIDATION.** The floating box is removed. ONE compact line in the
   results panel header now carries everything: the per-layer count (unchanged
   arrays, Master/MOCKUP §11 wording verbatim), the origin, and the SCOPE
   fragment — `dalam radius 1 km` while a distance preset owns the frame and an
   origin exists, otherwise the approved `di area peta`. The scope fragment
   carries no origin and no count, so the place name is stated once and the
   number can never be printed twice. The measured scale bar is untouched: it is
   map chrome, not Home result context, and stays bottom-right. "Ke hasil", both
   strips, the carousel, the filters, and the empty/LIVE/error states are all
   unchanged.
5. **ROOT CAUSE — selected markers buried.** Leaflet orders Place pins inside
   one pane by a latitude-derived z-index plus a shared `zIndexOffset: 500`, so
   a selected pin could sit UNDER an ordinary one that sat slightly further
   north — the selection was the least visible thing on a map whose whole point
   is the selection.
6. **THE LADDER.** `zIndexOffset: isCurated ? 900 : live ? 0 : 500`, with the
   LIVE chip still at 1000 and the Current Location disc still in its own pane
   at 640. The flag is the existing per-Place `isCurated`, read once; artwork,
   colour, size, coordinates, tooltip, click, and keyboard behaviour are
   untouched. The offset is applied at marker construction, so Leaflet re-applies
   it on every pan, zoom, viewport report, poll, and rebuild — no effect,
   listener, `bringToFront`, or camera move is involved, and a recenter loop is
   not even possible. No clustering was invented; overlapping pins stay
   reachable through the existing click and keyboard-focus path.
7. **Explicitly NOT changed:** curated eligibility, ranking, membership, and
   every result count; the Discovery contract; the distance tabs and their
   ordered presets; the search mechanism and its ±0.05° box; LIVE; marker
   coordinates, artwork, and navigation; Place data, database, RLS, branding,
   and routes.
8. **Verification:** the new `tests/home-map-consolidated-frame.test.ts`
   (15 tests: one curated Place with context, multiple curated Places, distant
    exclusion, search center vs device, manual pan/zoom, no camera loop,
    consolidated line in every mode, no duplicate/contradictory information,
    panel footprint, marker ladder, order after refresh, interactions and the
    user marker, and no LIVE/search/navigation regression) plus amended — never
    deleted — assertions in `map-auto-fit-camera`, `map-local-area-coverage`,
    `map-current-location`, `map-viewport-coverage`, `map-stacking`,
    `discovery-home-integration`, `home-map-first-ui`, `home-search-clarity`,
    `home-results-count-sync`, and `place-card-direction-live`. Each amended
    assertion is annotated in place with the behaviour change that required it.
   Verified on this branch: map/Home/discovery suites 322 pass / 0 fail; full
   suite in four batches 316 / 313 / 151 (1 pre-existing failure) / 109, the
   failure being `place-management.test.ts` → "Only IDR and USD are valid
   currencies", pre-existing and unrelated (`discovery-aggregate` and
   `discovery-dev-dataset` remain excluded: PGlite is OOM-killed in this
   1-CPU/2 GB sandbox); `eslint .` 0 errors / 10 warnings (baseline); `tsc -b
   --noEmit` clean; `next build` exit 0.
---

## 21. RIYADH CURATED DATA + CAMERA ELIGIBILITY (2026-10-03)

Audit of the reported Riyadh findings against the canonical dataset, the
Masters, migrations 0035/0036/0039/0040/0041, and the production read path.

### 21.1 The data, verified

Re-queried `https://singgah-lokal.vercel.app/api/places` (74 published Places,
20 curated). The reported split reproduces exactly:

| country | region | curated | dummy | published |
| --- | --- | --- | --- | --- |
| SA | `Ar Riyad` | true | true | 10 |
| SA | `Riyadh` | false | false | 25 |

Zero published, non-dummy curated Places in Riyadh. The 10 curated ids are
`dummy-riyadh-{al-izza, kafd, king-fahd, malaz, nakheel, olaya,
sulaymaniyah, tahlia, umm-al-hamam, yasmin}`; the 25 real ones are
`dummy-riyadh-01` … `dummy-riyadh-25`.

### 21.2 Are the ten curated Dummies intentional? YES — settled from the Masters

This was NOT guessed, and the answer is the opposite of the intuitive one.

- `MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0` §2, canonical-flag table:
  *"Is it a Discovery input? **No.** The engine is dummy-blind; a Dummy Place
  is eligible on exactly the same canonical terms as any other Place."*
- Migration 0039 marked exactly the ten migration-0037 fixtures, by enumerated
  id (§3: never a text predicate). Migration 0040 seeded the ten Riyadh
  fixtures. Migration 0041 corrected their subdivision and states they
  *"stay exactly as 0040 left them, awaiting the Creator's audited
  `markRiyadhDummyPlacesCurated` call if and when that is wanted."*
- `web/lib/discovery/scoring.ts` already implements §2 in
  `evaluateDiscoveryEligibility` (it passes `isDummy: false` into the
  publication-readiness check so E1+E2 never reads the flag).

So the ten curated rows are INTENTIONAL demo curation produced by the audited
Creator path, and `listCuratedPublishedPlaceIds` selecting
`publication_status = 'published' AND is_curated` **without** excluding
`is_dummy` is CORRECT. Adding an `is_dummy` exclusion would invent an
eligibility rule the Master explicitly denies. The real Riyadh Places must
**not** be promoted to make the Dummies unnecessary — that is an admin data
decision, reported in §21.6, not an engineering fix.

### 21.3 Root cause — `region_name` is free text and was trusted as a boundary

`web/lib/live/ui.ts` `localityKey()` was
`` `${country}|${region.toLowerCase()}` `` and `resolveLocalAreaCoverage`
selected by exact key equality.

`Ar Riyad` is the ISO 3166-2 subdivision of Saudi Arabia (SA-01). **`Riyadh`
is not in the dataset at all** — it is the city. The dataset has 13 SA
subdivisions (`Ar Riyad`, `Ash Sharqiyah`, `Makkah al Mukarramah`, …) and
`Riyadh`, `Dammam`, `Al Khobar`, `Al Rakah` are all city names. All 35 Riyadh
Places sit in one real city (bounding boxes overlap: curated 24.6895–24.8325 /
46.6400–46.7211, real 24.5489–24.8457 / 46.5769–46.8084), yet the camera saw
two localities. Executed against the real resolver, two Places 5.7 km apart
(`dummy-riyadh-olaya` / `dummy-riyadh-01`) resolved to a single-Place area.

### 21.4 The fix (code only — no data, no migration, no curation change)

1. `web/lib/geo/countries.ts` gains `canonicalPlaceSubdivisionKey(country,
   region)`: an **exact** lookup in the same `country-region-data` vocabulary
   that already validates every Place write, returning the ISO identity
   (`"SA-01"`) or `null`. No alias table, no fuzzy or case-folded matching, no
   invented mapping — `"Riyadh"` stays `null`, and that is the finding being
   reported rather than hidden.
2. `localityKey()` now returns that canonical key. Two Places of one
   subdivision therefore always share a key, and an unverifiable value no
   longer pretends to be a boundary.
3. `resolveLocalAreaCoverage` keeps its two existing rules and adds one case:
   when the anchor HAS a verified subdivision, a candidate whose own
   subdivision cannot be verified is admitted by the **existing** adaptive
   proximity rule (`compactCluster`) rather than being dropped for a spelling.
   A candidate with a verified *different* subdivision is still refused
   outright — a real boundary always wins.

**Second-order defect found and closed while verifying.** `compactCluster`
decides on a *ratio* between successive distances, which is scale-free: a set
of Places all ~380 km away is internally "compact" and never trips the 3×
separation. Admitting unverifiable Places by that rule alone pulled the entire
Eastern Province curated set into a Riyadh frame. The admission is therefore
additionally bounded by **the reach of the anchor's own verified subdivision** —
the furthest that boundary demonstrably extends, measured from the origin, and
derived entirely from real Places with no invented kilometre figure. On the
real dataset that admits the genuine Riyadh Places (2.8–13.7 km) and refuses
both the far outliers and the Eastern Province (386 km). A subdivision with a
single Place has no measurable spread, so that case keeps the pre-existing
proximity rule alone rather than shrinking the area to the anchor.

### 21.5 What the camera now produces for the real Riyadh curated search

Against the production dataset, replicating `cameraFitPlaces` exactly:

- selected: **10** curated Places, `basis: "region"` (was: the same 10, but
  with no usable context);
- context: **25** real Riyadh Places resolved as context;
- `cameraFitPlaces`: **35**, of which **25 non-curated**;
- regions in frame: `Ar Riyad` + `Riyadh` only — no Eastern Province.

Context markers stay out of curated membership, the count, and the result rows
with **no component change at all**: `mapPlaces` already tags every Place with
`isCurated: curatedOnly && curatedIdSet.has(place.id)`, so a context Place is
`false`; the count line renders `curatedListed.length`; context enters only the
map layer and the camera, never `visiblePlaces`.

### 21.6 OPEN — needs an admin data decision (nothing was changed)

1. **Promote real Riyadh Places to `is_curated`?** Riyadh has zero non-dummy
   curated Places. If Tempat Pilihan is meant to show real content there, the
   candidates are `dummy-riyadh-01` … `dummy-riyadh-25` — but note their ids
   say "dummy" while `is_dummy = false`, so their provenance should be checked
   before any promotion. NOT executed: Master §6 gives only two audited tiers
   the power, and a bulk `is_curated` write is an admin decision.
2. **Repair `region_name` on the Saudi rows.** `isValidPlaceRegion("SA",
   "Riyadh")` is **false** — as it is for `Dammam`, `Al Khobar`, `Al Rakah`
   (35 of the 74 published Places in total). These values predate the
   validator and are stored verbatim, so they can never be corrected through
   the shared Place form. A DEV-only corrective migration in the shape of
   0041 (enumerated ids, guarded on the exact wrong value, DEV-only, never
   production) would fix them at source. NOT written and NOT applied.
3. **Demo data in the canonical dataset.** The published dataset still serves
   migration-0040 fixtures (migration 0041 is DEV-only by design, and the
   canonical dataset clearly still holds 0037/0040 rows). Whether that is
   intended for the canonical environment is a product decision. Nothing was
   changed.

### 21.7 Out of scope, noticed during the audit

`/api/places` returns `isDummy` on every public Place row (the repository
selects `*`). Master §8 calls dummy status "metadata for operators and
developers". Not changed here — it is outside this fix and outside the eight
tasks — but worth a decision.

### 21.8 Verification

- New `tests/riyadh-curated-camera-eligibility.test.ts` — 18 tests: the
  canonical mapping (`Ar Riyad` → `SA-01`; `Riyadh`/`Dammam`/`Al Khobar`/
  `Al Rakah` → `null`; exact-match, no case folding; wrong-country → `null`);
  the 5.7 km mismatch regression; the real 10 + 25 curated camera; a verified
  *other* subdivision refused even when adjacent; the far-cluster guard; the
  Eastern Province anchor; fail-closed on a missing origin and on missing
  coordinates; and dummy eligibility in both directions (a curated Dummy IS a
  member; a real Place is never promoted) with the server and in-memory
  curated predicates pinned as dummy-blind read paths. **2 of the 18 fail
  against `origin/main`'s `ui.ts`** and pass with the fix.
- Full suite in batches: 331 / 188 / 142 / 129 (1 pre-existing failure) / 118,
  plus the new suite inside those batches. The single failure is
  `place-management.test.ts` → "Only IDR and USD are valid currencies",
  reproduced identically on the clean stashed baseline. `discovery-aggregate`
  and `discovery-dev-dataset` remain excluded — PGlite is SIGKILL/OOM-killed
  in this 1-CPU/2 GB sandbox, verified identical on the baseline.
- `eslint .` 0 errors / 10 warnings (baseline, unchanged); `tsc -b --noEmit`
  exit 0; `next build` exit 0 (29/29). Total client JS grew **429 bytes** —
  `country-region-data` was already in a shared chunk, so the new import is
  effectively free for the Home map.
- No migration applied, no production data touched, no `is_curated`,
  publication, or dummy value changed anywhere.

---

## 22. HOME UI SPACING & LAYOUT (2026-10-04)

Three approved Home-UI changes, presentation only. Branch
`fix/home-ui-spacing-layout` off `main` (`6bb9c63`). **No** Place eligibility,
curated membership, search logic, filter logic, API, database, camera, or
geographic rule was touched — the previous §21 camera/eligibility work is not
continued or modified here.

### 22.1 The search coordinate strip is gone

The Home UI printed `Area pencarian: <lat>, <lng>` in a permanent opaque
full-bleed bar under the search field.

- The resolved-center branch is deleted; no raw coordinate is rendered
  anywhere in the Home UI now.
- The banner is gated on `searchPending || searchError` instead of on a
  non-empty query, so it exists **only** while a search is running or has
  failed. That is what guarantees no empty strip and **no reserved gap** is
  left behind: a resolved search renders nothing at all. Loading and error
  keep their own opaque surfaces and their `role="status"` /
  `aria-live="polite"` semantics.
- **No geographic state was removed.** `searchCenter`, the geocoding call, the
  ±0.05° search box, `resolveActiveCenter`, the camera center prop and the
  coverage origin all still read exactly the same state.

### 22.2 The results panel floats on the map

The title / count / context / “Ke hasil” block moved out of the page flow and
now rides the map’s own bottom edge. Content, numbers, and the anchor are
byte-identical; only the painting location changed.

| Concern | Resolution |
| --- | --- |
| Covers the scale bar? | No — `pr-[5.5rem]` stops the card short of the right edge, where the real scale bar (`bottom-9 right-4`) lives. |
| Covers the empty state? | No — the card sits at `bottom-3`, below the empty state, which was **raised from `bottom-24` to `bottom-32`** because the card's height is not fixed (see §22.2.1). |
| Covers map controls? | No — the control ladder is top-anchored (190 / 240 / 290px). |
| Swallows gestures? | No — the wrapper is `pointer-events-none`, only the card is `pointer-events-auto`. |
| Wrong z-index tier? | No — `z-[1100]`, the documented Home overlay ladder; the header’s higher tier stays exclusive to the header. |
| Second scroll layer? | No — it lives inside the `relative isolate overflow-hidden` map stage, so it is clipped with the map and moves with it. |
| Duplicate panel? | No — exactly one `<h2 id="place-results-heading">`; the results section keeps `aria-labelledby`, which still resolves across the tree. |

The results section lost its `-mt-5` tuck: the floating card now owns that
seam, and the two must not overlap. Net effect — the panel covers **less** of
the Place cards than before.

#### 22.2.1 One defect the layout review caught: the empty state had to move

The floating card's height is **not fixed**. A long search query wraps the
panel title to a second line and grows the card by roughly one more row. At
360px that pushes its top to roughly 110px from the bottom of the map — while
the map empty state sat at `bottom-24` (96px), *centered*, so the two would
overlap horizontally and vertically on exactly the screen that shows both: a
search that returned nothing.

The empty state was therefore raised to `bottom-32` (128px), which clears a
two-line title with room to spare. The 460px map floor leaves ample space
above it, and nothing was clipped or truncated — the panel title still wraps
normally rather than being cut off.

Measured at the 360px floor: `px-4` + `pr-[5.5rem]` leave a 256px card and a
232px text line; "Tempat Pilihan" plus "Ke hasil" need ~226px, so the header
stays on one line at every supported width and the card height stays
predictable.

### 22.3 A larger map canvas

The map window spacer moved from `42vh / 46vh, 440px floor, 560px ceiling` to
`56vh / 62vh, 460px floor, 680px ceiling`. **Canvas only.** The camera
presets, the curated camera radius, the local-area resolver, and every
fit-padding and zoom constant are unchanged, so nothing was zoomed out or
widened to make the map look bigger — the same frame simply has more pixels.
The 460px floor still clears the whole floating control ladder plus the new
floating card.

There is **no fixed bottom navigation** in this app: `site-nav.tsx` is
`absolute`/`sticky` at `top-0`. The floating panel therefore floats over the
map’s in-flow bottom edge rather than a viewport-fixed bottom inset, which is
why no safe-area inset is needed and why orientation changes cannot detach it.

### 22.4 Verification

- New `tests/home-ui-spacing-layout.test.ts` — 19 tests. **12 of them fail
  against `main`** and all 19 pass with the change.
-Seven existing suites were amended in place (never deleted), each annotated
with the behaviour change that required it: `home-map-first-ui`,
`map-local-area-coverage`, `map-auto-fit-camera`, `home-search-center-sync`,
`home-location-search`, `home-map-consolidated-frame`,
`map-viewport-coverage`, plus `map-stacking` and `home-search-clarity` for
the empty-state raise in §22.2.1. The substantive amendment is the stacking
one: `map-stacking.test.ts` still forbids a Place bottom sheet over the map,
and the new floating card is deliberately built to satisfy that (no
`bottom-0 left-0 right-0`, no Place CTA, no bottom-sheet shape, not on the
header tier).
- Full suite in batches: 258 / 197 / 187 / 138 / 148. The single failure is
  `place-management.test.ts` → “Only IDR and USD are valid currencies”,
  **pre-existing**, reproduced on the clean stashed baseline.
  `discovery-aggregate` and `discovery-dev-dataset` remain excluded (PGlite is
  OOM-killed in this 1-CPU/2 GB sandbox).
- `eslint .` 0 errors / 10 warnings (baseline) · `tsc -b --noEmit` 0 ·
  `next build` 0 (29/29).

### 22.5 Not done

- The 50 Saudi `region_name` values that `isValidPlaceRegion` rejects, and the
  curation decisions, remain exactly as reported in §21.6 — still open, still
  not actioned.
- `isDummy` on the public `/api/places` payload is still untouched (§21.7).

## 23. CORRECTION — CONTEXTUAL CURATED FRAME + PIN LABEL DENSITY (2026-10-05)

This section corrects the 2026-10-04 "Tempat Pilihan frames ALL curated Places"
decision (recorded in §2) and adds one label-declutter rule. Everything in
§14–§22 that is not named here still stands: curated MEMBERSHIP still reads only
the canonical `places.is_curated` ids, the viewport is still the only coverage
source for markers and rows, the 0/1/many fit matrix, the local-area resolver,
the explicit-request camera latch, the chrome padding, the measured scale bar,
`CURATED_FIT_MAX_ZOOM = 13`, the single `cameraAnimationOptions()` easing helper,
the reduced-motion behaviour, the search mechanism, the distance tabs, and the
`X` clear control.

### 23.1 Root cause — the curated frame was global

The curated focus fitted EVERY curated Place in the published set in one
`fitBounds`. On the canonical dataset that set spans West Java and the Kingdom
of Saudi Arabia (~13 000 km), so one fit produced a WORLD frame in which the
viewer's own neighbourhood was a couple of pixels wide. `CURATED_FIT_MAX_ZOOM`
(13) cannot prevent that: a maxZoom can only widen a frame that is too TIGHT,
never one that is already too wide. The viewport had then become the world, so
the marker layer re-rendered every Place on two continents.

### 23.2 The decision — frame the selection in the active context

`resolveContextualCuratedCoverage` (`web/lib/live/ui.ts`, pure and unit-tested)
resolves the curated camera pool against the USER'S CURRENT CONTEXT, using the
helpers this module already owns — no new geographic rule, no new radius, no
hard-coded place, no invented coordinate:

1. `search` — a city search is active: the curated Places inside that searched
   region's own coverage box (the same box the rows already use before Leaflet
   reports real bounds), so a context change after a search really re-frames
   the camera;
2. `area` — otherwise the curated Places of the viewer's LOCAL AREA
   (`resolveLocalAreaCoverage`), anchored on the searched city first and the
   real fix second;
3. `none` — with no usable origin the pool is EMPTY and the camera keeps its
   frame. There is no world fallback, so "geolocation denied and nothing
   searched" can never frame distant Places again.

The pool CANDIDATES are still every curated Place over the full published set,
so a search that narrowed the ROWS cannot decide which curated Places the
camera may consider. Curated membership, the curated LIST, both rows, every
count, and Discovery are untouched; the value is camera geometry only and is
still keyed on its nonce alone, so marker refreshes, polls, and viewport
reports cannot re-frame it.

### 23.3 Pin label density

Every Place pin paints its compact chip (11px/700, truncated at 132px, full
name on hover/focus). In a dense cluster every chip was painted at once, so in
exactly the area the user cares about no name was readable. `selectAlwaysLabelledPlaceIds`
now applies a deterministic priority budget (`PIN_LABEL_ALWAYS_ON_LIMIT`, 12):
curated first, then Live, then canonical order. It runs ONCE per marker rebuild
(effect keyed on the stable marker signature), so panning, zooming, and every
viewport report cost nothing extra, and nothing is ever measured at runtime —
no `getBoundingClientRect`, no `offsetWidth`, no per-frame layout pass. Chips
past the budget stay in the DOM with their full text and are revealed by the
existing hover / keyboard-focus state (pure CSS, no transition, no animation,
so reduced motion is unaffected). No marker, tooltip, click target, accessible
name, artwork, colour, or z-order changed, and labels are never ALL hidden.

### 23.4 Measured, and measured only

On a canonical-shape 74-Place dataset (30 curated across two continents), a
viewer in West Java, phone map box 360x460 with the real chrome padding:

| | before | after |
| --- | --- | --- |
| camera candidates | 30 | 12 |
| frame span | 7 475 km | 7 km |
| fit zoom | 2.58 | 12.46 |
| markers rendered after the fit | 47 | 14 |

Derivation cost: the curated pool resolver is 0.037 ms per derivation (the old
full-set scan was 0.003 ms) and the whole Home derive chain is 0.093 ms at 74
Places, with the per-keystroke content filter at 0.022 ms. The resolver is
memoised on stable inputs, so the extra work is paid only when the Places, the
search center, the fix, or the search box actually change. No other bottleneck
was found, so nothing else was optimised: no state, effect, filter, or camera
path was changed for performance.

### 23.5 Explicitly NOT changed

Curated eligibility, ranking, membership and every result count; the Discovery
contract; the distance tabs and their ordered presets; the search mechanism and
its ±0.05° box; the `X` clear control; LIVE; marker coordinates, artwork,
navigation and the z-index ladder; Place data, database, RLS, branding, copy,
and routes.

### 23.6 Verification

New `tests/map-contextual-curated-framing.test.ts` (16), new
`tests/map-pin-label-density.test.ts` (14) and new
`tests/home-search-submit-guard.test.ts` (11) — all executable against the real
resolver, the real fixtures, and Leaflet's own `getBoundsZoom` arithmetic, so
they assert the FRAME (span and the zoom a fit would produce), not that a helper
was called. Amended — never deleted — assertions in `map-auto-fit-camera`,
`home-map-consolidated-frame` and the two curated-map coverage assertions in
`map-viewport-coverage` / `discovery-home-integration`, each annotated with the
superseded behaviour it locked.

Home/map/Discovery/geocoding suites 366/366; full suite in batches 269 (2 known
environment failures), 224, 193, 118, 176 (1 known pre-existing failure);
`tsc -b --noEmit` clean; `eslint .` 0 errors / 10 warnings (baseline).

### 23.7 Known environment limitation (not a product defect)

The managed preview serves this Next.js app without hydrating in any headless
browser available in the sandbox (reproduced on the unmodified baseline), so no
screenshot of the live Leaflet map could be captured. The label strategy is
therefore covered EXECUTABLY (deterministic budget, bounded, non-destructive,
no layout measurement) — no claim is made that the chips are visually
collision-free, only that the layout logic is deterministic and that every name
remains reachable.

---

## 24. "SEMUA TEMPAT" TAB + CURRENCY RULES FIX (branch `feat/semu-semua-tolerant-tab-currency-rules`, 2026-10-05)

### 24.1 SAR failure — root cause and correction (no product change)

The reported SAR failure was a **stale test expectation, not an application
defect**: `tests/place-management.test.ts` asserted the STORED currency
vocabulary was exactly `["IDR", "USD"]`, while migration 0039 (applied) widened
the database CHECK with `SAR` and `lib/places.ts` `PLACE_CURRENCIES` follows it
(MASTER DEVELOPER AUTHORITY & DUMMY PLACE v1.0 §7 — a Place must be able to carry
an honest currency for its own geography; the initial market stays Indonesia).
The failure reproduced identically on the unmodified `c5b3038` baseline.

Two vocabularies were conflated in one rule. They are now explicit:

| Rule | Value | Where it is enforced |
| --- | --- | --- |
| STORED Place currency | `IDR`, `USD`, `SAR` | `PLACE_CURRENCIES` → the shared write parser → `places_currency_check` (0033 + 0039) |
| APPLICATION currency | `IDR`, `USD` | `APPLICATION_CURRENCIES` / `isApplicationCurrency` → `assertApplicationCurrency` on both Producer write routes |

Corrections:
- `lib/place-management.ts` no longer re-spells its own list — it imports
  `PLACE_CURRENCIES`. ROOT CAUSE of a real defect this hid: the Admin currency
  select offered `SAR` (it renders `PLACE_CURRENCIES`) while the shared parser
  refused it, so a stored `SAR` Place could be loaded and shown but never saved
  again. One list, one rule.
- Producer create/update routes refuse a currency outside the application
  vocabulary with the existing `place_currency_invalid` (400). The Producer form
  already offered only IDR/USD; this closes the raw request path.
- Currency labels moved to `PLACE_CURRENCY_LABELS` (fixed strings, shared by the
  Admin editor and the Producer form). **No `Intl` formatting exists or was
  added**: a Place's currency renders identically in every locale.

### 24.2 The additional "Semua Tempat" tab

A NEW content mode next to "Tempat Pilihan", never a replacement for it.

- **Where it lives:** its own row directly under the locked five-control filter
  bar. A sixth control could not join that row without wrapping, scrolling, or
  shrinking controls that are already exactly at the 360px limit. The locked row
  (`grid-cols-[auto_auto_1fr_1fr_1fr]`, five controls, order, ~16px radii, brand
  green, no scroller) is byte-for-byte unchanged; the new chip reuses the same
  visual language.
- **Dataset:** `searchFiltered` — every Place the canonical server wrapper
  already published, narrowed only by the one shared search. No new fetch, query,
  or eligibility logic: the client cannot surface an unpublished or ineligible
  Place because it never computes eligibility. No duplicates (the existing
  `seen` guard), no new category, curated membership never read.
- **Camera:** `allPlacesFitPlaces` = the eligible Places of the ACTIVE CONTEXT
  through `resolveContextualPlaceCoverage`, which `resolveContextualCuratedCoverage`
  itself now delegates to (one contextual rule for both tabs). A searched region
  wins, else the viewer's local area, else the camera keeps its frame. The whole
  world is never fitted — the same defect PR #20 fixed for the curated tab.
- **Labels:** `labelEveryPlaceName` paints EVERY rendered pin's name chip. The
  deterministic on-demand budget (2026-10-05, PR #20) stays the curated default
  and is untouched. The label rule is part of the marker signature, so switching
  tabs re-paints immediately.
- **Label layout:** `resolveAllPlacesLabelLayout` moves chips around their pin in
  four tiers — fully inside the usable map area and collision-free; inside the
  usable area; inside the map and clear of the opaque control column; default.
  It reads only the frame and size the map already measures for its own scale
  bar, runs once per marker rebuild, and measures no DOM. `crowded`/`relocated`
  counters report what could not be fixed instead of hiding a name.
- **Results panel, cards, markers, navigation, search:** unchanged. The panel
  keeps the canonical Discovery row in this tab exactly as in every non-curated
  mode; the map is the surface that carries every eligible name.

### 24.3 Verification

New `tests/place-currency-rules.test.ts` (21) and new
`tests/home-all-places-tab.test.ts` (24). Amended — never deleted — assertions in
`place-management`, `producer-terminology`, `live-ui`, `home-map-first-ui`,
`home-search-clarity`, `map-auto-fit-camera`, `map-local-area-coverage`,
`map-contextual-curated-framing`, `map-pin-label-density` and
`home-map-consolidated-frame`, each annotated with why it changed (the second
place-set tab, the shared context-framed camera value, or a window anchored on a
comment that comment-stripping silently turned into "the rest of the file").

Home/map/currency/Discovery batch 393/393; `tsc -b --noEmit` clean; `eslint .`
0 errors / 10 warnings (baseline). Full suite in batches: 314/0, 325/0, 131/0,
105 (1), 131/0.

### 24.4 Known limitations (honest)

- `discovery-aggregate`, `discovery-dev-dataset` and
  `place-curated-admin-migration` die with SIGKILL under whole-batch memory
  pressure in this 1-CPU/2 GB sandbox. Reproduced identically on the unmodified
  `c5b3038` baseline; `place-curated-admin-migration` passes 4/4 alone and
  passes in a matched-composition batch. Not a regression.
- No claim of pixel-perfect, collision-free labels: the sandbox preview does not
  hydrate the app in any available headless browser (same limitation as §23.7).
  What IS covered executably: every Place keeps an anchor and a painted label,
  density is answered by relocation, nothing is dropped, and the unavoidable
  remainder is counted.

## 25. APPROVED HOME/MAP MOCKUP — SIX UI CORRECTIONS (branch `feat/home-map-approved-ui-adjustments`, 2026-10-04)

Applied on top of `1406ae4` (merge of PR #21). The approved Home/Map mockup is
the visual specification; only the six corrections below were made. §24.1-§24.3
(PR #21: the currency rules) is UNCHANGED — the SAR/APPLICATION rule split and
every Producer/Admin currency path still stand. What was removed from §24.2 is
only the "Semua Tempat" tab, and only because the approved mockup has no such
tab and no other entry point for it is defined by the approved product flow.

### 25.1 The six corrections

| # | Correction | Where | Decision recorded |
| --- | --- | --- | --- |
| A | "Semua Tempat" tab removed | `home-discovery.tsx` | The whole MODE went with the tab: the `allPlacesOnly` flag, its activation helper, its second camera dataset (`allPlacesFitPlaces`), the "paint every name" pin-label rule (`labelEveryPlaceName`, `resolveAllPlacesLabelLayout`), and the removed row's button. The row is again the five controls LIVE · Tempat Pilihan · 1 km · 5 km · 10 km+ on its original `grid-cols-[auto_auto_1fr_1fr_1fr]` split, 11px type, ~16px radii, brand-green selection, no scroller at 360px. `contextFitPlaces` is `curatedFitPlaces` again and the camera-request count returns from 4 to 3. |
| B | Navigation arrow → compass | `home-map.tsx` | Same box as the retired arrow (`right-3 top-[190px] h-11 w-11`, same white surface/radius/ring/shadow), drawn as a dial with a red north needle pointing up and a muted south half. Leaflet 1.9 core has NO rotation (no bearing state, no plugin), so the map is always north-up: the compass is `role="img"` with an accessible name and is deliberately NOT a button — a "restore north-up" click would advertise a capability that does not exist. Re-centering stays one press away on the labeled "Lokasi Saya" control (240px), whose handler, geometry, and geolocation path are unchanged. |
| C | Search settings/filter graphic removed | `home-discovery.tsx` | The decorative aria-hidden sliders SVG is gone and replaced by NOTHING. The left `⌕` glyph, the placeholder, the accessible name, the submit-only Enter search, and the conditional clear `×` all remain. |
| D | Search field dimensions stable | `home-discovery.tsx` | The only state-dependent element in the bar is the clear button, which now occupies a FIXED `h-[18px] w-[18px]` box — exactly the footprint the removed graphic had — so the bar's width, height, padding, radius, position, and alignment are identical empty and filled by construction. The input gained `min-w-0` so a long query cannot widen the row or overflow at 360px. Still submit-only: no search-on-keystroke. |
| E | Map distance scale removed | both components | The indicator AND the space it reserved are gone: the distance text, the bar, the map's `onScaleChange` measurement, and the resolver `resolveMapScale`/`MapScale`/`MAP_SCALE_MAX_BAR_PX`. Nothing replaces it. The `+/-` zoom control, the OSM attribution, and every camera/coverage/radius rule are untouched — the scale was display-only chrome that no geographic rule ever read. |
| F | Results panel matches the search field | `home-discovery.tsx` | The panel wrapper keeps its geometry and loses only the reserved right-hand strip that existed for the scale bar, so both are literally `mx-auto w-full max-w-6xl px-4`: left and right edges match the search field at 360 / 390 / 430 / 1280. Title, Place count, description, "Ke hasil", handle, surface, and every interaction are unchanged; the title column keeps `min-w-0` and the action `shrink-0`, so nothing overflows. |

### 25.2 What was deliberately NOT changed

Branding, header and "Masuk", tab order/handlers, LIVE · curated · distance
logic, Place data and visibility, markers, labels, the current-location marker,
camera framing and fit padding, "Lokasi Saya", the results panel's data, text and
scroll target, the geocoding path, content cards, bottom navigation, and the
§24.1 currency rules. No tab, button, icon, filter, label, or promo element was
added anywhere.

### 25.3 Tests

New: `tests/map-north-compass.test.ts` (7) and
`tests/home-search-panel-alignment.test.ts` (10).
`tests/home-all-places-tab.test.ts` was REPLACED by `tests/home-tab-row.test.ts`
(11) — same file, renamed and rewritten to pin the new contract (tab absent, no
alternative entry point, the five remaining controls and their handlers intact,
and the curated dataset / contextual coverage / pin-label budget / Place
selection / navigation untouched). Nothing was deleted. Amended — never
weakened — `home-map-first-ui`, `home-ui-spacing-layout`, `live-ui`,
`home-search-clarity`, `home-search-submit-guard`, `home-map-consolidated-frame`,
`map-auto-fit-camera`, `map-local-area-coverage`,
`map-contextual-curated-framing`, `map-current-location`, `map-pin-label-density`,
`map-stacking`, `map-viewport-coverage`; each changed assertion is annotated with
why (removed tab, removed scale, fixed-size clear control, or the single locate
control).

Verification: home/map batch 258/258 and 167/167; `tsc -b --noEmit` clean;
`eslint .` 0 errors / 10 warnings (baseline). Full suite in batches:
379 pass / 0 fail plus `discovery-aggregate` and `discovery-dev-dataset`
(SIGKILL, see 25.4), 119/0, 235/0, 113/0, 84/0, 92/0.

### 25.4 Known limitations (honest)

- `discovery-aggregate` still dies with SIGKILL under memory pressure in this
  1-CPU/2 GB sandbox. VERIFIED again on THIS change set: the same SIGKILL was
  reproduced on an unmodified `main` worktree, so it is an environment limit, not
  a regression. `discovery-dev-dataset` SIGKILLed once and then passed 5/5 on a
  plain retry on this branch — also environment flakiness.
- **No visual/pixel verification was possible**: the managed preview serves
  Next.js without hydrating in any headless browser available here (same
  standing limitation as §23.7 / §24.4). Positioning, proportions, and responsive
  behaviour at 360 / 390 / 430 / 1280 px were NOT observed on a rendered page.
  What IS covered executably: the search bar's right end renders no icon at all,
  the only state-dependent element in the bar has a fixed 18×18 box, the panel
  and the search field carry byte-identical column geometry, the compass keeps
  the retired arrow's exact box and exposes no interaction, and no scale
  indicator or reserved strip survives.

## 26. LOCATION SEARCH: SUBMITTED QUERY + CANONICAL SEARCH AREA (branch `fix/home-search-area-coverage-and-cari-button`, 2026-10-04)

Built on `aed6b655` (PR #22). §25's approved visual corrections are UNCHANGED —
the "Cari" button lives inside the approved search field without altering the
Home/Map screen, and the removed tab, compass, scale, and panel work stay as
they are. No Supabase schema or migration was touched; no currency logic exists
anywhere in this change.

### 26.1 Root causes

1. **A city search covered a few kilometres.** Coverage for a searched place was
   a fixed ±0.05° window (~5.5 km) around the geocoder's CENTRE POINT. The
   search camera then framed only the Places inside that same window, Leaflet
   reported that small frame as the real viewport, and `coverageViewport` —
   which every row and the marker set read — became the real viewport. So
   searching "Riyadh" listed only the eligible Places near one coordinate.
   There is no fixed window that is right for a district and right for a
   capital, which is why none is used as the model.
2. **Typing was the search.** `searchQuery` was both the input draft and the
   live Place text filter, so every keystroke changed the rows and the markers
   before the user had committed to anything.
3. **No visible way to submit on a phone** other than the keyboard's Enter.

### 26.2 What changed

- **Canonical searched area.** The geocoder response is parsed for the hit's own
  bounding box (`parseGeocodeBounds` in `lib/live/geocoding-core.ts`, provider
  quad `[south, north, west, east]`), returned by `/api/geocode` as
  `result.bounds`, and normalized again on the client (`normalizeSearchArea`,
  `lib/live/ui.ts`). That box is the primary `searchViewport` source for the
  rows, the markers, and the search camera's own fit dataset, so all three stay
  consistent. Fail-closed everywhere: a missing, malformed, zero-area,
  out-of-range or untrusted box yields `null`, and the documented
  `fallbackSearchArea` ±0.05° window applies only in that case. No radius is
  ever guessed, and no boundary is ever fabricated.
- **Draft vs submitted.** `searchQuery` is the draft; `submittedQuery` is the
  committed text filter and the only filter the rows read. Every reset path
  (empty submit, `X`, "Lokasi Saya") clears both.
- **One submit path.** Enter and "Cari" both call `handleSearchSubmit`; the
  button reads the draft state, never the DOM. `inFlightSearchRef` makes an
  identical submit while one is running a no-op, so Enter-then-tap cannot race
  two geocodes. The pre-existing epoch + submitted-query guard is unchanged and
  now also gates the area: the centre and the box are written together, after
  both guards, and every failure branch drops both.
- **Coverage caption honesty.** A resolved answer claims the "area" caption
  instead of the distance preset's radius, because the frame it produces is the
  searched place. Choosing a distance tab afterwards sets its own radius caption
  again.
- **"Cari" button** inside the approved field, fixed 26px height, `shrink-0`,
  with an accessible name, `type="button"`, disabled while a geocode is in
  flight. Padding moved to `pl-3.5 pr-1.5` so it sits inside the same surface;
  radius, border, and shadow are unchanged, and the clear "×" keeps its fixed
  18×18 box, so the field's outer geometry is identical in the empty, typed,
  pending, and submitted states.

### 26.3 Preserved

Distance tabs are still camera presets (never a Place filter); LIVE and
"Tempat Pilihan" semantics, curated membership from canonical `is_curated`
ids, Discovery ranking, Place eligibility, markers, "Lokasi Saya", camera
framing and fit padding, the viewport latch semantics, and the server-only
geocoding boundary (`photon.ts` is untouched).

### 26.4 Verification

New `tests/home-search-area-coverage.test.ts` (17) covering all twelve required
behaviours, including the canonical-box-versus-fixed-window comparison on a
Riyadh-shaped dataset (5 Places across the city: all 5 with the canonical box,
1 with the old window). Amended with a stated reason:
`home-location-search`, `home-search-center-sync`, `home-ui-spacing-layout`,
`home-map-first-ui`, `home-map-consolidated-frame`,
`home-search-panel-alignment`. Nothing was deleted or weakened.

Focused search/geocode batch 103/103; Home/Map batch 392/392;
`tsc -b --noEmit` clean; `eslint .` 0 errors / 10 warnings (baseline);
`next build` succeeded. Full suite in batches (106 files):
184/0 (+ `discovery-aggregate` and `discovery-dev-dataset` SIGKILL),
266/0, 293/0, 89/0 (+ `place-curated-admin-migration` SIGKILL, passes 4/4
alone), 80/0, 123/0.

### 26.5 Known limitations (honest)

- A provider hit that publishes no usable bounding box (or one that fails
  validation) still falls back to the ±0.05° window, so such a hit keeps the
  old narrow coverage. Nominatim publishes a box for the settlement hits this
  product resolves; no boundary is invented when it does not.
- `discovery-aggregate`, `discovery-dev-dataset` and
  `place-curated-admin-migration` still SIGKILL under batch memory pressure in
  this 1-CPU/2 GB sandbox (see §24.4 / §25.4); not regressions.
- **No visual verification.** The managed preview does not hydrate in any
  headless browser available here (same standing limitation as §23.7 / §25.4),
  so the new "Cari" button's rendered size and the wider coverage frame were
  NOT observed on a page. The executed guarantees are structural: one submit
  path, one in-flight guard, one coverage source, and fixed-size controls.

## 27. PR #23 REVIEW — "CARI" BUTTON USABILITY, NOW VERIFIED IN A REAL BROWSER (same branch, 2026-10-04)

§26's limitation above is RESOLVED: a Playwright Chromium is available in this
sandbox and the managed preview on port 3000 serves the app, so the Home screen
was rendered and measured rather than only read in source. Two things came out
of that, and the "button is missing" report was NOT one of them.

### 27.1 Why the button looked absent

The button is on the branch and was never missing from it. It is absent from
`main`/production, which is what was being viewed: the PR is unmerged, so the
deployed production SHA is still `aed6b655`, and `main`'s copy of the component
contains no `aria-label="Cari lokasi"` at all. On the branch, in the rendered
page, the control measures 52×26 px, paints the brand green `rgb(14,107,79)`
under white text, sits inside the white bar, is the hit target at its own centre
(`elementFromPoint` returns the button), and stays inside the viewport with zero
horizontal overflow at 320, 360, 390, 768, and 1280 px. The bar itself is 44px
tall at every one of those widths.

### 27.2 Two real defects the browser found, and fixed

1. **The keyboard focus ring was invisible.** `focus-visible:outline-brand-ink`
   resolved to a WHITE outline on a WHITE bar, confirmed by reading computed
   style and the pixels around the pill. Replaced with
   `focus-visible:ring-2 focus-visible:ring-black/45` + `ring-offset-2`; the
   focused pill now paints a 45 %-black ring that is measurable in a screenshot.
2. **The 26px pill was a small thumb target.** An absolutely positioned,
   out-of-flow child extends the HIT area to 34px, and a real tap 6px BELOW the
   visible pill now fires exactly one geocode. The extension is
   **downward only, on purpose**: the floating header is `absolute top-0` and
   already overlaps the pill's TOP edge (measured), so growing the target
   upward would have swallowed taps meant for the header — verified, since a tap
   in the upper overlap zone hits the header's own container, not the button.
   Being out of flow, it changes nothing about the bar's height, padding, radius
   or position, which is why the §25 dimensional-stability guarantee still
   holds at 44px.

### 27.3 Verified in the running page

Enter submits once; "Cari" submits once through the same handler; Enter and a
button press dispatched in the SAME TICK produce exactly ONE `/api/geocode`
request; a tap on the disabled, pending button produces none; "×" clears the
input and fires no request; Tab reaches "Cari" and shows the ring. Coverage:
the row list goes 74 → 28 for "Riyadh" → back to 74 after "×", with the caption
switching to the searched area and back to "Discovery Place".

### 27.4 Remaining limitation

- **Map MARKERS could not be observed in the page.** Leaflet never initialises
  in this headless sandbox — no `.leaflet-container`, no panes, no tiles, at any
  wait time and with no page error — so marker coverage was NOT visually
  confirmed; only the result ROWS were (the counts above). This reproduces on
  the unmodified branch state and is unrelated to this change. Markers and rows
  reading the same `searchViewport` is asserted by the test suite, not by a
  rendered frame.
- `discovery-aggregate`, `discovery-dev-dataset` and
  `place-curated-admin-migration` still SIGKILL in this 1-CPU/2 GB sandbox,
  reproduced identically on an unmodified `main` worktree (not regressions).

## 28. GOOGLE SIGN-IN UI + OAUTH INTEGRATION (branch `feat/google-auth-ui`, 2026-10-05)

Masuk (`/auth`) and Daftar (`/auth/sign-up`) now offer Google beside the
untouched email/password flow: logo, heading, "Masuk dengan Google" /
"Daftar dengan Google", an "atau" divider, the existing fields (with the
password visibility toggle on Masuk), the green brand submit, and the required
footers ("Belum punya akun? Daftar sekarang" / "Sudah punya akun? Masuk
sekarang"). No mockup copy, logo, or design token was invented.

Google uses the project's **existing Supabase Auth** — `POST
/api/auth/oauth/google` starts the provider flow on the same SSR client and
stores the PKCE verifier as a cookie; `GET /auth/callback` exchanges the code
into the same secure session cookie, and sign-out stays provider-agnostic.
`next` is re-sanitized at both ends, so neither route is an open redirect, and
no role/membership/producer input is accepted (Google users are ordinary USERs,
provisioned only by the existing `handle_new_user` trigger).

Verified in this sandbox against the managed preview: 67/67 browser checks at
390 and 1280 px (headings, both Google labels, divider, logo, green submit
`rgb(14,107,79)`, labels, toggle, no horizontal overflow, no page errors,
loading/disabled + duplicate-submit guard, graceful failure message) plus the
endpoint contract (200 + Supabase authorize URL + PKCE cookie, unsafe `returnTo`
→ `/`) and callback routing (cancel / missing code / bad `next` all land on
`/auth` with Indonesian copy). Automated: `tests/auth-google-oauth.test.ts`
(11 tests) with the existing auth tests; full runnable suite 1055/1055; tsc,
eslint (0 errors), and `next build` all pass.

**Not yet operational:** the Google provider must be enabled in Supabase and a
real consent round trip observed before this is called live — see
`docs/AUTH_GOOGLE_OAUTH_SETUP.md` for the exact owner actions. No secret is
stored in the repository or the app environment.

### Auth refresh + Apple sign-in (branch `feat/apple-auth-and-auth-refresh`, 2026-10-05)
- **Stale-render fix.** `/auth` and `/auth/sign-up` were client-only pages that
  production kept serving as an older cached document. Each route is now a
  minimal SERVER wrapper with `export const dynamic = "force-dynamic"` that
  defers to a dedicated client component (`app/auth/auth-form.tsx`,
  `app/auth/sign-up/sign-up-form.tsx`). UI, Google behavior, email/password
  behavior, returnTo handling, and error/success handling are unchanged; no
  cache-busting params, service worker, or CDN hack was added. `next build` now
  reports both routes as dynamic (ƒ).
- **Apple sign-in** is a second OAuth option beside Google and email/password:
  Google → Apple → "atau" divider → existing fields. `POST /api/auth/oauth/apple`
  mirrors the Google route on the same Supabase SSR client (`provider: "apple"`),
  reuses `/auth/callback`, `sanitizeReturnTo`, and the session-cookie mechanism.
  The callback carries a `provider` param so error copy names the right provider.
  No parallel account system, no elevated role, no provider secret in the repo.
- **Payment disclaimer removed** from user-facing UI only (`/auth` subtitle,
  `/visit-intents`, `VisitIntentForm`, `/about`, Producer visit-intent inbox).
  The Visit Intent concept, Master terminology, and informational Producer
  pricing all remain; the domain rule stays in `AGENTS.md`/masters.
- Verified: focused auth + payment-regression tests 45/45; full runnable suite
  1081/1081 (3 pre-existing PGlite/memory suites excluded, unchanged); tsc
  clean; eslint 0 errors / 10 pre-existing warnings; `next build` clean; browser
  verification at 1280 and 390 px on both routes (Google, Apple, divider,
  email/password present, no "bukan pembayaran").
- **Not yet operational:** Apple needs the Supabase provider enabled plus an
  Apple Services ID/key — see `docs/AUTH_APPLE_OAUTH_SETUP.md`.

### Home UI visual refinement (branch `feat/home-ui-refinement`, 2026-10-05)
Presentation-only pass against the approved Home mockup's visual language.
NO new section, tab, filter, navigation, Place action, data field, route,
search behavior, camera rule, or MVP step was added — everything below is
typography, spacing, color, radius, shadow, and sizing on the existing Home
surfaces.
- **Consistent radius ladder:** controls 14px (filter buttons, map buttons,
  in-card actions, empty state), Place cards 16px, floating surfaces 18px
  (search bar, floating results panel), section cap 24px, chips/pills stay
  fully round.
- **Subtle shadows instead of heavy borders:** Place cards, the search bar,
  the floating panel, the map controls, and the section seam now use one
  low/high shadow pair (`0 1px 2px / 0 04` → `0 8px 20px / 0 08`) with a
  lighter `black/5` border instead of `border-black/10` + `shadow-sm/md`.
- **Cleaner hierarchy:** card name 14px/700, description 12px in brand ink at
  60%, results title 16px with tracking, "Ke hasil" and the count line at
  11px, star slots 12px, section labels at 55% ink. Every muted color moved
  from `black/NN` to `brand-ink/NN` for one consistent, higher-contrast ramp.
- **Compact controls and cards:** filter buttons tightened (`px-3.5`→`px-3`
  from `sm:`), image area 104/124px → 92/108px, card padding and the card
  action rows reduced, live buttons 8px → 6px vertical padding at a 14px
  radius. A Place card is ~254px tall on mobile instead of ~290px.
- **Map presence:** the visible map window grew to 60vh / 66vh from `sm:`,
  floor 470px, ceiling 700px — paid for by the more compact floating panel,
  not by touching any camera constant. The right-hand ladder offsets
  (compass 190 / "Lokasi Saya" 240 / zoom 290) are unchanged; the two React
  controls shrank 44px → 40px so the ladder is lighter and still collision
  free (190+40 = 230 < 240 < 290).
- **Pin labels** are quieter on the map: 11px/700 → 10.5px/600, max width
  132px → 124px, softer shadow. Truncation, the deterministic density
  budget, and the on-demand reveal are unchanged.
- Verified: every runnable test file (108 files) passes; the focused Home/map
  suites were updated ONLY where they pinned the old visual values
  (radii, shadows, type sizes, band heights, control boxes) — no behavioral
  assertion was relaxed; `tsc -b --noEmit` clean; `eslint .` 0 errors / 10
  pre-existing warnings; `next build` clean; browser verification at 390×844
  and 1280×800 (computed radius/spacing/type/elevation for the search bar,
  filter row, floating panel, Place cards, map controls, stars, and intro,
  plus no horizontal overflow and no page errors).
