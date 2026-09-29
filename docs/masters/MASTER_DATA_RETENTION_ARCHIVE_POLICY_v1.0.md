# SINGGAH LOKAL — MASTER DATA RETENTION & CLAIM ARCHIVE POLICY v1.0

Status: **LOCKED** — policy master.
Date: 2026-09-29
Scope: retention and archival of Place claim records and claim evidence (attachments), the legal-dispute boundary for ownership claims, and the mandatory disclosure of this retention in the platform's public policies (Terms/Privacy/Policy). This document defines **reference policy only**; it authorizes no code, migration, or UI change by itself.

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
