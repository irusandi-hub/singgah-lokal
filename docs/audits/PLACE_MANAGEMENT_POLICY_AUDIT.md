# AUDIT — PERMANENT DIGITAL PLACE-MANAGEMENT POLICY

**Scope:** the permanent Singgah Lokal policy that separates **digital place-management
permission** from **real-world legal ownership**, end to end — database, authorization,
Admin Center, place-management workflows, audit history, archival behaviour, Terms of
Service, and documentation.

**Date:** 2026-10-15 · **Base:** `main` @ `0a447bb` (PR #47 merge) ·
**Delivered in:** migrations `0058`, `0059` + application/test changes on
`feat/place-management-policy-managerless`.

---

## 1. Where the repository stood before this work

| Item | State found | Evidence |
| --- | --- | --- |
| PR #47 | **MERGED** into `main` (`0a447bb`); no open integration PR. | `gh pr view 47`, `git log origin/main` |
| `0057_admin_revoke_producer_place_access.sql` | Applied. Adds `producer_memberships.id`, two audit actions, and one `SECURITY DEFINER` RPC. | migration file; DEV probe (§7) |
| Last-owner safeguard | **PRESENT and active.** `revoke_producer_place_access` counted owners and returned `status: 'last_owner'` **without** revoking. | `0057` §3.3 |
| `places.producer_id` | `text references public.producers(id)`, **nullable** since `0001`. No schema change is required to hold a managerless Place. | `0001` L41 |
| Management authority | **Membership-scoped only.** `canManagePlace` ignores `places.producer_id` (commit `a43bdeb`, G-AUTH-1); RLS policies, server gates, and the RPC all key on `producer_memberships.place_id`. | `lib/producer.ts`, `place-experience-repository.ts` |
| Claim gate | `place_has_active_ownership(place_id)` = *a membership row exists* **OR** *`places.producer_id` is not null* (`0028`). It is the gate inside `submit_place_claim`. | `0028` L92, L170 |
| Admin Center → Data Pengelola | `/admin/producer-membership`: relation table + per-row **Cabut Hak Akses** + shared confirmation dialog. | `app/admin/producer-membership/*` |
| Admin Center → Place detail → Pengelola | `AdminPlaceMembersPanel` on `/admin/places/[placeId]`. **It disabled the action for the last owner** ("Tidak dapat dicabut: Pemilik terakhir"). | `components/admin/place-members-panel.tsx` |
| Audit | `place_audit` (0031): append-only trigger, RLS on, **no policy**, revoked from `public/anon/authenticated`. Actor = the authenticated admin. | `0031`, `lib/admin/place-audit.ts` |
| Notifications | `notify_recipient` (0029) with preference gates + dedup key (0026); notification failure must not roll back the business change (MASTER 10 §17). | `0057` §3.6 |
| Archival | `places.publication_status` incl. `archived`; Admin moderation actions already exist and are audited. **No automatic archival on revocation** (correct — archival stays an explicit Admin act). | `place-workspace.ts`, `app/admin/places/[placeId]/page.tsx` |
| Terms of Service | **Did not exist.** No ToS document, no versioning, no acceptance record, and no `/terms` route. `/policy` (Kebijakan Data & Klaim Tempat) was the only disclosure surface, and `app/about/page.tsx` explicitly stated that Terms awaited a source of truth. | repo-wide search; `MASTER_DATA_RETENTION…` §13, §16.7 |

## 2. Policy violations found (what had to change)

1. **Rule B/C violated — revocation was blocked by the model, not by policy.**
   On a Place with one owner the RPC refused the revoke (`last_owner`), and the
   Place-detail UI rendered that refusal as a disabled action. An Administrator could
   not remove a manager's access without first appointing a replacement, and a Place
   could not be left without a digital manager. That is exactly the state the policy
   forbids.
2. **Revocation carried no reason.** `0057` accepted `(actor, membership)` only. Policy
   requires the revocation to be justified and recorded. Nothing in the trail said
   *why* access was removed.
3. **A revoked Place stayed unusable.** Nothing cleared the stale `places.producer_id`
   when the last manager was revoked, so `place_has_active_ownership` stayed `true`:
   the Place had no manager **and** could not be claimed by the rightful party through
   the official claim process. A "managerless" Place was therefore not a supported
   state, only a dead end.
4. **Concurrency was protected against the wrong invariant.** `0057` locked the owner
   rows to protect the last-owner count. Removing that safeguard removes the invariant
   — so the new state transition (count remaining managers → release the Producer
   pointer) needed its own serialization, otherwise two concurrent revocations on the
   same Place could both read "one manager left" and leave a stale pointer behind.
5. **The policy was not disclosed anywhere users can read it.** No Terms, no versioned
   document, no acceptance record.

Not violations, recorded as deliberate decisions preserved by this work:
`places.producer_id` remains the **Producer entity pointer** (display/history); it is
never a management grant, and it is released *only* when the Place truly has no manager
left.

## 3. Implementation delivered

### 3.1 `0058_place_management_policy_managerless.sql` (forward-only)

* **Drops the last-owner refusal.** Revoking the final manager now succeeds. The
  `producer_place_access_revoke_denied` audit value stays in the `place_audit` CHECK so
  existing trail rows remain valid; `0058` never writes it again.
* **Mandatory reason.** `p_reason` (3–500 chars, validated inside the function *before*
  any write). Missing/blank/short/oversized → `status: 'invalid_reason'`, **no delete, no
  audit row, no notification**.
* **Managerless state made real.** After the delete the function counts the remaining
  memberships; when the Place has **none** and `places.producer_id` points at the
  Producer whose membership was just revoked, the pointer is released (`NULL`,
  `updated_at` refreshed). The Place, its content, its Experiences, its Visit Intents,
  and its audit history are untouched; `place_has_active_ownership` becomes `false`, so
  the official claim process (`0028`) is the documented recovery path — never a forced
  replacement.
* **Per-Place serialization.** `pg_advisory_xact_lock(hashtext('revoke_producer_place_access:' || place_id))`
  taken **before** the count/release, plus `FOR UPDATE` on the target membership row for
  duplicate revocations of the same row. The lock key is a pure function of the Place,
  so different Places never block each other.
* **Audit record** (`place_audit`, append-only, RLS-closed): actor, Place, membership id,
  target account, role, **reason**, result, manager count after the operation,
  `managerless`, `producer_pointer_released`, publication status, notification outcome,
  and a before/after snapshot (`before_data.place_producer_id` → `after_data.producer_id`,
  `membership_count`). If the audit insert fails, the whole transaction — including the
  revocation — rolls back.
* **Notifications** keep the `0057` shape (one mandatory `safety_account` message to the
  revoked account, one `system` message to remaining owner/manager peers, none to
  editors) and now also state that the action is **digital-only** and does not determine
  legal ownership. A notification failure is still contained in a savepoint and reported
  as `notified: false` — it never silently reverses the revocation.
* **Least privilege** unchanged: `revoke all … from public, anon, authenticated` + `grant
  execute … to service_role` only. The reason-less `(uuid, uuid)` overload is dropped:
  two overloads would be ambiguous and the 2-arg form would let callers bypass the
  mandatory reason.

### 3.2 `0059_legal_documents_acceptance.sql` (forward-only)

* `legal_documents` — the official registry (id, title, **version**, effective date,
  whether acceptance is required). Publicly readable; never written from the app.
* `legal_document_acceptances` — **append-only** `(user_id, document_id, version,
  accepted_at)`. RLS: a signed-in account may read and insert **its own** rows only, and
  the insert policy additionally requires the version to be the one that is *currently*
  in force. Update/delete are impossible from clients (no policy, no grant) **and** from
  the service role (guard trigger) — the same shape as `place_audit`.
* Seeded with `ketentuan-penggunaan` v1.1 (2026-10-15), `requires_acceptance = true`.

### 3.3 Application

* `lib/admin/revoke-reason.ts` (pure) — reason bounds, the operator-facing reason list,
  validation, status→message, status→HTTP. Shared by the Admin form and the server.
* `lib/admin/producer-membership-revoke.ts` (server-only) — adds the reason, returns
  `managerCount` / `managerless` / `placePublicationStatus` from the database, and
  removes the `last_owner` outcome entirely.
* `POST /api/admin/producer-memberships/:membershipId/revoke` — reads **only** `reason`
  from the body; Platform Admin guard per request; server-owned messages.
* Confirmation dialog (one shared component, both surfaces) — names the account, email,
  and Place; **always** states that this removes digital management permission only and
  does not determine legal ownership, and that Place data/history are not deleted;
  **requires** a reason (policy list + free text) before the confirm button is enabled.
* Place-detail "Pengelola" — every membership is revocable, **including the last owner**;
  an empty list renders an explicit *"Tanpa Pengelola digital aktif"* state that points at
  the official claim process, and an archived Place shows its archived state.
* Data Pengelola — the relation table keeps its per-row action, the page states the
  policy, and a **"Tempat tanpa Pengelola digital aktif"** list makes the managerless
  Places visible instead of silent (`listAdminManagerlessPlaces()`, derived from the
  canonical membership set — never a cached flag).
* `lib/legal/documents.ts` (pure) — Ketentuan Penggunaan v1.1 with the mandated policy
  text (each material principle, verbatim), plus an explicit **"menunggu peninjauan
  hukum"** notice. One source for the prose.
* `lib/legal/acceptance.ts` (server-only) + `POST /api/legal/accept` + `/ketentuan` +
  the acceptance card on `/account` + a required terms checkbox on sign-up. The version
  written is always the one from the register, never a client value.
* `/policy` (the existing disclosure surface) now also discloses the digital-management /
  revocation policy and links `/ketentuan`, so Terms, policy, database, and UI agree.
  Wording is not duplicated onto `/about`: About only links both documents.

## 4. Requirements → evidence map

| # | Requirement | Where it is enforced | Test |
| --- | --- | --- | --- |
| 1 | Admin can revoke the final active manager | `0058` §1.6 (no last-owner gate) | `admin-revoke-place-access` #7, #12; `db-regression` #19 |
| 2 | A Place can remain stored without an active manager | `0058` §1.7 (no delete, no auto-archive) | #7, #9; `admin-place-detail-revoke` #3 |
| 3 | Managerless needs no replacement account | `0058` §1.7 (no membership is created) | #7; `db-regression` #20 |
| 4 | Revoked account loses every authorization path | membership row is deleted (the only authority); RLS + server gates read it | #16; `db-regression` #29 |
| 5 | Unauthorized users cannot run the privileged operation | `0058` §1.1 (`platform_admin_required`) + `SECURITY DEFINER` + `service_role`-only EXECUTE | #4, #24; `db-regression` #7–#9, #26 |
| 6 | Other Places of that account are unchanged | single-row delete keyed by membership id | #14; `db-regression` #28 |
| 7 | Unrelated memberships/permissions unchanged | same | #15; `db-regression` #30 |
| 8 | Place data + administrative history preserved | no delete of Place/history; audit snapshot | #7, #15; `db-regression` #20, #21 |
| 9 | Audit has actor, target, reason, timestamp, outcome | `0058` §1.9 | #11; `db-regression` #13, #21 |
| 10 | Repeated revocation is safe | idempotency lookup on the trail + row lock | #13; `db-regression` #24, #25 |
| 11 | Concurrent admin ops cannot produce inconsistent state | per-Place advisory xact lock + row lock | #20 (contract), #21, #22 — **see §5** |
| 12 | Notification failure cannot mislead | savepoint + `notified: false` + audit | #19 |
| 13 | Regranting needs the authorized process | client INSERT into `producer_memberships` denied; claim path is server-authorized | #8, #23 |
| 14 | Admin UI shows managerless and archived states | `place-members-panel` + Data Pengelola list | `admin-place-detail-revoke` #8; `admin-revoke-place-access-ui` #15 |
| 15 | Terms available through the real legal interface | `/ketentuan` + register version + acceptance card | `legal-documents` #1–#3, #5–#8, #10 |
| 16 | Existing ownership-claim / other protections still work | claim gate, `place_audit` append-only, notifications locked, membership RLS | `admin-revoke-place-access` #8, #17, #18, #23; `legal-documents` #4 |

## 5. Concurrency: what was and was NOT proven

* **Implemented:** one per-Place `pg_advisory_xact_lock` taken before the remaining-manager
  count and the Producer-pointer release, plus `FOR UPDATE` on the target membership row.
  Together they make the transition atomic per Place and idempotent per row.
* **Tested:** the serialization *contract* (lock present, taken before the count, before
  the release; row lock present), that the lock key is deterministic and Place-specific,
  the dangerous **sequential** orderings (2 → 1 → 0 managers, duplicate revokes,
  already-revoked replays), and the final state invariants.
* **NOT tested — reported honestly:** genuine **parallel** execution of two transactions.
  The sandbox's Postgres engine (PGlite) is a single connection, so two concurrent
  sessions cannot be created here. Concurrency is therefore **not** claimed as verified;
  the remaining risk is bounded by the advisory lock design, and the two-session
  confirmation is left as an explicit DEV step in the runbook.

## 6. Test results (this change)

* Full web suite: **152/152 files, 1567/1567 tests, 0 failures** (one file per process —
  a single-process run is OOM-killed in the 1-CPU/2 GB sandbox; two files were SIGKILLed
  mid-run and passed on a fresh process, which is an environment limit, not a defect).
* Focused: `admin-revoke-place-access` 24/24 · `admin-place-detail-revoke` 10/10 ·
  `admin-revoke-place-access-ui` 24/24 · `admin-revoke-place-access-migration` 3/3
  (this one executes the committed 33-check regression script on the real chain through
  `0059`) · `legal-documents` 10/10.
* `npx tsc --noEmit` → exit 0 · `npx eslint .` → exit 0, 0 errors, 11 pre-existing
  warnings (none in the changed files).
* The committed regression script also runs standalone against DEV
  (`psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/admin-revoke-place-access.sql`).

## 7. DEV migration status (read-only verification)

Project under test: the linked DEV project (`qiwexmzbysujmqctrsiq`). Probes are
**read-only** PostgREST calls; no migration was applied.

| Probe | Result | Meaning |
| --- | --- | --- |
| `POST /rest/v1/rpc/revoke_producer_place_access {p_actor_id,p_membership_id}` | `401 permission denied for function` (2-arg resolved) | the **0057** signature exists |
| `POST … {p_actor_id,p_membership_id,p_reason}` | `404 PGRST202 … no matches were found` | **0058 is NOT applied** |
| `GET /rest/v1/legal_documents` | `404` | **0059 is NOT applied** |
| `GET /rest/v1/producer_memberships?select=id` | `200` (empty table) | 0057's `id` column is live |

**Blocker:** the migration could not be applied from this environment. There is no `psql`,
no Supabase CLI, no Postgres driver, and the DEV connection string
(`SUPABASE_DEV_DB_URL`) is a secret that is neither present nor readable here. Per the
existing checklist, applying to DEV requires the SQL-Editor paste or a `psql` session with
that connection string. **The policy is therefore NOT in force on DEV yet** — see
`docs/runbooks/PLACE_MANAGEMENT_POLICY_DEPLOYMENT.md` for the exact sequence.

## 8. Open items for the product owner

1. **Legal review.** Ketentuan Penggunaan v1.1 is written from the product decision and is
   explicitly marked as *awaiting legal review* in the document, the register, and the
   acceptance card. It must not be represented as legally final until that review happens.
2. **Privacy policy.** Still absent (no Privacy master). The new ToS references `/policy`
   for retention/privacy rather than inventing a privacy document.
3. **DEV apply + two-session concurrency check** (§5, §7).
4. **Post-deploy UI verification** in the deployed Admin Center (both surfaces).
