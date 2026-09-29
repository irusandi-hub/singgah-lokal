# SINGGAH LOKAL — MASTER DATA RETENTION & CLAIM ARCHIVE POLICY v1.0

Status: **LOCKED** — policy master.
Date: 2026-09-29
Revision: technical implementation annex (§16) added 2026-09-29 by PO decision — it documents the agreed archive/retention decisions and the actual implementation status; no LOCKED rule of §1–§15 is changed by it.
Scope: retention and archival of Place claim records and claim evidence (attachments), the legal-dispute boundary for ownership claims, the mandatory disclosure of this retention in the platform's public policies (Terms/Privacy/Policy), and the technical implementation annex for the claim archive (§16). This document defines **reference policy only**; it authorizes no code, migration, or UI change by itself.

Source hierarchy: `AGENTS.md` → `MASTER_INDEX_v1.0.md` → this master.
Any change to a rule in this document requires an explicit product decision and a **new master version** (§14).

---

## 1. Purpose of the archive

- The archive of Place claims and their evidence exists for **internal operational traceability** — the ability of the platform team to reconstruct what was submitted, reviewed, and decided.
- The archive is **not** a product feature, **not** user-facing content, and **not** a public record of ownership.
- Internal traceability is the ONLY purpose. Any new use of archived data beyond operational traceability requires a new master version (§14).

## 2. Claim archive retention: exactly 30 days

- The retention period for archived Place claims is **exactly 30 days** (30 × 24 hours) from the moment the archive is created. No grace period beyond the 30 days is part of this policy.
- The 30-day figure is **LOCKED**. Changing it requires a new master version (§14) — it may never be changed silently in code, configuration, or infrastructure settings.
- The archive period begins when the claim record enters the archived state (the claim's decision is final and its operational queue life has ended).

## 3. Evidence/attachment retention follows the same 30 days

- Claim evidence (proof-of-ownership attachments stored in the private `place-claim-evidence` storage bucket) follows the **same 30-day retention** as the archived claim it belongs to.
- Evidence is never retained longer than its archived claim record, and never shorter in a way that breaks traceability of the archive window itself: both are finalized together within the same 30-day lifecycle.

## 4. Archive is not normal history in the Admin Dashboard

- The archived claim/evidence **does not appear** as normal history anywhere in the Admin Dashboard — not in claim review queues, not in the Place workspace timeline, not in any operational list.
- An archived (retention-expired) claim is no longer part of the operational claim state a Place shows. The operational surfaces keep only the decision outcome they already carry; the archived detail is out of view.
- Rendering the archive as ordinary history in any surface would change this policy and requires a new master version (§14).

## 5. Archive is searchable by authorized Platform Admin/Moderator only

- Within the 30-day archive window, the archive may be **searched/inspected only by an authorized Platform Admin** (operational authority inside the app, per `MASTER_AUTHORITY_STRUCTURE_v1.0.md` §5), with authorization re-verified server-side on every access (fail closed).
- Producer, User, and the public have **no access** to the archive — including any Producer who was a party to the archived claim.
- Access to the archive must preserve the authority hierarchy: Platform Admin is an operational role granted/revoked by the Creator, it holds no infrastructure authority, and infrastructure credentials/secrets are never delivered through the application (`MASTER_AUTHORITY_STRUCTURE_v1.0.md` §2–§5).
- Any access beyond authorized Platform Admin search requires a new master version (§14).

## 6. Evidence is private; access is authorized and short-lived

- Claim evidence is **private**: it is stored in a private storage bucket and is never exposed through a public or guessable URL.
- Every access to evidence is mediated by an **authorized, short-lived mechanism** — a signed URL minted server-side, only for a verified Platform Admin session, and expiring after a short bounded time. There is no permanent evidence link, no listing of bucket contents, and no client-side construction of evidence URLs.
- Short-lived evidence access outlives nothing: it is bounded by the same 30-day retention — after the retention window ends, no new signed URL can be minted because the evidence no longer exists (§7).

## 7. Cleanup: storage first, database finalization only on storage success

The deletion order is LOCKED:

1. **Storage deletion first.** The evidence object(s) in the private storage bucket are deleted first.
2. **If storage deletion FAILS → the DB archive record MUST NOT be deleted.** The claim archive row stays in place (still inside or beyond retention, unchanged) and the cleanup is retried. A DB archive row whose evidence still exists would create a dangling private object; a missing DB row with a live private object would create an untraceable orphan. Both are forbidden — the safe state on failure is "keep both, retry."
3. **If storage deletion SUCCEEDS → the archived/expired claim may be finalized.** Only then may the DB archive record (or the expired claim record) be finalized/deleted.

- Cleanup is an idempotent operation that may be submitted repeatedly (a scheduled job or a manual run) without double-deleting or double-finalizing: each attempt re-checks the actual state of storage and the archive before acting.
- The canonical database remains the source of truth for what has been finalized; no cache or search index may substitute for it.
- The cleanup order guarantees at every moment: no private evidence object outlives its DB archive record's traceability, and no DB archive record is finalized while its evidence still exists.

## 8. No guarantee of permanent preservation after retention ends

- After the 30-day retention ends and cleanup has run, the platform **does not guarantee permanent preservation** of the claim record or its evidence.
- Once finalized, the data is gone by design. The platform makes no promise — legal, contractual, or factual — of indefinite retention, and no surface may claim otherwise.
- Backup/recovery scope for archived claim data after finalization is the Creator's infrastructure domain (`MASTER_AUTHORITY_STRUCTURE_v1.0.md` §2), and even there the archived claim data is not promised to persist.

## 9. Claim approval is application-level state, not a legal ownership decision

- Approving a Place claim grants **in-application ownership** of the Place resource (membership/management authority inside SINGGAH LOKAL). It is an application-level state change.
- It is **NOT** a legal determination of real-world ownership, title, lease, or any property right over the Place.
- No surface (Producer, User, Admin, or public) may present claim approval as a legal proof of ownership.

## 10. Ownership/legal disputes are resolved between the parties

- Disputes over real-world ownership or legal claims to a Place are a matter of **proof between the parties involved** (the claimant, the contested owner, and the competent legal process they choose).
- The platform is not an arbiter of such disputes and does not produce legal findings; the platform's role is limited to keeping its own application-level state consistent while a dispute is carried outside it.

## 11. No ownership revocation/transfer based on a unilateral claim

- The platform application **must never revoke or transfer** a Place's ownership/membership based on a **unilateral claim** of one party alone.
- In-app ownership changes come only through the platform's own claim review process (with evidence review) or an explicit product decision. A demand letter, an email, a report, or any single-sided assertion is never sufficient on its own to change in-app ownership.

## 12. Actions requiring legal determination must follow competent authority in the Place's jurisdiction

- When an action against a Place (revocation, transfer, takedown beyond normal moderation) requires a **legal determination**, it must be based on a **decision or order from a competent authority in the jurisdiction of the Place** (court order, government authority decision, or equivalent official instrument).
- Competence follows the Place's own jurisdiction — the same principle as "currency follows Place" and "Place timezone is the source of truth": the Place's geography determines which authority is competent, not the platform's home country.
- Platform Admin enforces such an outcome only after verification of the authority's decision; it does not substitute its own judgment for a legal determination.

## 13. Retention clause is mandatory in Terms/Privacy/Policy

- The 30-day retention of claim archives and evidence, the private/short-lived access nature of evidence, and the legal-dispute boundary (§9–§12) **must be disclosed** as part of the platform's public Terms, Privacy, and Policy documents.
- The public policy wording must state plainly that claim archives and evidence are kept for 30 days for internal operational traceability, that they are not permanent records, and that claim approval is not a legal ownership determination.
- Until the public policy texts carry this clause, the platform must treat the disclosure as an open compliance gap — the implementation of retention/cleanup may not ship while users are not informed of it.

## 14. Change control: new master version required

- Any change to the **30-day retention period**, the **evidence handling rules**, or the **legal-dispute boundary** (§9–§12) requires a **new version of this master** (e.g. v1.1) and an explicit product decision.
- The change-control requirement is itself LOCKED: these three areas may never be changed by editing code, configuration, or infrastructure without a new master version.
- This master is indexed as an official Master in `MASTER_INDEX_v1.0.md` and enters the source hierarchy (`AGENTS.md` → `MASTER_INDEX_v1.0.md` → this master).

---

## 15. Locked summary

| # | Rule | Value |
| --- | --- | --- |
| 1 | Archive purpose | Internal operational traceability ONLY |
| 2 | Claim archive retention | Exactly 30 days |
| 3 | Evidence retention | Same 30 days as its claim |
| 4 | Admin Dashboard | Archive is NOT normal history; hidden from operational surfaces |
| 5 | Archive search access | Authorized Platform Admin/Moderator only, server-side re-verified, fail closed |
| 6 | Evidence access | Private bucket; authorized, short-lived signed URLs only |
| 7 | Cleanup order | Storage deleted first; storage failure ⇒ DB archive NOT deleted (retry); storage success ⇒ finalize archive |
| 8 | Preservation | No guarantee of permanent preservation after retention ends |
| 9 | Claim approval | Application-level state, not a legal ownership decision |
| 10 | Ownership disputes | Proof between the parties; platform does not adjudicate |
| 11 | Unilateral claim | Never revokes/transfers in-app ownership by itself |
| 12 | Legal determination | Competent authority in the Place's jurisdiction only |
| 13 | Public policy | Retention clause mandatory in Terms/Privacy/Policy |
| 14 | Change control | New master version for retention/evidence/legal-boundary changes |
| 16 | Technical annex | Claim archive design of record; implementation status audited per §16.7 |

---

## 16. Technical implementation annex — claim archive (design of record)

This annex records the agreed archive decisions as TECHNICAL design, bound to
the LOCKED policy of §1–§15. It does not relax any rule: the 30-day retention,
the storage-first cleanup order, and the legal-dispute boundary above stay
exactly as locked. Where the implementation is not yet built, the annex says so
instead of describing fiction.

### 16.1 Claim archive

- Claim **history is not displayed in the Admin Dashboard**: the operational
  surfaces (the claim review queue on `/admin/places`, the Place workspace's
  claim timeline) keep showing only pending/decided claims from the canonical
  `place_claims` table, and the archive adds nothing to them.
- Decided claim records (approved/rejected) are kept as an **internal archive
  for operational/audit needs**, separate from the operational queue state.
- The archive is **internally searchable** by: **Place ID**, **Pengelola ID**,
  **account email** of the claimant, and related identifiers (claim id, review
  timestamps). Search is an internal Platform Admin capability (§5) — never a
  public or Producer-facing feature.
- The archive includes **claim metadata** (claimant, Place, status, decision,
  timestamps, review note) **and the claim evidence/attachment reference**
  (evidence path, file name, mime type, size) for the full archive window.

### 16.2 Retention

- The archive retention is **30 days** (§2, LOCKED). After 30 days from
  archiving, the archived claim record and its evidence object(s) **must be
  removed** through the cleanup mechanism of §16.5.
- **No permanent retention** that burdens the database or storage may be
  created: no unbounded archive table growth by design (each row carries its
  archived-at timestamp and leaves the system at day 30), and no evidence
  object outlives its archive window.

### 16.3 Evidence / attachment

- Evidence stays **private** (the `place-claim-evidence` bucket of migration
  0028 is private, RLS-locked, and service-role-only) and **is never public
  data**.
- Evidence objects are deleted **through the proper Storage mechanism** — the
  Supabase Storage object API used by the server (`removePlaceClaimEvidence`
  in `web/lib/place-claim-storage.ts`, service-role client) — **never by
  manipulating internal Storage metadata tables directly**.
- **If a Storage deletion fails, the DB archive record is NOT finalized as
  deleted**; the pair stays intact (archive row + evidence object) and the
  cleanup must be **re-processable** — the same attempt can be repeated safely
  until storage deletion succeeds, after which the DB finalization proceeds
  (§7 order, LOCKED).

### 16.4 Legal / ownership boundary (consistent with §9–§12)

- The system retains claim evidence **only while the archive is available
  within the retention window**. After retention ends and cleanup has run, the
  application **does not guarantee** the internal evidence.
- Claim approval by the application is **not a legal ownership determination**
  (§9).
- In any later dispute or legal request, the application **does not decide
  which party is right and is not the party of proof** (§10); claim evidence is
  operational traceability material, not a legal record of title.
- Release or change of a claim/ownership because of a legal dispute happens
  **only on the basis of a binding legal decision effective in the Place's
  region** (§12).

### 16.5 Technical cleanup (design of record)

| Aspect | Design |
| --- | --- |
| Cleanup worker | A server-side job (service-role, `requirePlatformModerator`-gated for any manual trigger; no client call path) that sweeps the archive for expired rows and executes the §7 order |
| Scheduler | A daily schedule invokes the worker; nothing else schedules or triggers cleanup — no client-facing button ships as the primary path |
| Authentication/secret | The worker authenticates as the **service role** inside the server runtime; service-role credentials are server-side only and never delivered through the application (`MASTER_AUTHORITY_STRUCTURE_v1.0.md` §3). Any manual trigger route requires a live Platform Moderator session — no shared static secret is minted for it |
| Idempotency | Every run re-checks the actual state (archive row still expired? evidence object still present?) before acting; re-running never double-deletes or double-finalizes, and a repeated submission of the same cleanup is safe |
| Retry on storage failure | Storage deletion failure keeps the DB archive untouched and the row eligible for the next run (§7.2); attempts are retried by the schedule, not by blocking anything else |
| Deletion order | Storage → DB finalization, LOCKED by §7: storage first; on failure keep both and retry; on success finalize the DB archive row |
| Result/status | Each attempt resolves to exactly one outcome: `removed` (storage + DB finalized), `retry_scheduled` (storage deletion failed), or `noop` (nothing expired). The outcome is observable in the worker's run logs; the canonical finalization state lives in the database, never in a cache or search index |
| Manual verification | A Platform Admin can verify a run by (1) checking the archive row count for expired rows, (2) confirming the evidence object is gone from the private bucket, and (3) reading the worker outcome in the run logs. Supabase Storage dashboard object listing is the ground truth for the storage side |
| Implementation source | The archive schema/function migration, the cleanup worker, and the scheduler wiring are the implementation source of truth once they exist; until then the substrate is `web/supabase/migrations/0028_place_claims.sql` and `web/lib/place-claim-storage.ts` (§16.7) |

### 16.6 Policy coupling

- These technical notes do not stand alone: §13 requires the 30-day retention,
  the private/short-lived evidence nature, and the §9–§12 legal boundary to be
  carried into the public **Terms/Privacy/Policy**, and this annex is bound to
  the same wording. The technical documentation and the public policy texts
  must stay consistent — a change to one without the other is a violation of
  this master.
- Until the public policy surfaces exist in the app, the §13 disclosure gap
  stands and blocks shipping the retention/cleanup implementation.

### 16.7 Implementation status (audited on `main`, 2026-09-29)

Audited honestly against the repository — **not** invented:

| Component | Status |
| --- | --- |
| Claim submission, review, evidence upload/signed read | **EXISTS** — `web/supabase/migrations/0028_place_claims.sql` (fail-closed RLS, private bucket, one-active-claim gate), `web/lib/place-claim-storage.ts` (private bucket writes, 300-second signed URLs, `removePlaceClaimEvidence` via the Storage object API), `web/app/api/admin/place-claims/*`, `web/app/api/producer/place-claims/*` |
| Claim archive schema/function (migration) | **NOT YET BUILT** — no archive migration exists in `web/supabase/migrations/` (latest is 0033) |
| Archive search (internal, Admin-only) | **NOT YET BUILT** |
| Cleanup worker | **NOT YET BUILT** |
| Scheduler wiring | **NOT YET BUILT** |
| Terms/Privacy/Policy disclosure surfaces | **NOT YET BUILT** — no policy pages exist in the app; the §13 gap stands |

The annex above is the **design of record** the implementation must follow.
Building any of the missing components is future work under this master and
requires no re-litigation of these rules — only the master change-control rule
of §14 applies when the design itself changes.
