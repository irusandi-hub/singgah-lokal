# SINGGAH LOKAL — DISCOVERY CONTRACT v1.0

Status: **LOCKED for implementation** — Discovery Place scoring/eligibility contract.
Date: 2026-09-29 (implementation clarifications added 2026-09-30; no rule changed)
Basis: `AGENTS.md`, `docs/masters/MASTER_INDEX_v1.0.md`, `docs/masters/MASTER_LIVE_POLICY_v1.0.md`,
`docs/masters/MASTER_LIVE_TECH_v1.0.md`, `docs/HANDOFF_LIVE_MVP.md`, Stage 0 audit of the
then-current `main` and migration chain 0001–0034 (`web/supabase/migrations/`). Migration chain
0001–0037 is now applied in Supabase DEV; migrations 0033/0035/0036/0037 are the Discovery
readiness/backfill, `is_curated` flag, and demo dataset stages.

## 0. Product rules this contract implements (locked)

1. Discovery is **not** a manual status. There is no Discovery column an Admin or Producer can set.
2. Admin **cannot** select Discovery. No admin write path to eligibility/score/stars exists or may be added.
3. Discovery is **computed by the system** from canonical Supabase signals only.
4. **Tempat Pilihan stays separate** (admin-promoted layer, future stage). Nothing here changes it.
5. One Place **may be in both layers**. The two layers are computed independently; neither influences the other.
6. **Publication remains the base requirement.** Publication/claim/ownership semantics are NOT changed.
7. No new categories. No Master changes. No payment/checkout concepts.

## 1. Source data (canonical signals only — Stage 0 inventory)

| Signal | Source (canonical table/columns) | Migration |
|---|---|---|
| Publication | `places.publication_status` (`published` only) | 0001 |
| Readiness | `places.name, short_description, area, address, latitude, longitude` (existing `isPlacePublicationReady`) | 0001/0032 |
| Trust | `places.claim_status = 'verified'` | 0001/0028 |
| Live activity | `live_sessions(place_id, status, started_at)` | 0008+ |
| Followers | `place_follows(place_id)` count of rows | 0023 |
| Visit interest | `visit_intents(place_id)` count of rows | 0001 |
| Experience depth | `experiences(place_id)` with `status='published' AND publication_status='published'` | 0005 |
| Media richness | `places.cover_image_url` (0018) + `place_photos` (0021) |

Explicitly **NOT used** (Stage 0: unavailable or forbidden): ratings/reviews (rating subsystem does not
exist — MASTER_LIVE_TECH §1.1/§10 BLOCKED), page views/analytics, any payment/transaction signal,
any AI-generated score, any cache/search-index value (AGENTS.md), any viewer-position value
(ranking is viewer-independent).

## 2. Eligibility — `DiscoveryEligibility`

A Place is **eligible for Discovery** iff ALL of:

- **E1** `publication_status = 'published'` (draft/paused/archived never eligible — Stage 0 rule).
- **E2** `isPlacePublicationReady(place)` is true (name + short description + area + address +
  canonical finite lat/lng — the existing domain predicate; map-first discovery needs coordinates).

No activity threshold gates eligibility. No manual flag, no admin override, no seeding: eligibility is
derived **only** from the canonical columns above ("no fake eligibility").

## 3. Score — `DiscoveryScore`

Pure function, integer-rounded, range **0–100**. All components take an explicit `now: Date`
(deterministic; no randomness anywhere).

```
score = round( 40*L + 25*F + 20*V + 15*E )
```

| Component | Weight | Definition | Technical reason |
|---|---|---|---|
| `L` live activity | 40 | `1` if the Place has a `live_sessions` row with `status='live'`; else `max(0, 1 − ageDays/14)` where `ageDays = (now − started_at)/86400000` of the most recent session (any status, started within 14 days); else `0`. | Live is the platform's strongest process signal; MASTER_LIVE_TECH §9 derives LIVE from canonical `live_sessions`. 14-day window = fixed recency decay, deterministic. |
| `F` followers | 25 | `clamp(log1p(followers) / log1p(100), 0, 1)` — `followers` = row count in `place_follows` for the Place. | Follows are durable retention intent (MASTER 10 fan-out reads the same rows). Log + cap 100 keeps scaling monotonic and bounded. |
| `V` visit interest | 20 | `clamp(log1p(intents) / log1p(50), 0, 1)` — `intents` = row count in `visit_intents` for the Place. | SINGGAH → Visit Intent is the core product flow (AGENTS.md). All current statuses are genuine interests (cancelled/expired are unreachable per migration 0002). |
| `E` ecosystem richness | 15 | `( 8*min(1, expCount/2) + 7*media ) / 15` with `media = clamp(0.4*[has cover] + 0.2*min(photos,3), 0, 1)`; `expCount` = published experiences. | Place → Production → Experience → SINGGAH depth plus honest media completeness is system-derived content quality (never user votes). |

**Media term — `min(photos,3)` is a CAP, not a normalisation.** The photo term is already worth
its full `0.6` at 3 photos, so:

- cover + 0 photos → `0.4`
- cover + 1 photo → `0.6`
- cover + 2 photos → `0.8`
- cover + 3 photos → `1.0` — **full media contribution** (7 of the 15 ecosystem points)
- cover + more than 3 photos → still `1.0`; extra photos never add value

Dividing the photo count by 3 (i.e. normalising instead of capping) is a contract violation.

Trust (`claim_status='verified'`) is deliberately **not weighted** (AGENTS.md: verified ≠ every claim
verified); it is used only as a ranking tie-break (§5).

### 3.1 Readable breakdown of the score

Any human-readable breakdown of a Place's Discovery standing MUST be the additive decomposition of
this same formula, expressed in POINTS — never an independent 0–100 "quality" rating, never a proxy:

| Row | Points | Contract term |
|---|---|---|
| Aktivitas | `40 * liveNow` | `L`, live branch (1 while the session is live) |
| Freshness | `40 * recency` | `L`, decay branch (mutually exclusive with live-now) |
| Engagement | `25*F + 20*V` | followers + visit intent |
| Pengalaman | `8 * min(1, expCount/2)` | `E`, experiences term |
| Kelengkapan | `7 * media` | `E`, media term |

The five rows sum to the score. Consequences that are part of the contract, not implementation
choices: two rows may never read the same component (Aktivitas and Freshness are the two
exclusive branches of `L`); publication readiness is an **eligibility gate (E2)**, not a score
component; and there is **no relevance component** — §1 excludes viewer position and no weighted
geographic signal exists, so a coordinates proxy would be a fabricated number.

## 4. Stars — `DiscoveryStars`

Exactly four tiers. **Every eligible Place has at least ★** (eligible-but-quiet places stay
discoverable). Numeric score is **never** rendered or serialized to the client — stars only.

| Stars | Rule |
|---|---|
| ★ | eligible (baseline) |
| ★★ | score ≥ 30 |
| ★★★ | score ≥ 60 |
| ★★★★ | score ≥ 85 |

Boundaries are inclusive. Sanity anchors: live-now alone (40) → ★★; live + modest engagement (≥60)
→ ★★★; live + strong engagement + ecosystem (≥85) → ★★★★; fresh published Place (0) → ★.

## 5. Ranking and tie-breaks

`rankDiscoveryPlaces(eligible inputs)` returns **ALL eligible Places** ordered by this deterministic
chain (viewer-independent, no random, no time-of-day dependence beyond the passed `now`):

1. `DiscoveryScore` descending
2. `claim_status = 'verified'` descending (platform trust tier)
3. follower count descending
4. visit-intent count descending
5. most recent `live_sessions.started_at` descending (null last)
6. `places.id` ascending (absolute final tie-break — stable ordering)

The UI must not re-sort this order.

## 6. Minimum-10 guarantee

- Discovery set = **all eligible Places**, ranked. If ≥ 10 Places are eligible, Discovery contains ≥ 10 —
  guaranteed by construction, not by padding.
- **Never**: hardcoded IDs, random sampling, fake eligibility, or inclusion of draft/paused/archived
  Places to reach 10. If fewer than 10 are eligible, Discovery shows fewer.

## 7. Single source of truth (implementation stage files)

- **`web/lib/discovery/scoring.ts`** — THE single source of truth: types `DiscoveryEligibility`,
  `DiscoveryScore`, `DiscoveryStars`, `DiscoveryScoreBreakdown`; pure functions
  `evaluateDiscoveryEligibility`, `computeDiscoveryScore`, `computeDiscoveryScoreBreakdown`,
  `mediaComponent`, `discoveryStarsForScore`, `rankDiscoveryPlaces`. No I/O, no imports beyond
  shared types; plain-Node testable.
- **`web/lib/place-experience-repository.ts`** — the ONLY read path for signal assembly (extend the
  existing canonical repository; new `listDiscoveryInputs` may not open a second Supabase client or an
  ad-hoc read path — AGENTS.md no-cache-as-truth, Stage 0 duplicate-risk H.3/H.4).
- Public mapping (next stage, server route/page): stars + rank only; numeric score never leaves the server.

## 8. Migration required

**None.** Every signal in §1 already exists in the canonical schema (0001/0005/0008+/0018/0021/0023/
0028/0032). Signal counts are assembled server-side from canonical tables via the existing repository
pattern. If measurement later shows aggregate-query cost is a problem, the decision point is a
read-only aggregate view/RPC (RLS-safe, `search_path` fixed, repo pattern) — deferred, not part of
this contract.

## 9. Test cases (implementation stage)

1. Eligibility: `draft`/`paused`/`archived` → ineligible; only `published` passes (E1).
2. Eligibility: null/non-finite lat/lng, or missing name/short/area/address → ineligible (E2).
3. Score: place with zero activity signals → `0`; deterministic across repeated calls (same `now`).
4. `L`: live now → 40; ended 7 days ago → 20; ended ≥ 14 days → 0; no session → 0.
5. `F`: monotonic non-decreasing; 0 → 0; ≥100 → full 25.
6. `V`: monotonic non-decreasing; 0 → 0; ≥50 → full 20.
7. `E`: experiences capped at 8 pts; cover/photos capped at 7 pts; component total ≤ 15.
   Full-media anchor: cover + 3 photos = the full media contribution (7 pts), and more than
   3 photos never increases it.
8. Score bounds: 0 ≤ score ≤ 100 for all fixtures.
9. Stars: eligible → ★; 30/60/85 boundaries inclusive → ★★/★★★/★★★★.
10. Ranking: score desc; full tie resolves verified → followers → intents → recency → `id` asc, stable.
11. Minimum-10: 15 eligible inputs → ranked output ≥ 10 (all 15) without hardcoded IDs or randomness.
12. No public numeric score: public mapping exposes stars/rank only (no `score` field).
13. Layer independence: adding/removing a hypothetical curated flag changes neither eligibility nor
    score (Tempat Pilihan independence; one Place may be in both layers).
14. Repository path: discovery inputs read through the canonical repository only (no second client).
15. Eligibility integrity: a Place id can reach the Home "Discovery Place" row ONLY through
    `discovery.discovery`; a published-but-ineligible Place is never rendered there, and ranking
    rank is never used as an eligibility substitute.
16. Curated empty state: an empty curated id set produces an empty Tempat Pilihan result — never
    a fallback to the full published set.
17. Breakdown: the Admin rows are the §3.1 contributions and reconstruct the score; no row is a
    fabricated proxy and no two rows read the same component.

## 10. Out of scope (this contract)

Home UI, Admin UI, Tempat Pilihan curation surface, demo/seed data, any migration, any change to
publication/claim/ownership, any Master change. Implementation happens in the next stage per
`docs/HANDOFF_LIVE_MVP.md` §10 workflow.
