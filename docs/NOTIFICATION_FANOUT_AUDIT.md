# NOTIFICATION — fan-out audit & result

Date: 2026-09-27
Scope: MASTER 10 (Notification & Communication System) event delivery, header unread.
Sources read before coding: `AGENTS.md`, `docs/masters/MASTER_INDEX_v1.0.md`,
`SINGGAH_LOKAL_MASTER_10_NOTIFICATION_COMMUNICATION_v1.0.docx`,
`docs/ACCOUNT_MENU_GAP_AUDIT.md`, `docs/HANDOFF_LIVE_MVP.md`, current `main`, migrations 0001–0028.

## 1. Root cause

Only ONE domain event produced a notification: migration `0026` (Live started →
Place followers). Everything else the Master defines as an event wrote **no
notification row at all**:

| Event | Row written before this change |
| --- | --- |
| Producer application submitted | none |
| Producer application approved / rejected | none |
| Place claim submitted | none |
| Place claim approved / rejected | none |
| Visit Intent created / accepted / declined / requires confirmation / cancelled / expired | none |

So the Admin review queue and the Producer inbox never showed that work was
waiting for a decision, and no recipient was ever told about a status change.

Second, separate cause: the header bell only re-read `/api/notifications` on
mount, on route change, and on session change
(`web/components/notification-bell.tsx`). Any event that arrived while a tab
stayed open left the badge stale until a manual refresh.

Third, latent cause: migration `0017` stores ONE `producer_applications` row per
account (a refile resets the same row). The dedup key from `0026` is keyed on the
entity id, so a refile after a rejection would have been swallowed as a duplicate
— the Admin would never learn a new submission is waiting.

## 2. Result — MASTER 10 §6 event → recipient map (implemented)

| Event | Recipient | Category | `event_type` |
| --- | --- | --- | --- |
| Producer application submitted | Platform Admin (`users.platform_role = 'platform_moderator'`) | `system` | `producer_application_submitted` |
| Application approved | the applicant (Producer) | `system` | `producer_application_approved` |
| Application rejected | the applicant (Producer) | `system` | `producer_application_rejected` |
| Place claim submitted | Platform Admin | `system` | `place_claim_submitted` |
| Place claim approved | the claimant (Producer) | `system` | `place_claim_approved` |
| Place claim rejected | the claimant (Producer) | `system` | `place_claim_rejected` |
| Visit Intent created | the Place's `owner`/`manager` memberships | `visit_experience` | `visit_intent_created` |
| Visit Intent accepted | the User who filed it | `visit_experience` | `visit_intent_accepted` |
| Visit Intent declined | the User who filed it | `visit_experience` | `visit_intent_declined` |
| Visit Intent requires confirmation | the User who filed it | `visit_experience` | `visit_intent_requires_confirmation` |
| Visit Intent cancelled | the party who did NOT cancel it | `visit_experience` | `visit_intent_cancelled` |
| Visit Intent expired | the Place's Producers | `visit_experience` | `visit_intent_expired` |
| Live started (0026, unchanged) | Place followers | `live_place` | `live_started_followed_place` |

Rules held: no new category (the six of 0024/0025 only), no new event outside the
Master, payload references the entity instead of duplicating business state
(§5), Visit Intent date/time is rendered in the Place timezone (§7/§21), and no
wording implies payment, an order, or a guaranteed reservation (§2).

## 3. Deliberately NOT implemented (no trigger point exists in the code base)

`Content published`, `Content publication blocked`, `Moderation action`,
`Verification status changed` (Producer/Place claim status), `AI quota warning`,
`AI quota exhausted`, and `Security/account alert`.

Each is defined in MASTER 10 §6, but no current write path emits it, so adding
one would have meant inventing both the event and its trigger. The mandatory
`safety_account` category stays unfiltered by preferences and is ready for its
first real event.

Known gap found while auditing, NOT changed here (out of scope): migration `0002`
only allows `pending → accepted | declined | requires_confirmation` (and the same
from `requires_confirmation`). No write path can set `cancelled` or `expired`, so
those two Master events are implemented and unit-tested but unreachable until a
product decision enables those transitions. Relaxing `0002` would be a business
rule change, not a notification fix.

## 4. Files changed

- `web/supabase/migrations/0029_notification_fanout.sql` (new) — fan-out triggers,
  the `notify_recipient` writer, the submission counter, and the realtime signal.
- `web/components/notification-bell.tsx` — realtime unread subscription.
- `web/app/api/auth/realtime-token/route.ts` — also returns the caller's own user id.
- `web/tests/notification-fanout-migration.test.ts` (new) — 18 PGlite tests.
- `web/tests/notification-unread-realtime.test.ts` (new) — 8 client-contract tests.

Nothing in `notification-service.ts`, `notification-repository.ts`,
`notifications-model.ts`, the inbox page, or the Notification Settings form was
touched: the existing UX and preference semantics are unchanged.

## 5. Behaviour kept identical to what already worked

- Preference rule: a stored OFF flag on the event's own category suppresses the
  row; no preference row keeps the `0024` default (ON) — the same rule `0026`
  already used for `live_place`. `safety_account` is never filtered.
- Deduplication: the `0026` unique key `(user_id, source_type, source_id,
  event_type)` now covers every event. A duplicate domain event writes nothing
  and sends no second realtime signal.
- Failure isolation: a notification failure warns and never rolls back a valid
  Visit Intent / application / claim change (§17).
- Authorization: recipients are resolved from `platform_role` and
  `producer_memberships` — the same predicates the review routes and the
  `visit_intents` RLS already use. `notifications` stays recipient-scoped and
  `read_at`-only for clients.

## 6. Realtime unread

The database broadcasts an `unread` signal on the recipient's OWN private topic
`notifications:{user_id}` after a notification is created and after it is marked
read. The `realtime.messages` RLS policy is the gate: a session may receive only
on the topic built from its own `auth.uid()`. The badge itself still reads the
canonical, RLS-scoped count from `/api/notifications`; the signal only says
"re-read it". No polling and no database subscription were added, and a denied
join tears the client down instead of degrading.

## 7. Verification

- `web/tests/notification-fanout-migration.test.ts` — 18/18 (real migration chain
  on PGlite: recipients, dedup, preferences, realtime topics, RLS, idempotent
  re-apply, no payment wording, failure isolation, and 0026 unchanged).
- `web/tests/notification-unread-realtime.test.ts` — 8/8.
- Full `web` suite: 480/481. The single failure
  (`lifecycle-form-state.test.ts` → "Map teardown destroys listeners…") is
  **pre-existing on `main`** and unrelated to notifications — it was verified to
  fail identically with these changes stashed.
