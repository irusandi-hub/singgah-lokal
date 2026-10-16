# SINGGAH LOKAL — MASTER INDEX v1.0

Definitive reference set for long-term implementation.

1. MASTER 01 — Foundation & Business Rules
2. MASTER 02 — Producer AI Assistant & AI Cost Control
3. MASTER 03 — UX Home / Map / Place
4. MASTER 04 — “Dari Sini” / Production Story
5. MASTER 05 — Technical Implementation Baseline
6. MASTER AUTHORITY & ROLE STRUCTURE v1.0 — `MASTER_AUTHORITY_STRUCTURE_v1.0.md`
7. MASTER DEVELOPER AUTHORITY & DUMMY PLACE v1.0 — `MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0.md`
8. MASTER DATA RETENTION & CLAIM ARCHIVE POLICY v1.0 — `MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0.md`
9. MASTER LIVE POLICY v1.0 — `MASTER_LIVE_POLICY_v1.0.md`
10. MASTER LIVE TECH v1.0 — `MASTER_LIVE_TECH_v1.0.md`

MASTER AUTHORITY & ROLE STRUCTURE v1.0 (`MASTER_AUTHORITY_STRUCTURE_v1.0.md`) is an **official Master** that must be used together with the other Masters. It is the source of truth for the Creator vs Platform Admin separation and the locked authority hierarchy: CREATOR / OWNER / DEVELOPER (highest authority, program + all infrastructure) → PLATFORM ADMIN (operational authority inside the app) → PRODUCER (own resources only) → USER (no operational authority).

MASTER DATA RETENTION & CLAIM ARCHIVE POLICY v1.0 (`MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0.md`) is an **official Master** that must be used together with the other Masters. It is the source of truth for claim archive retention and evidence handling: archived Place claims and their evidence are kept exactly 30 days for internal operational traceability only, are never shown as normal history in the Admin Dashboard, are searchable only by authorized Platform Admin (by Place ID, Pengelola ID/email, and related identifiers), evidence stays private behind authorized short-lived signed URLs, cleanup deletes storage first and finalizes the database archive only after storage deletion succeeds (re-processable on failure), and no permanent preservation is guaranteed after retention ends. Claim approval is application-level state — not a legal ownership decision; ownership/legal disputes are proven between the parties, a unilateral claim never revokes or transfers in-app ownership, and actions requiring legal determination must follow a competent authority in the Place's jurisdiction. The retention clause is mandatory in Terms/Privacy/Policy. Any change to the 30-day retention, evidence handling, or the legal-dispute boundary requires a new master version. Its §16 technical annex is the claim-archive design of record (archive schema/search, cleanup worker, scheduler, service-role auth, idempotency, retry, storage→DB order, verification); its §16.7 records the audited implementation status — claim archive, Admin-only internal search, the `cleanup-place-claim-archives` Edge Function with its daily scheduler, and the public policy disclosure (`/policy`) now EXIST in the repository and are synchronized with Supabase DEV.

MASTER DEVELOPER AUTHORITY & DUMMY PLACE v1.0 (`MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0.md`)
is an **official Master** that must be read together with MASTER AUTHORITY & ROLE STRUCTURE v1.0. It
defines **Dummy Place** data (the canonical `places.is_dummy` flag, migration 0039) and the
**Creator-controlled Developer Authority** over it — a Creator-owned technical path, never an
application feature (Authority Master §3). It is **additive**: it grants no new tier, changes no
locked rule, and relaxes no existing protection. Its locked points are: the Dummy marker is a
database fact and is **never inferred from free text**; the permitted operation set is closed
(`set_dummy`, and `set_curated` **only on validated Dummy rows**); the Developer Authority is
**never** `platform_moderator` and never models the Creator as a moderator (§4); it has **no client
endpoint** and no service-role route; it cannot reach the whole Place table; every change writes an
**append-only `place_audit` row** (actor = the Creator's own user id, reason, target, before/after)
and an **audit failure rolls the change back**; 0036's `is_curated` lockdown and every RLS policy
stay intact. `SAR` was admitted to the currency vocabulary so a Place can satisfy "Currency follows
Place" (MASTER 01) — the initial market remains Indonesia. **Dummy/test data is DEV-only**:
migration 0040 (ten Riyadh fixtures) must never be applied to production, and no Dummy Place may
masquerade as a real Producer. Any change to the operation set, the scope limit, the audit
guarantees, or the DEV-only boundary requires a product decision, a new Master version, and an
update to this index.

MASTER LIVE POLICY v1.0 (`MASTER_LIVE_POLICY_v1.0.md`) and MASTER LIVE TECH v1.0
(`MASTER_LIVE_TECH_v1.0.md`) are the two **official Masters** for the Live feature and must be read
together (policy = rules, tech = architecture of record). They cover the Live definition, the viewer
and Producer gates, the eligibility paths, camera/production rules, safety/content/privacy
prohibitions, moderation/enforcement and fail-closed behaviour, the locked capacity/duration limits,
recording-off/monetization-off, the streaming-provider boundary, and the Live technical design
(schema, RLS, security-definer RPCs, provider boundary, Realtime, and the TUNABLE/BLOCKED registry).
Their decision history is recorded as dated amendment sections inside each file (policy §12.1–§12.6,
tech §14); a locked rule is superseded by a NEW dated amendment with the old text retained, never by a
silent rewrite, and the amendment is logged here.

**Recorded amendment — 2026-10-16: Live is decoupled from Kegiatan / Kelola Proses (policy §12.6,
tech §14).** Kegiatan, Kelola Proses, and Live are independent features. Kegiatan and Kelola Proses
are **informational** tools for a Place's owner / authorized manager; Live is a **Place-associated**
capability. Live requires no Production Story Process/stage to be created, selected, or published, and
informational changes (create / update / publish / pause / archive / delete) never block starting a
Live and never end an active Live. This **supersedes** policy §12.1 item 4 (the strict-MVP Process
linkage with its `source_stage_unpublished` auto-end) and the matching technical clauses (tech §1.2,
§4.2 #3, §4.5, §8, §9). Everything else in both Masters stays locked and enforced: Place
ownership/manager authority, delegated Operator Live permissions, email/age/account eligibility, the
global (5) and per-Place (1) Live caps, 100 concurrent viewers, the 60-minute cap, fail-closed
gates, moderation/reports/enforcement, server-side-only credentials, the audit trail, idempotent
start/end, and Supabase as the canonical Live state. Implementation of record: migration
`web/supabase/migrations/0060_live_decouple_production_stage.sql`; verification:
`web/tests/live-decouple-production-stage.test.ts`. The next reissue of each Live Master must fold
these amendment sections into its body text; until then the amendment sections are authoritative for
the decoupling.

LOCKED principles:
- Authority hierarchy is LOCKED: CREATOR / OWNER / DEVELOPER hold the highest authority over the program and all infrastructure; PLATFORM ADMIN holds operational authority inside the app; PRODUCER is limited to their own resources; USER has no operational authority. New permissions must preserve this hierarchy unless a new Master version says otherwise.
- Infrastructure credentials/secrets are never delivered through the application to Admin, Producer, or User.
- The Creator is NOT platform_moderator; platform_moderator is an operational Platform Admin role.
- Initial market: Indonesia. (SAR admitted to the currency vocabulary for test data only — see
  MASTER DEVELOPER AUTHORITY & DUMMY PLACE v1.0 §7.)
- Dummy Place = development/test fixture, marked by the canonical `places.is_dummy` flag; only the
  Creator-controlled Developer Authority may change it.
- Home = Map-based Discovery.
- Home discovery is time-first, not product-category-first.
- Place is the ecosystem center.
- Currency follows Place.
- Schedule/availability uses Place timezone.
- MVP does not facilitate financial transactions between Producer and User.
- Ticket/price/promotion are informational Producer data.
- AI generation cost must be controlled per registered Producer account/email; platform must not carry uncontrolled Producer AI generation cost.
- AI content is draft until Producer approval; AI may not invent facts.
- Live is a Place-associated capability: Kegiatan and Kelola Proses are informational tools and are never a prerequisite for Live, and informational content changes never control Live availability or lifecycle (policy §12.6, 2026-10-16).
- “Dari Sini” is dynamic production storytelling.
- SINGGAH leads to Visit Intent, not checkout/payment.
- Claim archive and claim evidence retention is exactly 30 days (internal operational traceability only); change requires a new master version (`MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0.md`).
- Claim approval is application-level state, never a legal ownership determination; ownership disputes are proven between the parties and a unilateral claim never changes in-app ownership.

Use the latest master files as the source of truth for AI coding. Any change to a LOCKED rule requires an explicit product decision and a new master version.
