# RUNBOOK — DEPLOY THE DIGITAL PLACE-MANAGEMENT POLICY (0058 + 0059)

Permanent policy: in-app roles grant **digital management permission only**; an authorized
Platform Admin can revoke a manager (including the **last** one) without appointing a
replacement; a Place may exist without an active digital manager. Audit:
`docs/audits/PLACE_MANAGEMENT_POLICY_AUDIT.md`.

**Current DEV status (verified read-only, 2026-10-15):** DEV is at **0057**. `0058` and
`0059` are **NOT applied** (`POST /rest/v1/rpc/revoke_producer_place_access` with
`p_reason` → `404 PGRST202`; `GET /rest/v1/legal_documents` → `404`). Nothing has been
applied to **production**.

---

## 0. Prerequisites

* The approved DEV connection: `SUPABASE_DEV_DB_URL` (SQL Editor paste or `psql "$SUPABASE_DEV_DB_URL"`).
* Confirm the project identity **before** applying anything (DEV project ref
  `qiwexmzbysujmqctrsiq`).
* Do this in a maintenance-friendly window: dropping the reason-less RPC overload briefly
  breaks any *old* app build that still calls the 2-argument form.

## 1. Order matters

`0058` **replaces** the RPC signature, so the old application build cannot revoke during
the window between "migration applied" and "new build live". Apply the migrations and
deploy the matching build together (§2 then §3), in that order.

## 2. Apply the migrations to DEV (never to production in this task)

```
psql "$SUPABASE_DEV_DB_URL" -f web/supabase/migrations/0058_place_management_policy_managerless.sql
psql "$SUPABASE_DEV_DB_URL" -f web/supabase/migrations/0059_legal_documents_acceptance.sql
```

Or paste each file into the Supabase SQL Editor and run it once. Both files are
forward-only and idempotent (safe to re-run); `0059` seeds Ketentuan Penggunaan v1.1.

**If you do not have the connection string:** this is the blocker recorded in the audit.
Everything else in this runbook can be completed after the credentials are supplied; do
not report the feature as operational on DEV until §4 passes.

## 3. Deploy the application

Deploy the branch/commit that carries the reason-aware RPC call, the shared dialog, the
managerless/archived UI, `/ketentuan`, and the acceptance flow. No feature flag is needed:
the UI reads `managerless`, `managerCount`, and `placePublicationStatus` from the server.

## 4. Verify on DEV (one result set, then manual checks)

### 4.1 Schema and policy

```
psql "$SUPABASE_DEV_DB_URL" -f web/tests/db-regression/admin-revoke-place-access.sql
```

Expect **33 rows, every `passed = true`** (the script rolls itself back; it leaves nothing
behind). It proves: the reason-less overload is gone, the reason is mandatory, the last
manager can be revoked, the managerless Place survives with its Producer pointer released,
the outcome is audited, and anon/authenticated still cannot reach the audit trail.

Then confirm the legal registry:

```
psql "$SUPABASE_DEV_DB_URL" -c "select id, title, version, requires_acceptance from public.legal_documents;"
```

Expect exactly `ketentuan-penggunaan | Ketentuan Penggunaan | 1.1 | t`.

### 4.2 Two-session concurrency check (the one thing tests cannot prove here)

PGlite in the test sandbox is single-connection, so parallel execution is **not** covered by
the suite. Reproduce it once on DEV with two sessions:

1. session A: `begin; select ... from public.producer_memberships where id = '<m1>' for update;`
2. session B: call `revoke_producer_place_access('<admin>', '<m2>', '<reason>')` for a
   **different** membership of the **same** Place — it must wait on the Place advisory lock.
3. commit A, then let B finish.
4. Assert the final state is consistent: the expected membership rows are gone, and
   `places.producer_id` is `NULL` **iff** zero memberships remain for that Place.

### 4.3 Manual UI check (deployed Admin Center)

1. `/admin/places/<id>` → **Pengelola**: revoke a **non-last** manager. Expect the server's
   success message, a refreshed list, and the Place's status unchanged.
2. Revoke the **last** manager. Expect **success** (not a refusal), the section then reading
   *"Tanpa Pengelola digital aktif"*, the Place still present, and its Riwayat showing a new
   *"Hak kelola Pengelola dicabut"* entry with actor, reason, and manager count.
3. Archive the Place (Moderasi → Arsipkan) and confirm the Pengelola section shows the
   archived notice.
4. `/admin/producer-membership` → **Cabut Hak Akses** on a relation, choosing a reason.
   Then confirm the Place appears under *"Tempat tanpa Pengelola digital aktif"* if it lost
   its last manager.
5. Signed out of any admin role: `POST /api/admin/producer-memberships/<id>/revoke` must
   answer **403**.
6. As the revoked account, sign in: the Place is gone from the Producer area (no cache),
   the notification is in the inbox, and no other Place of that account changed.

### 4.4 Legal surface

1. `/ketentuan` shows **"Versi 1.1"**, the effective date, the *awaiting legal review*
   notice, and the *"Kewenangan Pengelolaan Digital dan Pencabutan Akses"* section.
2. `/policy` shows the digital-management disclosure and links `/ketentuan`.
3. An account that has not accepted v1.1 sees the acceptance card on `/account`, can read
   the document, and after *"Saya menyetujui"* the card disappears (the row is in
   `legal_document_acceptances` and cannot be edited or deleted).
4. A new sign-up cannot submit without ticking the terms checkbox.

## 5. Rollback / forward-fix

* **No data was migrated and no table/column was dropped**, so there is nothing to undo
  data-wise. Rolling the application back alone is enough to stop the new UI.
* Rolling back to the *reason-less* RPC would require restoring a 2-argument function — do
  **not** re-create it; it would let revocations bypass the mandatory reason. If the new
  build must be withdrawn, keep `0058` applied and fix forward.
* `legal_document_acceptances` is append-only by design: accepted versions are evidence and
  are never rewritten.

## 6. Explicitly NOT part of this rollout

* Production apply (owner decision, separate authorisation).
* Publishing the Terms as "legally reviewed" — the document is marked *awaiting legal
  review* until that review is complete.
* Any Archive/Retention change (30-day claim archive, evidence handling, dispute boundary
  are untouched) and any change to claim, ownership-grant, or Live behaviour.
