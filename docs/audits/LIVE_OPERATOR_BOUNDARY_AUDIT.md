# AUDIT — BATAS OTORISASI PENGELOLA vs OPERATOR LIVE (least privilege)

Date: 2026-10-13
Branch: `fix/live-operator-least-privilege`
Base: `fix/live-moderation-audit-trail` (tip of the open stack #40 → #41 → #42 → #43;
#37/#38/#39 already merged into `main`)
Scope: the delegated Operator Live authority introduced by migrations
`0047`/`0048`/`0049` (and hardened by `0051`), the invitation lifecycle, the
Account Center surfaces, the Live operation paths, and every server boundary
that decides authority.

Sources read before writing: `AGENTS.md`,
`docs/masters/MASTER_INDEX_v1.0.md`,
`docs/masters/MASTER_AUTHORITY_STRUCTURE_v1.0.md`,
`docs/masters/MASTER_LIVE_POLICY_v1.0.md`,
`docs/HANDOFF_LIVE_MVP.md`, `docs/audits/LIVE_AUTH_AUDIT_v1.md`
(§5 peran–izin matrix), `docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md`,
`docs/UI_TERMINOLOGY_STANDARD.md`, and the current code on the base branch.

---

## 1. Reported symptom

An **Operator-only** account (an account whose only authority is a delegated
`live_operators` assignment) appeared to receive **Pengelola** (Producer)
access/display: a Pengelola entry point and the "Kelola Akses Live" panel.

The root cause was **not** known in advance; the hypotheses H1–H6 below were
each tested against code, SQL and (where possible) a real Postgres engine
(PGlite). No assumption was accepted without evidence.

## 2. Verdicts — H1 … H6

| # | Hypothesis | Verdict | Evidence |
| --- | --- | --- | --- |
| H1 | Accepting an invitation writes/upgrades `producer_memberships` | **REFUTED** (DB) | `accept_live_operator_invitation` (0048 §6.2, re-bodied in 0051 §2.2) writes **only** `public.live_operators` (revoke-previous + upsert) and the invitation's own `status`; it never inserts/updates `producer_memberships`. No trigger anywhere creates a membership from `live_operators`. `producer_memberships` has exactly one SELECT policy (`memberships_self_read`, 0001) and **no** client INSERT/UPDATE policy. Executable proof: `web/tests/live-operator-boundary.test.ts` ("accept creates no producer_memberships row / does not upgrade an existing one"). |
| H2 | Account components/helpers derive "Pengelola" from `live_operators` (or from a helper that includes delegated operators) | **CONFIRMED (UI/chrome only)** | The Account Center itself is clean (`app/account/page.tsx`: Pengelola ← `resolvePlaceMemberships()`, Operator Live ← `resolveLiveOperatorAssignments()`; `lib/account-memberships.ts` / `lib/account-live-operators.ts` query the two tables separately, both scoped to `auth.uid()`). **But** the destination of the Operator Live row (`/producer/live?place=…`) rendered the **Pengelola page identity** for an operator-only account: back link `← Pengelola` → `/producer`, `eyebrow="Pengelola Live"`, and the shared `ProducerSubNav` (`aria-label="Navigasi Pengelola"`, links to `/producer` Dashboard and `/producer/visit-intents`). The "Pengelola" presentation was therefore derived from the **operator assignment**, i.e. the exact failure mode H2 names — on the operator's own destination page, not on `/account`. |
| H3 | Management routes/RPCs (invite, list, cancel, revoke, replace) use a predicate that also admits delegated operators (e.g. `can_operate_live_for_place`) instead of owner/manager | **REFUTED** (server + DB) | `app/api/account/live-operators/invitations/route.ts` (POST/GET) → `isPlaceOwnerOrManager` + `invite_live_operator` / `list_place_live_operator_invitations` (both re-check owner/manager for the EXACT Place); `…/invitations/[id]/revoke` → `revoke_live_operator_invitation` (owner/manager check); `app/api/account/live-operators/route.ts` (GET/POST/DELETE) → inline `producer_memberships … in ('owner','manager')` + `list_place_live_operators` / `grant_live_operator_access` / `revoke_live_operator_access` (all owner/manager-gated); `lib/live/audit-read.ts` → `resolvePlaceManagerAuthority` (owner/manager only, delegated operators deliberately excluded). **No** management surface consults `can_operate_live_for_place` or `live_operators` for authority. Executable proof: `live-operator-boundary.test.ts` calls each real RPC as the operator and asserts refusal. |
| H4 | Listing endpoints leak another user's / another Place's invitations or assignments to an operator | **REFUTED** | Invitee list `list_my_live_operator_invitations` is `where invited_user_id = auth.uid()`; manager list `list_place_live_operator_invitations` requires owner/manager and filters by `p_place_id`; `GET /api/account/live-access` filters `.eq("user_id", …).is("revoked_at", null)`; RLS policies `live_operator_invitations_invitee_read` / `…_manager_read` and `live_operators_self_read` / `…_producer_read` restrict reads to self or the managing Place. Executable proof: `live-operator-boundary.test.ts` (cross-Place and cross-user RLS matrix on PGlite). |
| H5 | RLS/grant on `live_operators` / `live_operator_invitations` over-grants operators | **REFUTED** | Both tables: RLS on, `revoke all … from public, anon, authenticated`, `grant select … to authenticated` only; **no** INSERT/UPDATE/DELETE policy for any client; all writes go through `SECURITY DEFINER` RPCs with `search_path = public`. `can_operate_live_for_place` has **no** client EXECUTE. `anon` holds no grant and no EXECUTE on any lifecycle RPC. Executable proof: `live-operator-boundary.test.ts` + `web/tests/db-regression/live-operator-boundary-access.sql`. **No migration is required** (§5). |
| H6 | The "Kelola Akses Live" panel is decided by client data rather than a server decision | **REFUTED** (server decides) | `app/account/page.tsx` is a `force-dynamic` **server** component; `hasProducerAccess` is computed from `authority.memberships` (server-resolved owner/manager rows) and the panel is rendered on that server predicate. Its inner reads/writes go through server-gated endpoints (`/api/account/live-operators[/invitations]`) that re-derive authority on every call. No client role/ID decides it. Consequently the panel is **not** rendered for a true operator-only account. |

### Root cause (confirmed)

The delegated Operator Live surface **reuses the Pengelola Area**. The single
page an operator is routed to from the Account Center
(`/producer/live?place=…`) rendered the Pengelola identity and the Pengelola
navigation layer for operator-only accounts, and the two Pengelola destinations
that navigation offered (`/producer`, `/producer/visit-intents`) were gated on
**authentication only** (not on owner/manager membership). An operator-only
account therefore acquired a visible "entri Pengelola" and Pengelola
management destinations it has no authority to use.

For a **true** operator-only account the "Kelola Akses Live" panel itself is
**not** reproducible: it requires an owner/manager `producer_memberships` row
(H1 refuted, H6 refuted). If an account independently holds BOTH an
owner/manager membership and a delegated assignment, it legitimately keeps each
authority separately — see Policy Decision P2.

## 3. Authorization boundary that was affected

- **Affected:** the presentation/navigation layer around Live operation for a
  delegated operator, and the page-level server gate of the Pengelola routes
  `/producer` and `/producer/visit-intents` (auth-only instead of
  owner/manager).
- **Not affected (verified correct):** Live start/end authority
  (`requireLiveStartAuthority`, `can_operate_live_for_place`,
  `start_live_session`/`end_live_session`), the invitation lifecycle RPCs, the
  operator/assignment/invitation listing RPCs, RLS/grants on the operator
  tables, the producer resource routes (owner/manager-only), the Live audit
  reader, and the "Kelola Akses Live" manager surface.

## 4. Minimal fix

1. **`web/app/producer/live/page.tsx`** — the server decides the shell from a
   server-resolved fact:
   - account holds an owner/manager membership (`authorized.length > 0`) →
     existing Pengelola shell, **unchanged**;
   - account holds **only** delegated operator assignments → an Operator Live
     shell: back link `← Akun & Akses` → `/account`, eyebrow `Operator Live`,
     and **no** `ProducerSubNav`. The Live console (the operator's actual
     capability) is unchanged.
2. **`web/app/producer/page.tsx`** — deny-by-default server gate: an account
   with no owner/manager membership is redirected to `/account` **before** any
   roster/workspace renders (the "apply to become Pengelola" flow stays
   reachable through `/producer/onboarding`, which is linked from the auth pages
   and from the Account Center's empty state).
3. **`web/app/producer/visit-intents/page.tsx`** — the same owner/manager gate
   (the API already returned 403 with no data, so no capability is removed,
   only the exposed Pengelola shell).

No database change: the audit proves the RLS/grant/EXECUTE posture is already
least-privilege and correct (H5 refuted).

## 5. Migration status

**NOT REQUIRED.** The audit proves the database boundary is already correct:

- `live_operators` / `live_operator_invitations`: RLS enabled, no `anon`
  grant, `SELECT` only for `authenticated`, no client write policy;
- `can_operate_live_for_place`: internal only (no client `EXECUTE`);
- all lifecycle RPCs: `SECURITY DEFINER` with pinned `search_path`, owner/manager
  re-checked inside, `EXECUTE` to `authenticated` only;
- `assert_viewer_eligible` and `admit_live_viewer` are **unchanged** by this
  task (no Live gate touched).

Consequently **no migration number is consumed** (0057 stays free) and no DEV
apply is required or attempted. The verification is delivered as a runnable,
rollback-only result-set script
(`web/tests/db-regression/live-operator-boundary-access.sql`, columns
`ord, check_name, passed, detail`) referenced from
`docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md` §10.

## 6. Role × action matrix

Rows = the authority the caller actually holds (independently, per Policy
Decision P2). `P` = Pengelola (owner/manager), `O` = delegated Operator Live
for Place X, `P⊕O` = both independently, `U` = unrelated authenticated user,
`A` = anon.

| Action | P (own Place) | O (Place X) | P⊕O | U | A | Enforcement (server/DB) |
| --- | --- | --- | --- | --- | --- | --- |
| undang operator (invite) | allow (own) | deny | allow (as P) | deny | deny | `isPlaceOwnerOrManager` + `invite_live_operator` |
| daftar undangan Place | allow (own) | deny | allow (as P) | deny | deny | `list_place_live_operator_invitations` |
| daftar undangan sendiri | allow (own) | allow (own only) | allow | allow (own only) | deny | `list_my_live_operator_invitations` (auth.uid) |
| batalkan undangan | allow (own) | deny | allow (as P) | deny | deny | `cancel_live_operator_invitation` |
| cabut (revoke) operator | allow (own) | deny | allow (as P) | deny | deny | `revoke_live_operator_invitation` / `revoke_live_operator_access` |
| ganti (replace) operator | allow | deny | allow (as P) | deny | deny | accept-side replacement in `accept_live_operator_invitation` |
| daftar operator aktif Place | allow (own) | deny | allow (as P) | deny | deny | `list_place_live_operators` |
| accept/reject undangan sendiri | n/a (self-invite blocked) | allow (own) | allow | allow (own) | deny | invitee-only RPC + `email_confirmed_at` |
| start Live | allow (own) | allow (X only, gates) | allow | deny | deny | `requireLiveStartAuthority` + `start_live_session` |
| end Live | allow (own) | allow (X only) | allow | deny | deny | `canOperateLiveForPlace` + `end_live_session` |
| status Live | allow | allow (own session) | allow | viewer gate only | deny | RLS `live_sessions_live_operator_read` |
| kelola Place | allow (own) | **deny** | allow (as P) | deny | deny | producer resource routes (`requireProducerAccess`) + RLS |
| pengaturan produser/aktivitas | allow (own) | **deny** | allow (as P) | deny | deny | producer resource routes |
| kelola kunjungan | allow (own) | **deny** | allow (as P) | deny | deny | `visit_intents_producer_*` RLS + API membership gate |
| moderasi / suspend Live | deny | deny | deny | deny | deny | `platform_moderator` inside RPC |
| kelola kelayakan | deny | deny | deny | deny | deny | `platform_moderator` inside RPC |

## 7. Policy decisions recorded (new)

- **P1 — Delegated operators get an operator surface, not the Pengelola Area.**
  The Live console page is the operator's only destination; when the account
  holds no owner/manager membership it must render an Operator Live identity and
  must not offer Pengelola navigation. Deny-by-default server gates are added to
  `/producer` and `/producer/visit-intents`.
- **P2 — Dual-role accounts keep each authority independently.** An account that
  independently holds an owner/manager membership AND a delegated assignment
  retains both; neither is derived from the other. The Pengelola shell remains
  exactly as before for such accounts. (Aligns with Authority Master §6: only
  own-resource authority; and with the task rule "jangan menyimpulkan satu peran
  dari peran lain".)
- **P3 — No migration.** Forward-only least-privilege is already satisfied by
  0047–0051/0056; adding a migration would be a no-op and is therefore not
  shipped. `anon` receives no new grant; RLS stays enabled; 0046–0056 untouched.
- **P4 — Live gates untouched.** `assert_viewer_eligible`, `admit_live_viewer`,
  eligibility, moderation and the verified-email requirement (A-06) are
  unchanged. Age continues to be denied by the absent Phase-2.1 mechanism
  (`date_of_birth`/phone are not evidence).

## 8. Test plan

| # | Requirement | Test |
| --- | --- | --- |
| 1 | Accept grants Operator access exactly for the assigned Place | `live-operator-boundary.test.ts` + invitations migration suite |
| 2 | Accept never creates/upgrades `producer_memberships` (before/after) | `live-operator-boundary.test.ts` (PGlite) |
| 3 | Operator-only renders no Pengelola/manager controls | `live-operator-boundary.test.ts` (source contracts of `/producer/live`, `/producer`, `/producer/visit-intents`, `/account`) |
| 4 | Operator can operate Live on the assigned Place | invitations migration suite (`canOperate` semantics) |
| 5 | Operator cannot operate on a non-assigned Place | invitations migration suite + boundary test |
| 6 | Operator cannot invite/list/replace/assign/revoke others | boundary test drives the real RPCs |
| 7 | Direct API cannot bypass | source + endpoint contracts (`live-operator-invitations-endpoints`, `live-operator-management`) |
| 8 | Direct RPC cannot bypass | boundary test (PGlite, real RPC bodies) |
| 9 | Fake Place id / user id rejected | boundary test |
| 10 | RLS/grant/EXECUTE blocks cross-user & cross-Place (manager, operator, other-Place operator, unrelated, anon) | boundary test matrix + `db-regression/live-operator-boundary-access.sql` |
| 11 | Legit Pengelola still manages its Place and assignments | invitations migration suite + boundary test |
| 12 | Revoke blocks the next Live operation | invitations migration suite ("no cache") |
| 13 | Dual-role keeps each capability independently | boundary test |
| 14 | Eligibility/moderation/fail-closed viewer regressions stay green | existing Live suites (unchanged) |

## 9. Files and DB objects

**Changed**
- `web/app/producer/live/page.tsx` — role-aware shell.
- `web/app/producer/page.tsx` — owner/manager-only server gate.
- `web/app/producer/visit-intents/page.tsx` — owner/manager-only server gate.
- `web/tests/live-operator-boundary.test.ts` — new executable boundary tests.
- `web/tests/db-regression/live-operator-boundary-access.sql` — new result-set script.
- `web/tests/producer-navigation.test.ts` — amended (explicitly) for the two
  mutually-exclusive `/producer/live` back-link/nav states it previously locked.
- `docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md` — new §10 boundary check.
- `docs/audits/LIVE_OPERATOR_BOUNDARY_AUDIT.md` (this file), `docs/HANDOFF_LIVE_MVP.md`.

**DB objects changed: none.** No GRANT to `anon`, no RLS change, no function
body change, migrations 0046–0056 untouched, production untouched.

## 10. Limitations

- No DEV/production database action was taken (per the task: no apply without
  explicit authorization, production never touched). The DB proof runs on
  PGlite, not on the Supabase DEV project.
- No real authenticated browser round-trip is available in this sandbox, so the
  UI contract is locked by source-level tests over the real server components.
- Realtime, concurrency, device and provisioning tests are **NOT RUN** here.
