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
`aa6cc74022ffc75987cbb82d29323f510616e358`
`Guard the 100-concurrent Live viewer cap against admission races`

NOTE: repository history was squashed into a single root commit (the commit
above); earlier SHAs such as `34561997...` are no longer reachable. Audit
always re-reads current `main`, never assumes prior SHAs.

Verified 2026-09-26: web test suite 411/411 pass.

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
`0027_live_viewer_cap_race_guard.sql`

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
   `LIVE | 1 km | 5 km | 10 km+`
7. No stale `Di sekitar saya`
8. No stale time filters
9. No TODO/FIXME or duplicate implementation
10. Regression tests remain aligned with current RPC signatures

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
