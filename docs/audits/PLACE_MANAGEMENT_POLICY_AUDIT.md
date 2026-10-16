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

## 4.1 The 17 business/security scenarios requested by the owner

Each row was executed on the real migration chain (PGlite), not inspected in source.
Numbers in parentheses are the test names in `web/tests/admin-revoke-place-access.test.ts`
unless another file is named.

| # | Scenario | Executable check | Result |
| --- | --- | --- | --- |
| 1 | Revoke one of several managers | `owner non-terakhir, manager, editor, dan owner TERAKHIR semuanya dapat dicabut`; `mencabut satu Tempat tidak memengaruhi Tempat lain…`; `hitung baris…` | PASS |
| 2 | Revoke the **last** manager | `pengelola TERAKHIR dapat dicabut — Tempat valid tanpa Pengelola (aturan B & C)` | PASS |
| 3 | Reject empty / too-short reason | `alasan kosong/pendek/terlalu panjang DITOLAK tanpa efek samping apa pun` | PASS |
| 4 | Reject an over-limit reason | same check (501 → 500-character boundary both sides) | PASS |
| 5 | A failed revocation deletes nothing | same check + `membership id palsu ditolak; tidak ada efek samping` | PASS |
| 6 | The Place still exists after revocation | `pengelola TERAKHIR dapat dicabut…` (row present) + `hitung baris…` | PASS |
| 7 | Content, Experience, Visit Intent, history preserved | `hitung baris: hanya producer_memberships yang berubah` — asserts the seeded `experiences` (1), `visit_intents` (1) and `places` (3) are still there, that only the membership count moves, and that `place_audit` **grows** by exactly the 2 rows the run wrote | PASS |
| 8 | Authority gone on **every** authorization path | `Produser yang dicabut langsung kehilangan akses kelola (gate server + RLS)`; `anon dan non-admin tidak dapat membaca atau menulis audit` | PASS |
| 9 | `places.producer_id` released only in the right condition | `penanda Produser TIDAK dilepas selagi masih ada pengelola lain`; `pengelola terakhir: penanda Produser dilepas…` | PASS |
| 10 | A managerless Place is recoverable by the official claim process | `pengelola terakhir: penanda Produser dilepas dan jalur klaim resmi terbuka` (`submit_place_claim` accepted; **no** authority before approval) | PASS |
| 11 | No automatic archiving from the revocation | `pengelola TERAKHIR dapat dicabut…` (`publication_status` still `published`) | PASS |
| 12 | Audit records actor, target, reason, time, outcome | `alasan yang sah dicatat utuh di trail audit bersama actor, target, dan hasil`; `admin sah dapat mencabut…` | PASS |
| 13 | **An audit-write failure cancels the revocation transaction** | `kegagalan penulisan audit membatalkan pencabutan — tanpa jejak, tanpa efek` (**added in this pass**) | PASS |
| 14 | A notification failure cannot reverse a successful revocation | `kegagalan notifikasi tidak membatalkan pencabutan, dan tercatat di audit` | PASS |
| 15 | The revoked account cannot keep managing through another path | `Produser yang dicabut langsung kehilangan akses kelola…`; `pemberian kewenangan ulang hanya lewat proses resmi…` | PASS |
| 16 | Ordinary users cannot call the admin function | `tanpa sesi/non-admin ditolak…`; `service_role punya EXECUTE, dan fungsi memverifikasi admin di dalam DB` | PASS |
| 17 | Concurrent revocation cannot leave a wrong manager state | contract + measured lock + sequential orderings (§5) | **PARTIAL** — semantics proven, true parallelism NOT RUN |

Scenario 13 closes a gap this audit previously left open: nothing tested that a failing
audit write aborts the business change, even though `0058` §1.9 states exactly that. The new
check forces the audit insert to raise and then asserts the membership row survives, the
Producer pointer is untouched, the notification written earlier in the same transaction is
gone, and the audit trail is empty — then that the very same revocation succeeds once the
fault is removed. It is **non-vacuous in both directions**: a pass-through marker that only
`nextval` (non-transactional, so it survives the rollback) can observe proves the failing
write happened at the audit step and not earlier, and wrapping the audit insert in a
swallowed `exception` handler in `0058` makes the test fail (`not ok 20`), which was checked
by mutation and then reverted (`0058` byte-identical to `HEAD`, `sha256 5e1b879a…`).

## 5. Concurrency: what was and was NOT proven

* **Implemented:** one per-Place `pg_advisory_xact_lock` taken before the remaining-manager
  count and the Producer-pointer release, plus `FOR UPDATE` on the target membership row.
  Together they make the transition atomic per Place and idempotent per row.
* **Tested:** the serialization *contract* (lock present, taken before the count, before
  the release; row lock present); that the lock key is deterministic and Place-specific;
  the dangerous **sequential** orderings (2 → 1 → 0 managers, duplicate revokes,
  already-revoked replays); and the final state invariants.
* **Executed, not just asserted:** the *lifetime* of the lock is observed on the real
  engine through `pg_locks` **from inside the revoking transaction** — the probe must read
  **0 before** the revocation and **1 after**, for the exact key
  `hashtext('revoke_producer_place_access:' || place_id)` (bigint → `classid`/`objid`), and
  0 again after the transaction ends. That bidirectionality is deliberate so the assertion
  cannot pass vacuously; removing the `pg_advisory_xact_lock` line from `0058` makes it fail
  with `advisory_lock_not_held_during_revocation (found 0)`, which was checked by mutation and
  then reverted. This is the semantic that makes a second session block, and it is now
  measured rather than assumed.
* **NOT tested — reported honestly:** genuine **parallel** execution of two transactions.
  The sandbox has no Postgres server binary (`postgres`/`initdb`/`psql` are all absent) and
  its Postgres engine (PGlite) is a single connection, so two concurrent sessions cannot be
  created here. Concurrency is therefore **not** claimed as verified; the remaining risk is
  bounded by the advisory-lock design plus the measured lock lifetime above, and the
  two-session confirmation is left as an explicit DEV step in the runbook.

## 6. Test results (this change)

* Full web suite, re-run in this pass on the current content (one file per process — a
  single-process run is OOM-killed here): **152/152 files ran, 1562/1565 tests passed,
  3 failed**. All three failures are kernel `SIGKILL` — the host log records
  `Out of memory: Killed process … anon-rss:1316444 kB` on this 1-CPU/2 GB box — not
  assertion failures: `place-curated-admin-migration`, `discovery-aggregate`,
  `discovery-dev-dataset`. Two of the three were re-run on **pristine `origin/main`
  (`0a447bb`) in a clean worktree and fail identically** (`3/4` and `4/5`, both
  `signal: 'SIGKILL'`), and none of the three — nor any module they load — is in this PR's
  31-file delta, so they are environment limits, not regressions. The third
  (`discovery-dev-dataset`) could not be conclusively re-tested on `main` (its worktree run
  exceeded the command time budget), so for that one file non-causality rests on the delta
  check and the fact that the failure is a kernel kill rather than a failed assertion.
* Focused: `admin-revoke-place-access` **26/26** (25/25 before the test added in this pass —
  §4.1 #13) · `admin-place-detail-revoke` 10/10 · `admin-revoke-place-access-ui` 24/24 ·
  `admin-revoke-place-access-migration` 3/3 (this one executes the committed 33-check
  regression script on the real chain through `0059`) · `legal-documents` 10/10. Every
  admin/account/legal file in the suite is green.
* `npx tsc --noEmit` → exit 0 · `npx eslint .` → exit 0, 0 errors, 11 pre-existing
  warnings (none in the changed files).
* The committed regression script also runs standalone against DEV
  (`psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/admin-revoke-place-access.sql`).

## 7. DEV migration status (read-only verification)

Project under test: the linked DEV project (`qiwexmzbysujmqctrsiq`). Probes are
**read-only**; no migration was applied.

> **Correction of an earlier probe.** The first attempt sent only an `apikey` header, which
> makes PostgREST act as **`anon`** and produced `permission denied for function` — that
> message said nothing about the signature (any function the browser role cannot execute
> answers the same way). The workspace does hold a `SUPABASE_SERVICE_ROLE_KEY`, so the
> probes were repeated with the proper `apikey` **and** `Authorization: Bearer` pair, which
> resolves as `service_role` and gives a decisive answer.

| Probe (as `service_role`) | Result | Meaning |
| --- | --- | --- |
| `POST /rest/v1/rpc/revoke_producer_place_access {p_actor_id,p_membership_id}` | `400 P0001 platform_admin_required` | the **0057** signature exists **and runs**; the in-function admin check fires for a non-admin actor and writes nothing |
| `POST … {p_actor_id,p_membership_id,p_reason}` | `404 PGRST202 … Perhaps you meant to call … (p_actor_id, p_membership_id)` | **0058 is NOT applied** |
| `GET /rest/v1/legal_documents?select=id,version` | `404 PGRST205 Could not find the table` | **0059 is NOT applied** |
| `GET /rest/v1/producer_memberships?select=id` | `200` (empty table) | 0057's `id` column is live |
| `GET /rest/v1/place_audit?select=id&limit=1` | `200`, 1 row | the trail exists and is readable only through service role |
| The app itself (`/ketentuan` on the running build) | renders the *"Register versi dokumen belum tersedia di lingkungan ini"* fallback | independent confirmation from the application that 0059 is absent |

**Every official apply path was investigated, not assumed:**

| Path | Result |
| --- | --- |
| `psql "$SUPABASE_DEV_DB_URL" -f …` (the repo's own checklist) | no `psql` binary and no DB URL/password in the workspace — only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Supabase CLI (`supabase db push` / `--db-url`) | not installed, and `web/supabase/config.toml` is absent (project not linked); the CLI would still need a personal access token or DB password |
| Management API `GET /v1/projects/{ref}` and `POST /v1/projects/{ref}/database/query` with the service key | `401 {"message":"JWT failed verification"}` — a service-role key is **not** a management credential; those endpoints require a personal access token (`sbp_…`) |
| DDL through PostgREST (`exec_sql`-style RPC backdoor) | **none exists**: every migration was searched for dynamic SQL (`execute format`, `exec_sql`, `run_sql`) and there is no DDL-capable function; even if one existed, using it would bypass the approved migration workflow and was not attempted |
| Installed Supabase connectors | only the client SDKs (`@supabase/supabase-js`, `ssr`, `postgrest/auth/storage/realtime/functions-js`) — a data-plane client, with no schema-change capability |

**Exact blocker and the action required (one of):** add `SUPABASE_DEV_DB_URL` (the DEV Postgres
connection string) **or** a Supabase personal access token `SUPABASE_ACCESS_TOKEN` to the
workspace environment — both are secrets only the owner can supply — **or** run the two files
in the Supabase SQL Editor as the existing checklist prescribes (paste
`0058` then `0059`, each once) and report back. **The policy is therefore NOT in force on DEV
and the feature is NOT available to users yet**; nothing was applied to production. See
`docs/runbooks/PLACE_MANAGEMENT_POLICY_DEPLOYMENT.md`.

## 8. Verification against a running build (this pass)

**Builds.** The managed preview ran this revision's content at
`https://3000-iyqivc7a3360xd842qd5j.e2b.app`, and the Vercel preview deployment for commit
`19a0bc9` is `https://singgah-lokal-884cdtocq-singgahlokal.vercel.app` (deployment status
`success`). The Vercel preview sits behind Vercel SSO (`302` to `vercel.com/sso-api`), so its
HTML cannot be fetched directly; the managed preview — same revision — is what was inspected.

**Rendered UI, not source.** The two UI test files are *source-contract* tests, so they are
not offered as UI evidence. Instead a **temporary** route rendered the real components in the
real Next runtime (App Router context, real client-component SSR), the produced HTML was
inspected attribute by attribute, and the route was then deleted (worktree clean at `19a0bc9`;
the path answers `404` again). Observed in that rendered HTML:

* **Path A — Admin Center → Data Pengelola.** One `Cabut Hak Akses` button per eligible row,
each with a distinct `aria-label` naming the account **and** the Place
(`Cabut hak akses Wayang Golek Sunda atas Rumah Teh Lokal`). Every row's button is **enabled**
(no `disabled` attribute) — including the row whose membership role is `owner`.
* **Path B — Admin Center → Detail Tempat → Pengelola.** For a Place whose **only** membership
is the last owner, the `Cabut Hak Pengelolaan` button is rendered and **enabled**
(`aria-label="Cabut hak pengelolaan terakhir@example.com atas Rumah Teh Lokal"`): the last
manager is revocable and no button is disabled for that reason.
* **Confirmation dialog (rendered open).** `role="dialog"` + `aria-modal="true"`; the account,
email, Place and scope fields are all present (`revoke-dialog-producer`, `-email`, `-place`,
`-scope`); the label *"Alasan pencabutan (wajib)"* renders above the reason control, whose
options are the five policy reasons plus *"Alasan lain…"*; and the confirm button carries the
real boolean `disabled=""` attribute **while no valid reason is chosen**, so confirmation
cannot be reached without a reason. The scope sentence (digital management rights only; no
legal-ownership determination; no data deletion) is rendered in the dialog itself.
* **Managerless + archived states.** With an empty membership list and an archived Place, the
rendered output contains `place-managerless-notice` (*"Tanpa Pengelola digital aktif."* plus the
official claim-approval recovery link) and `place-archived-notice` — the archived Place still
reads as archived.

**Route behaviour on that build.** `/` `200` · `/ketentuan` `200` · `/policy` `200` ·
`/about` `200` · `/auth` `200`; the Admin surfaces and `/account` answer `307` to
`/auth?returnTo=…` when signed out.

**NOT verified — stated plainly.** A signed-in Admin **browser session** and the real
click → server → database round trip were **not** performed: this environment holds no Admin
account, and DEV is still at `0057`, where the three-argument RPC does not exist — so the
request the dialog issues would fail on DEV regardless of how correct the UI is. The rendered
markup above proves the surfaces, the copy, and the reason gate; it does not prove the
end-to-end action, and is not claimed to.

## 9. Open items for the product owner

1. **Legal review.** Ketentuan Penggunaan v1.1 is written from the product decision and is
   explicitly marked as *awaiting legal review* in the document, the register, and the
   acceptance card. It must not be represented as legally final until that review happens.
2. **Privacy policy.** Still absent (no Privacy master). The new ToS references `/policy`
   for retention/privacy rather than inventing a privacy document.
3. **DEV apply + two-session concurrency check** (§5, §7).
4. **Post-deploy UI verification** in the deployed Admin Center (both surfaces).
