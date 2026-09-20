# SINGGAH LOKAL — MASTER LIVE TECH v1.0

Status: **LOCKED** — technical master (Live Phase 2 architecture).
Date: 2026-09-18
Parent policy: `MASTER_LIVE_POLICY_v1.0.md` (all 7 §12.1 decisions RESOLVED).
Scope: technical architecture for Live. This master defines **architecture only**; it authorizes no code, no migrations, and no UI work until a separate execution decision.

Basis: `AGENTS.md` (fail-closed, server-side validation, Supabase-canonical, no cache-as-truth, idempotency), `MASTER_LIVE_POLICY_v1.0.md`, and existing repo patterns — Supabase migrations under `web/supabase/migrations/` (RLS-first, check constraints, security-definer RPCs with `search_path` fixed), `producer_memberships(user_id, place_id, role)` ownership, `production_stages` lifecycle, `visit_intents.idempotency_key` pattern.

---

## 1. Canonical data model

All Live tables live in schema `public` and follow migration conventions (RLS-first, typed check constraints, `security definer` RPCs with `search_path = public`).

### 1.1 `live_eligibility`
Grants Live capability per Producer (policy §2.4 closed enum; §12.1 item 2).

```
producer_id     text not null → producers(id) on delete cascade
path            text not null check (path in ('RATING','CURATED','EXCLUSIVE','HISTORY','ADMIN_APPROVED'))
active          boolean not null default true
rating_threshold  numeric null  -- TUNABLE (RATING path only)
min_rating_count  integer null  -- TUNABLE (RATING path only)
granted_by     text null      -- Platform Admin/Moderator identity (audit A4-style; see §2.1 platform role)
granted_at     timestamptz not null default now()
primary key (producer_id, path)   -- one row per producer per path
```

- One row per producer per path (**composite PK `(producer_id, path)`**); a producer needs **≥1 `active` row** to start a Live.
- Evaluation happens **server-side only** in the start RPC.
- `RATING` evaluation uses `rating_threshold` + `min_rating_count` (**TUNABLE**, config-driven, not hardcoded). Curated/admin paths are set only by Platform Admin/Moderator (PO, 2026-09-18) via an audited admin-authorized server action; the platform-admin identity does **not exist yet** — the grant mechanism is **BLOCKED** on admin tooling (no admin role exists in the repo).
- The repo has **no rating system today** — RATING auto-evaluation is therefore **BLOCKED** until the rating subsystem exists; until then `RATING` grants arrive via the admin path like the other curated paths.
- **Dev-seed eligibility (PO, 2026-09-18):** seeding grants via service-role SQL/tooling is allowed **in development/test environments only — never production**. Production grants occur only via Platform Admin/Moderator action.

### 1.2 `live_sessions`
One row per Live session. Canonical Live state (policy §8).

```
id              text PK (generated server-side)
place_id        text not null → places(id) on delete cascade
producer_id     text not null → producers(id) on delete cascade
stage_id        text not null → production_stages(id)   -- policy §12.1 item 4
status          text not null check (status in ('scheduled','live','ended'))
  -- 'scheduled' reserved for Phase 3 scheduled Live; Phase 2 uses 'live' on creation
live_input_id   text null   -- Cloudflare Stream live input UID (server-side only)
created_at, started_at, ended_at timestamptz
ended_reason    text null check (in ('producer_ended','duration_cap','source_stage_unpublished','moderation'))
end_note        text null
idempotency_key text not null unique  -- start RPC replay guard (pattern: visit_intents.idempotency_key)
viewer_peak     integer not null default 0 check (viewer_peak between 0 and 100)
audit...        -- no columns; audit lives in live_audit
```

- Check constraint: a Place may hold **at most one session whose `status <> 'ended'`** — partial unique index `on live_sessions (place_id) where status <> 'ended'` (per-Place cap = 1, policy §6).
- **Process is the subject** (policy §1): `stage_id` is NOT NULL; start RPC validates stage `published` + Place ownership via `producer_memberships`.
- **Never** stores stream keys, tokens, or provider URLs exposed to clients; only opaque provider UIDs.
- Live state is canonical in Supabase; provider state is never a source of truth (AGENTS: no cache/provider as canonical).

### 1.3 `live_viewers`
Admission + capacity ledger (per-session).

```
live_session_id text → live_sessions(id) on delete cascade
user_id         uuid → public.users(id) on delete cascade
admitted_at     timestamptz not null default now()
primary key (live_session_id, user_id)
```

- Rows created only by the admission RPC after full eligibility gate; a row is the **fail-closed record** of who was admitted.
- Concurrent-viewer counting uses an ephemeral **presence** layer (§6), not row deletions; rows are retained for the session (audit-adjacent, metadata only).

### 1.4 `live_reports`
Viewer reports (policy §5.2).

```
id              uuid PK default gen_random_uuid()
live_session_id text → live_sessions(id) on delete cascade
reporter_id     uuid not null → public.users(id) on delete cascade
category        text not null check (category in (
  'sexual_content','graphic_violence','illegal_activity','prohibited_product',
  'smoking','unsafe_activity','minor_as_subject','private_data','other'
))   -- 1:1 with policy §4 prohibitions + 'other'
note            text null check (length(note) <= 500)   -- TUNABLE
created_at      timestamptz not null default now()
unique (live_session_id, reporter_id, category)
```

- Write requires Live eligibility gate (§2.1) server-side; `unique` keeps one report per reporter/category/session (idempotent by nature).

### 1.5 `live_audit`
Append-only audit trail (policy §8). **No UPDATE, no DELETE** — enforced by RLS (no update/delete policies) plus trigger `block_live_audit_mutation` raising exception on any UPDATE/DELETE.

```
id              bigserial PK
live_session_id text null → live_sessions(id) on delete set null  -- survives session deletion for retention (§12.1 item 7)
actor_id        uuid null → public.users(id)
action          text not null check (action in (
  'session_started','session_ended','report_submitted','moderation_warn',
  'moderation_end','moderation_suspend','eligibility_granted',
  'eligibility_revoked','admission_denied','camera_check_passed'
))
detail          jsonb not null default '{}'      -- no video/audio artifacts ever
created_at      timestamptz not null default now()
```

- Every lifecycle/moderation/eligibility/admission action appends a row inside the same transaction as the state change (atomic, consistent with migration 0007 RPC pattern).
- Append-only + trigger; RLS `select` restricted (see §3).

---

## 2. RLS and authorization model

RLS **enabled on every table**, mirroring migration 0006 conventions.

**Auth basis** (existing patterns):
- Identity: `auth.uid()` (Supabase Auth). Email verification: `auth.users.email_confirmed_at` (policy §12.1 item 3a).
- Age: **verified age ≥ 18** (policy §12.1 item 3b). Mechanism **BLOCKED/TUNABLE → Phase 2.1**: the repo has no age data anywhere (`public.users` holds only `id`, `created_at`). The schema must eventually carry a server-managed verified-age record (e.g. `users.date_of_birth_verified_at` or a verification-vendor record). **No table/column here invents a vendor or method** — the admission gate calls a server-side `assert_viewer_eligible()` (§4.1) that fail-closes when verification data is absent.
- Producer authorization: `producer_memberships(user_id, place_id, role)` with role rules from `web/lib/producer.ts`:
  - Live start/end: **`owner`/`manager`** (publication-grade actions, same as Place/Experience publication).
  - Moderation response (warn/acknowledge): **`owner`/`manager`**.
  - Live setup/read: all roles read; start/end restricted as above.
  - **Editors cannot start/end Live** — consistent with production-story role rules where editors cannot publish.

**Policy sketch** (full SQL in the Phase 2 implementation migration; this is the locked authorization intent):

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| live_eligibility | producer self-read (own rows) | grant RPC only | revoke/suspend RPC only | none |
| live_sessions | public: live sessions of published Places (metadata only); producer read via membership | start RPC only (security definer) | end RPC only (security definer) | none |
| live_viewers | own row only | admission RPC only | none | none |
| live_reports | reporter own-read; owner/manager read for their Place | report RPC only | none | none |
| live_audit | none for authenticated (RPC/service role only) | append via RPC only | none (trigger-blocked) | none (trigger-blocked) |

**Direct INSERT/UPDATE/DELETE on Live tables is forbidden to all non-definer roles** — all writes go through security-definer RPCs (§4). This mirrors migration 0002's `revoke insert on public.visit_intents from authenticated` hardening pattern.

---

## 2.1 Age verification data (BLOCKED/TUNABLE)

The verified-age **standard** is locked (server-side verified ≥ 18, fail-closed) but the **mechanism is not**: the repo has no age/verification vendor. Options for Phase 2.1: (a) vendor verification record on `public.users`, (b) self-service verification flow against a vendor. **No table here invents the vendor.** Until the mechanism exists, `assert_viewer_eligible()` fail-closes (deny all viewers) — preserving AGENTS fail-closed behavior.

---

## 3. RLS policy intent (summary table)| Table | SELECT | Writes |
| --- | --- | --- |
| live_eligibility | producer self-read; admin grant/revoke via RPC only | RPC only |
| live_sessions | public: sessions of published Places with status='live' (metadata only); producer via membership | start/end RPC only |
| live_viewers | own rows only | admission RPC only |
| live_reports | reporter own-read; owner/manager read for their Place | report RPC only; **no UPDATE/DELETE policies for anyone** |
| live_audit | no direct SELECT for authenticated (RPC/service role only) | RPC append only; **no UPDATE/DELETE policies for anyone** |

- `live_audit` has **no SELECT policy for any authenticated role** — reads only via RPC-returned data or server-side service role. Append-only enforced by trigger + absent policies.
- All tables: `alter table ... enable row level security;` + explicit `revoke` on direct DML from `authenticated`.

---

## 4. Server-side operations (security-definer RPCs)

All RPCs `security definer` with `search_path = public` fixed (repo pattern, migration 0001/0007).

### 4.1 `assert_viewer_eligible(p_user_id uuid, p_session_id text)`
Single fail-closed gate used by admission/comment/report RPCs (identity is **always** `auth.uid()`; the parameter is validated against it or removed at implementation — audit A4):
1. Session exists and `status = 'live'` (else deny).
2. `auth.users.email_confirmed_at is not null` (else deny).
3. Verified age ≥ 18 record exists (else deny). **PO, 2026-09-18: until the verification mechanism exists (Phase 2.1), this check denies for every viewer — Live viewer access is DENY by design** (fail-closed, §2.1).
4. Capacity: **concurrent viewers < 100** (PO, 2026-09-18: "100 viewers" is concurrent — counted via active presence + re-admission grace window; the `live_viewers` ledger rows are historical metadata and are **not** counted toward the cap).

### 4.2 `start_live_session(...)`
Preconditions (all fail-closed, in one transaction):
1. `producer_memberships` role `owner`/`manager` for the Place.
2. `live_eligibility` has an `active` row for the producer.
3. Stage check: `stage_id` resolves via `(id, place_id)` into a `production_stages` row with `status = 'published'`.
4. Caps: ≤5 `status='live'` globally (enforced under **`pg_advisory_xact_lock` on a fixed cap key** to prevent READ-COMMITTED races — audit B3); 0 `status<>'ended'` for the Place.
5. Idempotency: replay of same `idempotency_key` returns the original result without side effects (pattern: `visit_intents.idempotency` + migration 0003 uniqueness).
6. Cloudflare boundary call order (locked, §5): **validate → create provider live input → persist `live_input_id` + `status='live'` + audit `session_started` in one transaction**.
7. On provider failure: nothing persisted (fail-closed, no session row).

### 4.3 `end_live_session(p_session_id, p_idempotency_key, p_reason)`
1. Membership `owner`/`manager` + session `status='live'` (else no-op/idempotent success).
2. Set `status='ended'`, `ended_at=now()`, `ended_reason` recorded, audit row appended.
3. Idempotent: second call with same key replays success without duplicate audit rows (dedupe by `idempotency_key` in the audit detail or a dedicated guard).

### 4.4 `submit_live_report(...)`, `post_live_comment(...)`, `moderate_live(...)`
- All run the full gate (§4.1) first; `post_live_comment` additionally enforces §7 tunables server-side.
- `moderate_live` is restricted to **Platform Admin/Moderator** (PO, 2026-09-18) — verified server-side against the platform role (§2.1); it implements the policy §12.1 item 5 ladder: `moderation_warn` → `moderation_end` → `moderation_suspend`; each step appends audit. Suspension is account-level: sets `live_eligibility.active = false` for all paths of that producer. Producers can respond to warnings but cannot moderate.

### 4.5 Mid-live stage unpublish hook
Policy §12.1 item 4: if the referenced stage leaves `published` (paused/archived) mid-session, the Live auto-ends with `source_stage_unpublished`. Mechanism (**TUNABLE choice**, locked behavior): **trigger** `live_stage_guard` on `production_stages` UPDATE: when `old.status='published' and new.status in ('paused','archived')` and a `status='live'` session references it → call `end_live_session(..., 'source_stage_unpublished')` (idempotent). Fail-closed: trigger failure rolls back the stage update.

**Alternative considered and rejected:** admission-time re-check only (viewer admission would fail rather than end the session) — violates the strict-MVP auto-end invariant; recorded for the record.

---

## 5. Cloudflare Stream integration boundary

Policy §12.1 item 1: provider = Cloudflare Stream. **Ingest: WebRTC/WHIP (amended 2026-09-19, PO decision — replaces the original RTMPS/SRT browser flow; Policy §12.4 #1). Playback: WHEP (WebRTC) — Cloudflare does not support HLS/DASH playback for WHIP-published inputs (provider limitation, verified against provider docs 2026-09-19). Recording disabled at provider.**

- **Credentials:** `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` — **server runtime environment only (e.g. Vercel Environment); never in the repository, chat, or client code** (PO, 2026-09-18); server-side only (`process.env` in server-only modules; never `NEXT_PUBLIC_*`; never exposed via API responses).
- **Boundary rule:** **only server-side code talks to Cloudflare.** Clients never receive stream keys/tokens. The Producer receives the WHIP publish URL (secret-bearing, per provider docs) **only in the authorized start response** — never persisted, never logged. Admitted viewers receive a **short-lived signed token** (mechanism below), not the raw WHEP URL (policy §8 "server-issued, scoped means").
- **Signed access mechanism (resolved 2026-09-19, Phase 5; provider-documented behavior only):** live inputs are created with `requireSignedURLs: true`, so playback requires a **signed token**. Provider constraints verified from current docs: the `/token` endpoint **does not support Live WebRTC**; the provider-documented path for Live is **self-signed tokens via a Stream signing key** — `POST /accounts/{id}/stream/keys` (once, admin) returns `{id, pem, jwk}`; the server signs an RS256 JWT with header `{alg: "RS256", kid: <key id>}` and payload `{sub: <live_input_uid>, kid: <key id>, exp, nbf?}`; the **token replaces the input UID in the WHEP playback URL** (token-in-place-of-id, same as manifests/player). Token TTL is short (**TUNABLE**, default 60 s, ≤ provider max 24 h). The signing key is **server-side only** (env/storage, never repo, never client). Revoking the key invalidates all tokens signed with it (provider rotation path).
- **Recording OFF at provider:** live input created with `recording: false` (provider-level hard-disable; policy requires recording to be impossible, not merely not-saved). Provider-level recording-off is verified in Phase 2.1 verification step (BLOCKED until credentials exist).
- **Mode:** the integration uses **long-lived live inputs** created per session (created by `start_live_session`), not reused inputs — avoids cross-session key leakage.
- **Live-phase guard:** player embed uses playback tokens issued per admission; ended sessions return 410-style denial server-side.
- **720p/30fps**: ingest constraint enforced at Producer setup validation (camera check step, §8) and provider input config; provider-side enforcement **TUNABLE/BLOCKED until credentials**.
- **Cleanup / orphan handling (added 2026-09-19, PO item 10):** live inputs are **per-session and deleted when the session ends** (`end_live_session` path deletes the provider input after the DB commit). Sessions that never complete start (provider created but start RPC fails/never committed) are **orphans** — the start flow deletes the provider input before aborting, and start sweeps stale `created`-status inputs (status `live` but no provider connection) as part of the global-cap count path. Fail-closed: cleanup failure never blocks session state, but orphan deletion failures are logged server-side.
- **Failure semantics:** provider failure during start ⇒ transaction aborted, no session row (fail-closed); provider failure mid-session ⇒ Realtime presence loss is display-only; session state stays canonical in Supabase and `end_live_session` (duration cap sweeper) still applies.

**Integration boundary summary:**

| Concern | Owner |
|---|---|
| Stream key/token custody | Server only |
| Live input creation (recording: false) | start RPC (server) |
| Playback token issuance | Server, per admitted viewer, RS256 signing-key token (Phase 5) |
| Playback token TTL | TUNABLE (default 60 s) |
| Provider-side recording-off verification | Phase 2.1 (needs credentials) |
| Client possession of keys | Never |

---

## 6. Realtime: status / presence / comments (never video)

Policy §8: Realtime carries **status, presence, comments — never video**.

- **Channel per session:** `live_session:{id}`.
- **Events:** `status` (`live`/`ended` + `ended_reason`), `presence` (join/leave, ephemeral), `comment` (broadcast), `capacity_full` (soft signal).
- **Viewer count:** canonical = concurrent presence count persisted to `live_sessions.viewer_peak` (check ≤ 100) by the server; Realtime presence is display-only and never the source of truth. **Cap semantics (PO, 2026-09-18): 100 = concurrent viewers** (admission gate counts active presence, not `live_viewers` ledger rows).
- **Capacity semantics:** admission RPC enforces the hard 100-concurrent cap via active presence (+ re-admission grace window, TUNABLE); `live_viewers` ledger rows are historical metadata only and never count toward the cap; `capacity_full` is informational.
- **Comments: ephemeral** (policy §12.1 item 6). Delivered via Realtime broadcast only; **no `live_comments` table**. Server validates length ≤ 300 (**TUNABLE**) and rate ≈ 1/5s per viewer (**TUNABLE**) before broadcast; rate limiting is server-side (e.g. in-RPC window check or edge middleware — **TUNABLE mechanism**).
- **Comment moderation — profanity/spam (added 2026-09-19, PO item 12):** before broadcast, the server rejects comments matching a **blocklist (profanity/hate)** or **spam patterns (repetition, link-flood, character-flood)** — the rejected comment is **never broadcast**; the viewer receives `live_comment_rejected`. Blocklist terms are **TUNABLE configuration** (server-side list, not policy-locked); the mechanism stays server-side only. Repeat violations may be surfaced to platform moderation as audit events (fail-closed default: reject + count).
- **Realtime auth:** RLS-gated channels; only admitted viewers join; producer gets owner channel with moderation events.
- **Stream health & content gate (added 2026-09-19, PO item 4):** the Live is only watchable when the provider reports the input connected (stream_healthy). The viewer page checks input status server-side before issuing playback: `not connected` ⇒ `live_stream_unavailable` (fail-closed); `connected` + platform moderation status clean (`content_status = 'ok'`) ⇒ playback issued. A session under moderation review (`content_status = 'review'`) suspends new admissions until resolved (fail-closed); a session marked `content_status = 'blocked'` ends the Live. Statuses are stored server-side on `live_sessions`, set only by the platform moderation path, never by client input.

---

## 7. Viewer capacity & duration enforcement

Locked limits (policy §6): global 5, per-Place 1, viewers 100, duration 60 min hard cap, 720p/30fps.

- **Global 5 / per-Place 1:** enforced inside `start_live_session` via count queries in the same transaction + partial unique index (per-Place) — dual enforcement (index = race-proof, count = explicit).
- **100 viewers:** admission RPC hard gate; `viewer_peak` check constraint ≤ 100.
- **60-minute hard cap:** three layers — (1) provider-side max duration where the input config supports it (**TUNABLE/BLOCKED until credentials**); (2) **self-expiry**: any RPC touching a session first applies the cap (`ended_reason='duration_cap'`) — fail-closed self-healing; (3) sweeper (`pg_cron`/edge scheduler, **TUNABLE mechanism**) cleaning up untended sessions.
- **Duration measurement:** from `started_at` (provider start ≈ DB commit; provider clock drift is display-only).
- **Recording OFF / monetization OFF:** no artifacts stored; **no payment/monetization fields, tables, or flows exist anywhere in the Live schema** (AGENTS: no payment; policy §7).
- Fail-closed everywhere: every gate denies on missing/invalid data (AGENTS fail-closed).

---

## 8. Fixed-camera validation (Producer flow)

Policy §3: exactly 1 fixed/static camera; no handheld/vlog/panning/following/multi-camera/drone/body-cam.

- **Technical enforcement is partial by nature** (no video analysis in Phase 2 scope). Locked technical controls:
  1. **Single ingest:** one live input per session; the client publishes **one track set = 1 video track**; provider input config rejects/ignores additional video tracks (**provider-side enforcement TUNABLE/BLOCKED until credentials**).
  2. **Producer camera check UI step** (policy §9 Producer flow): device selection allows exactly one video device; multi-device selection impossible by UI construction.
  3. **Producer attestation** (checkbox): "1 fixed camera, no panning/following/multi-cam/drone/body-cam" — recorded as audit `camera_check_passed` with detail `{device_count: 1}`.
  4. **720p/30fps check** in the camera-check step (media constraints on getUserMedia).
  5. **Behavioral violations** (panning, handheld style, following, drone, body-cam) are **not machine-detectable in Phase 2** — they are handled by **moderation/reports** (policy §5), not automated validation. This is the honest technical limit; the attestation + single-track ingest is the full technical guarantee for Phase 2; content-level validation is moderation's job.
- **Producer start flow (policy §9):** choose Process (published stage picker) → camera check (single video device, 720p/30fps constraint test) → preview → `Mulai Live` (calls start RPC) → `Akhiri Live` (end RPC).

---

## 9. Discovery / Place / Producer integration

Policy §9 UI policy; **Map remains primary**; search preserved. **Home filter bar amended by Policy §12.5 #1 (PO, 2026-09-20): the bar is exactly `LIVE` | `500 m` | `1 km` | `5 km` | `10 km+` — LIVE first/leftmost as a process/status filter; time filters and `Di sekitar saya` are removed from the Home bar.**

- **Distance filter** (locked set per Policy §12.5 #1, 2026-09-20): `500 m` / `1 km` / `5 km` / `10 km+` — TUNABLE radius conversion (haversine, server-or-client computed — **TUNABLE** where computed). **`Di sekitar saya` is removed from the Home bar (supersedes the deferred-activation rule of PO 2026-09-19, Policy §12.3 #2); bounded radii match only Places with canonical lat/lng, and the unbounded `10 km+` remains the default so nothing is hidden on first load.**
- **LIVE filter + markers:** the LIVE filter is **first/leftmost** in the Home bar and filters **Places with `status='live'` sessions** (a process/status filter — not a time filter); map markers for Places with `status='live'` sessions; the LIVE list is **derived data**, computed from Supabase live_sessions of published Places (canonical) — **never a cache/search index** (AGENTS).
- **LIVE card:** `LIVE SEKARANG` + Process (stage title) + distance + Place open status (from Place data). **Open-status source (PO, 2026-09-19, Policy §12.3 #1): reuse the existing Place schedule/status source; when missing/absent, show no open status — never an invented default.**
- **Place page:** live status + current Process + `Lihat Live Sekarang` — reads canonical `live_sessions status='live'` for the Place.
- **Place flow preserved:** Place → Dari Sini → Experience → SINGGAH → Visit Intent untouched; LIVE entry points are additive (map markers, Place page strip); Live navigation added **only where compatible**.
- **Producer app:** Live section lists the Place's stages (published only, for start flow), eligibility status, session history (metadata-only), moderation notices; editors see read-only (no start/end).
- **Ended sessions:** Place page returns to the pre-Live state; no replay/VOD anywhere (policy §7).
- **Scheduled Live ('scheduled' status):** reserved for a future phase; Phase 2 creates sessions directly in `live`. Any scheduler UI is **BLOCKED** for Phase 2 scope.

---

## 10. Configurable tunables (TUNABLE registry)

All tunables are **server-side configuration, not hardcoded policy values**; defaults here are initial values, changeable in the Phase 2 implementation without a policy/master change.

| Tunable | Default (initial) | Where enforced |
|---|---|---|
| RATING threshold + min count | none yet (**BLOCKED** — no rating subsystem exists in repo) | `live_eligibility` evaluation in start RPC |
| Comment length | 300 chars | post_live_comment RPC |
| Comment rate | ≈1 per 5 s per viewer | post_live_comment RPC (mechanism TUNABLE) |
| Playback token TTL | 60 s (max 24 h per provider) | server signing-key token issuance (Phase 5) |
| Signing-key custody | server env/secret storage only | boundary module (`lib/live/cloudflare.ts`) |
| Presence re-admission grace | short window | admission RPC |
| Duration-cap sweeper schedule | frequent enough to bound overage to minutes | sweeper (mechanism TUNABLE) |
| Report note length | 500 chars | submit_live_report RPC |
| 720p/30fps | provider input config | provider + camera check |
| Age-verification mechanism | none (**BLOCKED** → Phase 2.1) | assert_viewer_eligible |
| Distance radius conversion | haversine | discovery layer (where computed: TUNABLE) |
| Home filter bar | `LIVE` \| `500 m` \| `1 km` \| `5 km` \| `10 km+` (Policy §12.5 #1, 2026-09-20) | Home discovery bar |

- **BLOCKED registry:** age-verification mechanism (**Phase 2.1** — until it exists, viewer access is DENY by design); Platform Admin/Moderator identity/tooling (moderation + eligibility grants + production grant path); rating subsystem for RATING auto-eval; provider-side recording-off verification + provider-side single-track rejection (needs credentials); scheduled Live; comment rate-limit mechanism choice.
- **TUNABLE values registry (server config, not business rules):** comment length/rate, playback TTL, grace window, sweeper schedule, report note length, RATING threshold+count (once the rating subsystem exists).
- **Schema corrections carried from audit (C1/M1/M2/M3, technical):** `live_eligibility` composite PK `(producer_id, path)` (done above); `live_sessions` comment retention = **active/derived only** (PO: no permanent historical comment counts — a derived live count is exposed via Realtime/status, not persisted history); `live_reports.comment_ref` nullable session+sequence reference (report-on-comment); `live_audit` action `comment_removed` added to the enum.

---

## 11. What Phase 2 does NOT include (scope fence)

- No code, migrations, or UI in this phase — architecture only.
- No payment/checkout/wallet/tipping/subscription (AGENTS; policy §7) — no such fields exist in the schema by design.
- No recording, replay, or VOD.
- No `live_comments` persistence table (comments are ephemeral via Realtime).
- No video analysis / machine detection of camera-style violations.
- No admin console; admin grant path is **BLOCKED** on admin tooling.
- No scheduled Live (status `scheduled` reserved).
- No cache/search-index storage of Live state (AGENTS: canonical = Supabase).

---

## 12. Traceability — policy → tech

| Policy (MASTER_LIVE_POLICY §) | Tech master (§) |
|---|---|
| §2.1 viewer gate | §2, §2.1, §4.1 |
| §2.2 Producer authorization | §2, §4.2 |
| §2.4 eligibility paths | §1.1 |
| §2.4 RATING tunables | §1.1, §10 |
| §3 camera rules | §8 |
| §4 prohibitions → report categories | §1.4 |
| §5 moderation/reports/enforcement | §1.4, §4.4 |
| §6 capacity/duration | §1.2, §4.2, §7 |
| §7 recording/monetization OFF | §1.5, §5, §7, §11 |
| §8 Supabase-canonical/Realtime/credentials/audit/idempotency | §1.2, §1.5, §5, §6 |
| §9 UI policy | §9 |
| §12.1 item 4 auto-end | §4.5 |
| §12.1 items 5/6/7 | §4.4, §6, §7 |

---

## 13. Verification

- Consistent with `AGENTS.md`: fail-closed gates (§4.1), server-side-only credentials (§5), canonical Supabase state (§1.2), idempotent start/end (§4.2–4.3), no payment fields (§11), no cache-as-truth (§9).
- Consistent with `MASTER_LIVE_POLICY_v1.0.md`: every policy section maps in §12; nothing here invents business facts — every value is either locked policy, repo-derived pattern, **TUNABLE** (server config), or **BLOCKED** (explicit registry, §10).
- Repo-pattern fidelity: RLS-first migrations with explicit revokes (0002 pattern), security-definer RPCs with fixed `search_path` (0001/0007 pattern), partial unique index for per-Place cap, idempotency keys (0003 pattern), `producer_memberships` role checks (0001), `production_stages` published-check (0006).
- No code, migrations, or UI authored in this phase; no commit/push performed.
