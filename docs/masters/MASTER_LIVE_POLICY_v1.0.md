# SINGGAH LOKAL — MASTER LIVE POLICY v1.0

Status: **LOCKED** — policy master (Live Phase 1).
Date: 2026-09-18
Scope: real-time Live at a Place.
Implementation status: **none authorized**. This document defines policy only. No backend, database, streaming, or UI work is authorized by this document.

Source hierarchy: `AGENTS.md` → `MASTER_INDEX_v1.0.md` → this master.
Any change to a rule in this document requires an explicit product decision and a new master version.

---

## 1. Definition

- **Live = real-time Place production Process.** Live is a real-time broadcast of a production Process happening at a Place.
- **Process is the subject.** Every Live must show a real production Process occurring at the Place during the broadcast. A Live without a production Process as its subject is invalid.
- Live is **not social livestreaming**. It is not vlogging, talk-show, entertainment, or arbitrary personal broadcasting.
- Live **extends** the locked core flow; it does not replace or reorder it:
  Map/Discovery → Place → Story/Production → Experience → SINGGAH → Visit Intent → Producer.
- Live times follow the Place timezone (locked rule from `MASTER_INDEX_v1.0.md`).

## 2. Eligibility

### 2.1 Viewer
- Viewer eligibility for Live: **authenticated account + verified email + server-side verified age ≥ 18**; missing or unverified age ⇒ denied (fail-closed, §12.1 item 3).
- **No anonymous viewing. No anonymous commenting.** This gate applies to Live viewing and Live commenting only; public Place discovery remains public.
- Viewers who fail any eligibility check are denied (fail closed, §5.3).

### 2.2 Producer
- The Producer must be **authorized for the Place** the Live is broadcast from. Authorization is checked **server-side** on every Live action (start, end, report handling, moderation and enforcement response).
- A Producer authorized for one Place gains no rights over any other Place's Live.

### 2.3 Eligibility is separate from Place verification
- **Live eligibility is separate from Place verification.** A verified Place or verified Producer does **not** automatically grant Live eligibility, and Live eligibility does not imply Place verification. This is consistent with the locked rule: verified Place/Producer does not mean every Producer claim is verified.

### 2.4 Eligibility paths
Live eligibility is granted only through exactly one of the following paths. No other path may be added without a new master version:

| Path | Meaning |
| --- | --- |
| `RATING` | Granted by Place/Producer rating |
| `CURATED` | Granted by platform curation |
| `EXCLUSIVE` | Granted as an exclusive arrangement |
| `HISTORY` | Granted from platform history/track record |
| `ADMIN_APPROVED` | Granted by explicit admin approval |

`RATING` uses a configurable rating threshold + minimum rating count (§12.1 item 2). Criteria for the other paths are **not defined in v1.0** and must not be invented by implementation.

## 3. Camera and production rules

- **Exactly 1 fixed/static camera** per Live.
- Prohibited camera/production styles:
  - Handheld
  - Vlog style
  - Panning
  - Following (camera moving with a subject)
  - Multi-camera
  - Drone
  - Body-camera

## 4. Safety, content, and privacy

Strict safety, content, and privacy rules apply to every Live. The following are **hard prohibitions**:

- Pornography and sexual content.
- Graphic violence.
- Illegal activity.
- Prohibited products.
- Smoking.
- Unsafe activity.
- Minor as subject (minors must not be the subject of a Live).
- Private-data exposure (personal or private data of workers, visitors, third parties, or the Place must not be exposed).

## 5. Moderation, reports, enforcement

### 5.1 Moderation
- Moderation is **required** for every Live.
- Moderation authority: **Platform Admin/Moderator** (PO, 2026-09-18). Producers are subject to moderation; they cannot moderate.

### 5.2 Reports
- Viewers must be able to **report** a Live.

### 5.3 Enforcement and fail-closed
- Enforcement is **required** and must be able to act on a Live.
- **Fail closed.** On any uncertainty, deny the action — including (non-exhaustively): authentication failure, email-verification failure, age check failure, Producer authorization failure, eligibility failure, capacity check failure, or moderation/audit subsystem failure. Never default to allowing the action.

## 6. Capacity and duration (LOCKED limits)

| Limit | Value |
| --- | --- |
| Global active Live | **5** |
| Active Live per Place | **1** |
| Viewers per Live | **100** concurrent (PO, 2026-09-18) |
| Duration per Live | **60 minutes** (hard cap) |
| Video quality | **720p / 30 fps** |

Capacity checks are enforced server-side and fail closed at the limits above.

## 7. Recording and monetization

- **Recording OFF.** No video recording of a Live; consequently there is **no replay/VOD** of a Live.
- **Monetization OFF.** No payment, checkout, wallet, tipping, subscription, or any other monetization in or around Live. Live carries no prices or tickets (informational pricing lives with the Place, per locked rules).

## 8. Technical policy

- **Streaming provider: Cloudflare Stream** (§12.1 item 1). Ingest: RTMPS/SRT. Playback: HLS/DASH. Recording remains disabled at the provider level (§7). Credentials are server-side only; implementation must not substitute a different provider. **(Superseded for ingest/playback by §12.4 #1: WebRTC/WHIP ingest + WHEP playback — §12.1 item 1 remains authoritative for provider identity, recording OFF, and credentials; RTMPS/SRT/HLS/DASH text above is historical.)**
- **Supabase is the canonical source of Live state** (status, eligibility, capacity, lifecycle, audit). Cache and search index are never the source of truth for Live state (locked engineering rule).
- **Realtime channels carry status, presence, and comments only — never video.** Viewer count is tracked canonically in Supabase; presence is ephemeral display data.
- **Stream credentials are server-side only.** Stream keys/tokens are never exposed to the client; clients receive playback/ingest access only through server-issued, scoped means. Credentials live only in the server runtime environment (e.g. Vercel Environment) — **never** in the repository, chat, or client code (PO, 2026-09-18).
- **Audit trail required** for Live lifecycle actions (start, end, moderation and enforcement actions, report submission). Audit trail is event/metadata logging — it does not contradict Recording OFF (§7), which concerns video.
- Live start/end operations are **idempotent** (a start or end submitted more than once must not duplicate state changes).
- All authorization, eligibility, and capacity checks run **server-side**.

## 9. UI policy

The UI requirements below are locked as product intent for the Live feature. They are **not** an implementation authorization.

- **Map remains primary.** Live must not displace Map-based Discovery.
- **Preserve existing search.** *(Amended §12.5 #1, 2026-09-20: time filters are removed from the Home bar; see §12.5.)*
- **Distance filter** values (exact set): `Di sekitar saya` / `500 m` / `1 km` / `5 km` / `10 km+`. *(Amended §12.5 #1, 2026-09-20: `Di sekitar saya` is removed from the Home bar.)*
- **Add a LIVE filter** and **LIVE map markers**. *(Amended §12.5 #1, 2026-09-20: the LIVE filter is first/leftmost in the Home bar and is a process/status filter, not a time filter.)*
- **LIVE card** shows: `LIVE SEKARANG` + Process + distance + Place open status.
- **Place page** shows: Live status + current Process + `Lihat Live Sekarang` (when a Live is active).
- **Preserve the Place flow**: Place → Dari Sini → Experience → SINGGAH → Visit Intent. Live navigation is added **only where compatible** with this flow and never reorders it.
- **Live viewer screen** contains: video + status + viewer count + Process + comments + report + ended state + back to Place.
- **Producer Live flow**: choose Process → camera check → preview → `Mulai Live` → `Akhiri Live`.
- **Brand:** the latest master logo/brand identity must be preserved. Mockups are a **visual reference only** — no brand redesign and no decorative-only UI elements.

## 10. Explicit non-goals

- No social livestream / arbitrary personal broadcasting.
- No payment, checkout, wallet, tipping, subscription, or monetization of Live.
- No recording, replay, or VOD.
- No multi-camera or mobile/roaming production styles (§3).
- No anonymous viewing or commenting.
- No video over Realtime channels.

## 11. Locked summary

| Rule | Value |
| --- | --- |
| Live is | Real-time Place production Process |
| Subject | The Process |
| Viewer gate | Authenticated + verified email + server-side verified age ≥ 18 (fail-closed) |
| Anonymous participation | Prohibited |
| Producer requirement | Authorized for the Place |
| Eligibility vs Place verification | Separate |
| Eligibility paths | RATING, CURATED, EXCLUSIVE, HISTORY, ADMIN_APPROVED |
| Camera | Exactly 1 fixed/static |
| Content/safety/privacy | Strict; hard prohibitions (§4) |
| Moderation/reports/enforcement | Required |
| Failure mode | Fail closed |
| Global active Live | 5 |
| Active Live per Place | 1 |
| Viewers per Live | 100 concurrent |
| Duration | 60 minutes |
| Quality | 720p / 30 fps |
| Recording | OFF (no replay/VOD) |
| Monetization | OFF |
| Streaming provider | Cloudflare Stream (ingest WebRTC/WHIP; playback WHEP — amended §12.4 #1; originally RTMPS/SRT + HLS/DASH) |
| Canonical Live state | Supabase |
| Realtime | Status/presence/comments only — never video |
| Stream credentials | Server-side only |
| Audit trail | Required |

## 12. Open decisions (pending — do not resolve by assumption)

The following are **not decided in v1.0**. Implementation must not invent them; each requires an explicit product decision and, where it changes a rule above, a new master version.

**Resolution status:** all seven items are resolved in the Phase 1.5 decision log (§12.1 below). Items 1–3 were resolved by explicit product-owner decision on 2026-09-18 (Cloudflare Stream; configurable RATING thresholds; verified-age gate). Tunable values and still-unspecified sub-details are marked in §12.1; item 4 awaits product-owner confirmation at the next master review.

1. **Streaming provider `video`:** whether `video` is the final provider identifier or a placeholder for a concrete vendor; required credentials/env var names are therefore undefined (credentials themselves stay server-side, §8).
2. **Eligibility path criteria:** thresholds/rules for `RATING`, `CURATED`, `EXCLUSIVE`, `HISTORY`, and the `ADMIN_APPROVED` workflow.
3. **Age ≥ 18 enforcement method:** self-declared date of birth vs verified age — unspecified.
4. **Process linkage:** whether a Live must reference a specific Production Story Process/stage of the Place, or may broadcast a Place production Process without a direct Production Story reference.
5. **Enforcement ladder:** specific moderation/enforcement actions and their escalation steps.
6. **Comment rules:** content limits, rate limits, and comment moderation tooling specifics.
7. **Ended-Live state:** retention of Live metadata/audit after a Live ends (video is never retained, §7).

### 12.1 Phase 1.5 decision log (added 2026-09-18)

Policy-level resolutions for §12 items 1–7. Every resolution preserves fail-closed behavior (§5.3). This log authorizes **no implementation** (see header status). No resolution invents undocumented business facts; where a value is technical rather than a business rule (e.g. comment length, rate-limit window), it is marked **tunable** and may be set precisely in the Phase 2 technical master without a policy change.

| # | Decision | Resolution | Status |
| --- | --- | --- | --- |
| 1 | Streaming provider identity | **RESOLVED — product owner, 2026-09-18.** Provider = **Cloudflare Stream**. Ingest: **RTMPS/SRT**. Playback: **HLS/DASH**. **Recording OFF** — recording must remain disabled at the provider level; no recording, replay, or VOD artifacts (§7 stands). Credentials remain server-side only (§8). Implementation must not substitute a different provider. **Amended by §12.4 #1 (2026-09-19): ingest = WebRTC/WHIP, playback = WHEP (provider limitation: HLS/DASH unsupported for WHIP inputs). RTMPS/SRT/HLS/DASH statements in this row are historical; provider identity, recording OFF, and server-side credentials remain binding.** | RESOLVED — product owner |
| 2 | Live eligibility thresholds | **RESOLVED — product owner, 2026-09-18.** All five paths are kept: `RATING`, `CURATED`, `EXCLUSIVE`, `HISTORY`, `ADMIN_APPROVED` (closed enum stored per Producer, `live_eligibility`). `RATING` evaluation uses a configurable **rating threshold** + **minimum rating count** — both are **tunable** configuration values, not hardcoded policy. Criteria for the other four paths remain unspecified in policy and must not be invented by implementation; `ADMIN_APPROVED` remains an audited admin-only server action. | RESOLVED — product owner (RATING parameters tunable; other-path criteria still unspecified) |
| 3 | Age verification method | **RESOLVED — product owner, 2026-09-18.** Viewer gate = **server-side verified age ≥ 18** + **verified email**. Verified email: server-side check of Supabase Auth `email_confirmed_at IS NOT NULL` — fail-closed when null. Age: must be **verified server-side**; **missing or unverified age ⇒ DENY (fail-closed, §5.3)**. Self-declared date of birth does not satisfy the gate. The age-verification mechanism/vendor is specified in **Phase 2.1** (deferral confirmed by product owner, 2026-09-18); policy requires only server-side verification with fail-closed denial — **until the mechanism exists, Live access is DENY for all viewers** (fail-closed by design). | RESOLVED — product owner |
| 4 | Process linkage (Place → Production Story → Process) | **Strict-MVP resolution:** a Live must reference a `production_stages` row of the broadcasting Place, verified server-side against `producer_memberships` at start (same ownership pattern as Visit Intent / Production Story persistence). The stage must be `published` at start and remain so. **Strict-MVP invariant:** if the referenced stage leaves `published` (`paused`/`archived`) mid-session, the Live **ends automatically** with `end_reason = 'source_stage_unpublished'`. Live state remains canonical in Supabase (§8); the stage reference never becomes the source of Live state. | RESOLVED — recommended direction; product owner to confirm at next master review |
| 5 | Enforcement ladder | Minimal ordered ladder, least-severe first, every step audited: (1) **warn** Producer → (2) **end the Live** (`end_reason = 'moderation'`) → (3) **suspend the Producer's Live capability** (account-level, not Place-level). Report volume can trigger review at any step. Moderation-ended sessions continue to occupy the global (5) and per-Place (1) active caps until the session is fully ended. | RESOLVED — minimal ladder; product owner may extend in a later master version |
| 6 | Comment rules | Comments require the same viewer eligibility as viewing (§2.1); no anonymous commenting. Server-validated: length ≤ 300 characters (**tunable**), per-viewer rate limit ≈ 1 comment / 5 s (**tunable**), enforced server-side. Comments are ephemeral: not retained beyond the session's ended-state window (item 7). Report action is available on comments; Producers/moderators may remove comments (audited). No viewer-initiated deletion. | RESOLVED — minimal rules; numeric limits tunable in the Phase 2 technical master |
| 7 | Ended-Live state and retention | On end — manual, 60-minute hard cap, enforcement, or source-stage unpublish (item 4) — the session row transitions to `ended` and becomes immutable; `end_reason` is recorded (`producer_ended`, `duration_cap`, `source_stage_unpublished`, `moderation`); viewer/comment writes close; an audit row is appended. **No video, audio, or frame artifacts are ever retained (§7 stands).** Retained metadata: viewer peak, timestamps, end reason, report counts, audit records. Comment counts are **active/derived only** — no permanent historical comment counts are retained (PO, 2026-09-18). A never-started or enforcement-ended session still produces its audit record. | RESOLVED |

### 12.2 Phase 2 pre-coding PO decisions (2026-09-18)

Locked by explicit product-owner decision; implementation must follow these exactly.

| # | Decision | Rule |
| --- | --- | --- |
| 1 | Viewer capacity semantics | "Viewers per Live: 100" = **concurrent** viewers (§6, §11 updated). |
| 2 | Age verification timing | Verified-age **mechanism** is specified in **Phase 2.1**; until it exists, Live access is **DENY** for all viewers (fail-closed, by design). |
| 3 | Moderation authority | **Platform Admin/Moderator**. Producers are subject to moderation and cannot moderate. |
| 4 | Cloudflare credentials | Server/Vercel runtime environment only — **never** in the repository, chat, or client code. |
| 5 | Dev-seed eligibility | Eligibility seeding for **development/test only; never production**. Production grants occur only via Platform Admin/Moderator action. |
| 6 | Comment count | **Active/derived only** — no permanent historical comment counts are retained (§12.1 item 7 updated). |

### 12.3 Phase 3 UI audit PO decisions (2026-09-19)

Locked by explicit product-owner decision; implementation must follow these exactly.

| # | Decision | Rule |
| --- | --- | --- |
| 1 | LIVE card open status | Open status on LIVE cards reuses the **existing Place schedule/status source**. When that source is missing or has no data for a Place, the UI shows **no open status** — never an invented/default status (fail-closed display). No new open-status subsystem is created for Live. |
| 2 | "Di sekitar saya" activation | Distance filtering via "Di sekitar saya" is **deferred until valid Place coordinates exist** (discovery data must be real, not invented). Until then the filter remains present but **inert/disabled** — it must not silently filter or hide results behind unavailable geolocation. The other four distance filters keep their locked radii. |

### 12.4 Phase 4 architecture amendment (2026-09-19)

| # | Decision | Rule |
| --- | --- | --- |
| 1 | Ingest protocol | **WebRTC/WHIP** replaces RTMPS/SRT for browser Producer ingest. Cloudflare Stream remains the provider (§12.1 item 1 stands). Playback follows provider support for WHIP inputs: **WHEP** (HLS/DASH is not provider-supported for WHIP-published inputs — provider limitation, not a policy choice). Recording OFF (§7), credentials server-side (§8), Supabase canonical Live state (§8), Realtime status/presence/comments only (§8) — all unchanged. | RESOLVED — product owner |

### 12.5 Home filter bar decision (2026-09-20)

Locked by explicit product-owner decision; implementation must follow these exactly.

| # | Decision | Rule |
| --- | --- | --- |
| 1 | Home filter bar | The Home discovery filter bar is exactly: **`LIVE` | `500 m` | `1 km` | `5 km` | `10 km+`**. **All time filters (`SEKARANG`, `HARI INI`, `BESOK`, `PILIH WAKTU`) are removed.** `Di sekitar saya` is removed from the bar (supersedes the inert-presence rule in §12.3 #2 — it is no longer rendered at all). **LIVE is the first/leftmost filter** and is a **process/status filter** (Places with an active Live session), not a time or category filter. Distance filters keep their locked radii (haversine, canonical coordinates). Search, Place, map-first discovery, and downstream flows are unchanged. | RESOLVED — product owner |
