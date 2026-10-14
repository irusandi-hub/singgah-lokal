# Live Migration — DEVELOPMENT Apply Checklist

Scope: applying the Live migrations (`0008_live_sessions.sql`, then
`0047_account_center_live_operator.sql`, `0048_live_operator_invitations.sql`,
`0049_live_operator_authority.sql`, then `0050_profile_phone_verification.sql`)
to the **Supabase DEVELOPMENT project only**.
Never run any step of this checklist against production. No Cloudflare configuration is part of this checklist (B4 stays a separate, explicit step).

Sections §0–§4 cover `0008`. §5–§6 cover the delegated Operator Live migrations
`0047` → `0048` → `0049` in that mandatory order (`0048` depends on `0047`; `0049`
reads `public.live_operators`), and the runnable access script that proves the
result on the DEV project. §7 covers `0050_profile_phone_verification.sql` (the
profile + phone OTP foundation), which depends on `0047` only. §8 covers
`0051_live_auth_integrity.sql` (cleanup-RPC lockdown A-03 + verified-email gate
A-06), which depends on `0048` and `0050`. §9 is the manual sign-up / email
confirmation verification (S-01/S-02), which needs the DEV project and its email
template and therefore cannot run in the test suite.

## 0. Preconditions

- [ ] Target confirmed: Supabase **DEVELOPMENT** project (check the project ref in the dashboard before opening the SQL editor; migrations are irreversible in place).
- [ ] `git pull` on `main` — migrate the committed `0008_live_sessions.sql`, never a local edit.
- [ ] Migrations 0001–0007 already applied on the target (0008 depends on `users`, `producers`, `places`, `production_stages`, `producer_memberships`, `pgcrypto`).
- [ ] No existing `live_*` tables on the target (first apply). If a partial apply happened, stop and reconcile by hand — do not re-run blindly.

## 1. Pre-apply checks (read-only)

```sql
-- 0008 objects must not exist yet on a clean target:
select to_regclass('public.live_sessions');            -- expect null
select to_regproc('public.start_live_session');        -- expect null
select count(*) from pg_publication_tables
 where pubname = 'supabase_realtime'
   and tablename in ('live_sessions', 'live_reports'); -- expect 0
```

- [ ] `production_stages_id_place_id_key` does not exist yet (0008 adds it; `drop constraint if exists` tolerates both, but know the current state).
- [ ] Supabase Realtime publication `supabase_realtime` exists (default on every project).

## 2. Apply

- [ ] Paste the full contents of `web/supabase/migrations/0008_live_sessions.sql` into the SQL Editor (or `psql "$SUPABASE_DEV_DB_URL" -f ...`) and run once.
- [ ] Confirm success — no partial-commit errors. If anything fails: stop, capture the error, fix the migration file in the repo, and re-plan. **Do not** patch the database by hand.

## 3. Post-apply verification

```sql
select to_regclass('public.live_sessions');     -- not null
select to_regclass('public.live_eligibility');  -- not null
select to_regclass('public.live_viewers');      -- not null
select to_regclass('public.live_reports');      -- not null
select to_regclass('public.live_audit');        -- not null
```

- [ ] All five Live tables exist.
- [ ] `platform_role_check` exists on `public.users`; no user has `platform_role` set yet (B2 residue).
- [ ] RLS enabled on all five tables; `live_sessions` readable by `authenticated` (policy `live_sessions_public_read`); `live_audit` **not** readable by `anon`/`authenticated`.
- [ ] `supabase_realtime` publication includes `live_sessions` and `live_reports`.
- [ ] Execute grants: `authenticated` holds EXECUTE on the Live RPCs; `public`/`anon` do not.

## 4. Regression suite (development only)

- [ ] Run `web/tests/db-regression/live-regression.sql` on the same DEVELOPMENT target. The file is wrapped in a single transaction and **rolls everything back** — it leaves no data behind and ends with `rollback;`.
- [ ] Expected output ends with `LIVE REGRESSION SUITE: ALL CHECKS PASSED` and one `PASS` line per check (producer authorization, eligibility, start/end + idempotency, caps, B1 fail-closed admission, moderation, stage auto-end, RLS/privilege baseline).
- [ ] Any `REGRESSION_FAIL` — stop, fix the migration in the repo, re-apply on a fresh target. Do not "fix forward" in the database.

## 5. Delegated Operator Live access — apply 0047, 0048, 0049 (DEV)

Applies to `web/supabase/migrations/0047_account_center_live_operator.sql`,
`0048_live_operator_invitations.sql`, `0049_live_operator_authority.sql`. All
three are forward-only and idempotent; each is pasted as a WHOLE FILE in one run
(the SQL Editor wraps each file in `begin … commit`).

- [ ] Target re-confirmed: the Supabase **DEVELOPMENT** project ref (never
  production).
- [ ] `git pull` on the feature branch so the committed files are applied, never
  a local edit.
- [ ] Migration `0047_account_center_live_operator.sql` reported as applied
  (`select to_regclass('public.live_operators')` is not null). If it is NOT
  applied yet, apply it first — `0048` and `0049` both depend on it.

### 5.1 Pre-apply checks (read-only, run first)

```sql
-- 0047 must already exist:
select to_regclass('public.live_operators');              -- expect not null
-- 0048 / 0049 objects must not exist yet:
select to_regclass('public.live_operator_invitations');   -- expect null
select to_regproc('public.can_operate_live_for_place');   -- expect null
select to_regproc('public.invite_live_operator');         -- expect null
-- Existing delegated assignments that would violate the new 'max ONE ACTIVE
-- operator per Place' index. MUST return no rows; if it returns rows, revoke the
-- extras deliberately (through the app / 0047 RPC) BEFORE applying 0048:
select place_id, count(*) as active_operators
from public.live_operators
where revoked_at is null
group by place_id
having count(*) > 1;
```

### 5.2 Apply 0048

- [ ] Paste the full contents of `0048_live_operator_invitations.sql` and run it
  once. Expect success with no partial-commit errors.
- [ ] Confirm the objects exist:

```sql
select to_regclass('public.live_operator_invitations');        -- not null
select to_regproc('public.invite_live_operator');              -- not null
select to_regproc('public.accept_live_operator_invitation');   -- not null
select to_regproc('public.revoke_live_operator_invitation');   -- not null
select indexname from pg_indexes
 where tablename in ('live_operators', 'live_operator_invitations')
 order by indexname;
-- expect: live_operator_invitations_active_unique_idx,
--         live_operator_invitations_pending_unique_idx,
--         live_operators_one_active_per_place_idx
```

### 5.3 Apply 0049 (closes the operator start/end gap)

- [ ] Paste the full contents of `0049_live_operator_authority.sql` and run it
  once. Expect success. (Re-running the whole file is a no-op — the accessibility
  test proves it.)
- [ ] Confirm the predicate and the privilege posture:

```sql
select to_regproc('public.can_operate_live_for_place');  -- not null
-- The predicate must be internal: no client may call it.
select has_function_privilege('authenticated',
  'public.can_operate_live_for_place(uuid,text)', 'EXECUTE');  -- expect false
select has_function_privilege('anon',
  'public.can_operate_live_for_place(uuid,text)', 'EXECUTE');  -- expect false
-- anon must hold no EXECUTE on either Live RPC; authenticated must.
select has_function_privilege('anon',
  'public.start_live_session(text,text,text,text)', 'EXECUTE');  -- expect false
select has_function_privilege('anon',
  'public.end_live_session(text,text,text,text)', 'EXECUTE');    -- expect false
select has_function_privilege('authenticated',
  'public.start_live_session(text,text,text,text)', 'EXECUTE');  -- expect true
select has_function_privilege('authenticated',
  'public.end_live_session(text,text,text,text)', 'EXECUTE');    -- expect true
```

## 6. Operator access verification on DEV

- [ ] Run `web/tests/db-regression/live-operator-invitations-access.sql` on the
  same DEVELOPMENT target (SQL Editor paste, or
  `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-operator-invitations-access.sql`).
- [ ] The file is one transaction ending in `rollback;` — it creates its own
  fixtures, switches role to `authenticated`/`anon` per check, and **leaves no
  data behind**.
- [ ] Expected output: one `LIVE-OPERATOR-ACCESS PASS` line per check
  (`manager_still_works`, `operator_can_operate`, `revoke_denies_next_call`,
  `cross_place_denied`, `others_denied`, `anon_locked_out`) ending with
  `LIVE OPERATOR ACCESS: ALL CHECKS PASSED`.
- [ ] Any `LIVE-OPERATOR-ACCESS FAIL` or a raised
  `LIVE OPERATOR ACCESS CHECK FAILED` — stop. Fix the migration in the repo and
  re-apply on a fresh target. Do not "fix forward" in the database.

The same rules are covered automatically in the normal suite by
`web/tests/live-operator-authority-migration.test.ts` (which also executes this
access script on a real Postgres engine).

## 7. Profile, phone OTP and verification foundation — apply 0050 (DEV)

Applies to `web/supabase/migrations/0050_profile_phone_verification.sql`.
Forward-only and idempotent; paste the WHOLE FILE in one run. It depends on
`0047` (the self-update RLS policy and the username rules it reuses) and on
nothing from `0048`/`0049` — it never reads `live_operators` or
`live_operator_invitations`. Migration `0046` is untouched.

- [ ] Target re-confirmed: the Supabase **DEVELOPMENT** project ref (never
  production).
- [ ] `git pull` on the feature branch so the committed file is applied, never a
  local edit.
- [ ] `0047` reported as applied (`select to_regclass('public.live_operators')`
  is not null).

### 7.1 Pre-apply checks (read-only, run first)

```sql
-- 0050 objects must not exist yet:
select column_name from information_schema.columns
 where table_schema='public' and table_name='users'
   and column_name in ('full_name','date_of_birth','phone_e164','phone_verified_at','avatar_path');
-- expect 0 rows
select to_regclass('public.phone_otp_challenges');                 -- expect null
select to_regproc('public.record_phone_otp_verification');         -- expect null
select to_regclass('storage.buckets');  -- must exist (Supabase Storage)
```

### 7.2 Apply 0050

- [ ] Paste the full contents of `0050_profile_phone_verification.sql` and run it
  once. Expect success with no partial-commit errors.
- [ ] Confirm the shape:

```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='users'
   and column_name in ('full_name','date_of_birth','phone_e164','phone_verified_at','avatar_path')
 order by 1;   -- expect the 5 columns
select conname from pg_constraint
 where conrelid='public.users'::regclass
   and conname in ('full_name_length','phone_e164_format','phone_verified_requires_number','avatar_path_format');
select indexdef from pg_indexes
 where tablename='users' and indexname='users_phone_verified_unique_idx';  -- partial, verified only
select rowsecurity from pg_tables
 where schemaname='public' and tablename='phone_otp_challenges';           -- expect true
select count(*) from pg_policies
 where schemaname='public' and tablename='phone_otp_challenges';           -- expect 0
select id, public from storage.buckets where id='account-avatars';         -- expect public = false
```

- [ ] Confirm the privilege posture (a client can never write the verification
  column, and the RPC is authenticated-only):

```sql
select has_column_privilege('authenticated','public.users','phone_verified_at','UPDATE');  -- false
select has_column_privilege('authenticated','public.users','phone_e164','UPDATE');         -- true
select has_function_privilege('anon',
  'public.record_phone_otp_verification(uuid,text)','EXECUTE');                            -- false
select has_function_privilege('authenticated',
  'public.record_phone_otp_verification(uuid,text)','EXECUTE');                            -- true
select has_table_privilege('authenticated','public.phone_otp_challenges','SELECT');        -- false
```

### 7.3 Access verification on DEV

- [ ] Run `web/tests/db-regression/profile-phone-otp-access.sql` on the same
  DEVELOPMENT target (SQL Editor paste, or
  `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/profile-phone-otp-access.sql`).
- [ ] The file is one transaction ending in `rollback;` — it creates its own
  fixtures, switches role to `authenticated`/`anon` per check, and **leaves no
  data behind**.
- [ ] Expected output: one `PROFILE-OTP-ACCESS PASS` line per check
  (`profile_self_update`, `foreign_profile_blocked`,
  `verification_column_locked`, `otp_verify_happy_path`,
  `otp_wrong_and_bounded`, `number_change_resets`,
  `taken_number_answers_uniformly`, `anon_locked_out`) ending with
  `PROFILE OTP ACCESS: ALL CHECKS PASSED`.
- [ ] Any `PROFILE-OTP-ACCESS FAIL` or a raised `PROFILE OTP ACCESS CHECK FAILED`
  — stop. Fix the migration in the repo and re-apply on a fresh target. Do not
  "fix forward" in the database.
- [ ] The OTP SEND path cannot be verified on DEV until a provider is wired
  (blocker **B5**) and `PHONE_OTP_HASH_SECRET` is set (blocker **B6**): with no
  provider the endpoint answers `phone_otp_provider_not_configured` (503) and
  creates no challenge. The verification RPC itself IS covered by the script
  above, which creates challenges directly as the service role.

The same rules are covered automatically in the normal suite by
`web/tests/account-profile-phone-migration.test.ts` (which also executes this
access script on a real Postgres engine).

## 8. Live auth integrity — apply 0051 (DEV)

Applies to `web/supabase/migrations/0051_live_auth_integrity.sql`. Forward-only
and idempotent; paste the WHOLE FILE in one run. It depends on `0048` (the
invitation RPC it replaces) and on `0050` (it is numbered after the last applied
migration). It changes **no** table and deletes no data: it replaces two function
bodies and the EXECUTE posture of two cleanup RPCs.

- [ ] Target re-confirmed: the Supabase **DEVELOPMENT** project ref (never
  production).
- [ ] `git pull` on the branch so the committed file is applied, never a local
  edit.
- [ ] `0048` and `0050` reported as applied
  (`select to_regclass('public.live_operator_invitations')` and
  `select to_regproc('public.record_phone_otp_verification')` are not null).

### 8.1 Pre-apply checks (read-only, run first)

```sql
-- The cleanup RPCs of 0008/0013 and the 0049 predicate must already exist:
select to_regproc('public.release_live_input');            -- expect not null
select to_regproc('public.list_ended_live_inputs');        -- expect not null
select to_regproc('public.can_operate_live_for_place');    -- expect not null
select to_regproc('public.accept_live_operator_invitation'); -- expect not null
-- Sanity: who currently holds EXECUTE on the cleanup RPCs (0049-era: any
-- signed-in account). This is the state A-03 removes.
select has_function_privilege('authenticated',
  'public.release_live_input(text)', 'EXECUTE');            -- expect true BEFORE apply
```

### 8.2 Apply 0051

- [ ] Paste the full contents of `0051_live_auth_integrity.sql` and run it once.
  Expect success with no partial-commit errors.
- [ ] Confirm the privilege posture **after** apply:

```sql
-- A-03: provider cleanup is server infrastructure → service_role only.
select has_function_privilege('anon',
  'public.release_live_input(text)', 'EXECUTE');             -- expect false
select has_function_privilege('authenticated',
  'public.release_live_input(text)', 'EXECUTE');             -- expect false
select has_function_privilege('anon',
  'public.list_ended_live_inputs()', 'EXECUTE');             -- expect false
select has_function_privilege('authenticated',
  'public.list_ended_live_inputs()', 'EXECUTE');             -- expect false
select has_function_privilege('service_role',
  'public.release_live_input(text)', 'EXECUTE');             -- expect true
select has_function_privilege('service_role',
  'public.list_ended_live_inputs()', 'EXECUTE');             -- expect true
-- A-06: the authority predicate stays internal, and the accept RPC stays
-- authenticated-only (its ACL is inherited from 0048 — 0051 grants nothing).
select has_function_privilege('authenticated',
  'public.can_operate_live_for_place(uuid,text)', 'EXECUTE'); -- expect false
select has_function_privilege('anon',
  'public.accept_live_operator_invitation(uuid)', 'EXECUTE'); -- expect false
select has_function_privilege('authenticated',
  'public.accept_live_operator_invitation(uuid)', 'EXECUTE'); -- expect true
-- The viewer gate must be untouched by this migration:
select to_regproc('public.assert_viewer_eligible');           -- expect not null
select to_regproc('public.admit_live_viewer');                -- expect not null
```

### 8.3 Access verification on DEV

- [ ] Run `web/tests/db-regression/live-cleanup-rpc-access.sql` on the same
  DEVELOPMENT target (SQL Editor paste, or
  `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/live-cleanup-rpc-access.sql`).
  One transaction, ends with `rollback;`, leaves no data behind. The file emits a
  **result set** of `(check_name, passed, detail)` — every row must read
  `passed = true` (the A-03 posture, and that the legitimate server path still
  works through the service role).
- [ ] Run `web/tests/db-regression/live-operator-email-verification-access.sql`
  the same way. Same result-set contract: every row `passed = true`. It covers
  the A-06 gate (an unconfirmed invitee cannot accept; an unconfirmed active
  operator cannot start; after confirming, both succeed; a revoke denies the very
  next start) **and** the recorded policy decision that an owner/manager WITHOUT
  a confirmed email still starts Live.
- [ ] Any `passed = false` — stop. Fix the migration in the repo and re-apply on a
  fresh target. Do not "fix forward" in the database.
- [ ] The same rules are covered automatically in the normal suite by
  `web/tests/live-operator-email-verification.test.ts` (which executes the second
  script on a real Postgres engine).

## 9. Sign-up and email confirmation — manual DEV verification (S-01/S-02)

**Status: NOT-RUN.** Nothing in this section can be executed by the test suite:
it needs the DEV project's Auth service and its confirmation email template.
Do not describe A-01 (the confirmation link landing on the code-exchange
handler) as verified operational until every box below is ticked on DEV.

The automatable half is already covered and green:

- `web/tests/auth-sign-up-flow.test.ts` — the route's validation, the
  `role`/`producer_id` refusal, the `emailRedirectTo` destination and the
  callback's open-redirect guard.
- `web/tests/auth-sign-up-db.test.ts` — on a real Postgres engine: the
  `auth.users` → `public.users` mirror (exactly one row), hostile sign-up
  metadata granting nothing, a failed profile sync leaving NOTHING behind (and
  the same email succeeding on retry), a duplicate email being refused, and a
  client being unable to insert its own profile row.

### 9.1 Confirmation email template (S-02)

- [ ] Supabase Dashboard → Authentication → **Email Templates** →
  "Confirm signup".
- [ ] The template must contain the confirmation link. Record which form it
  uses, in the box below:
  - [ ] `{{ .ConfirmationURL }}` — the standard form. Supabase appends the
    `redirect_to` the app sent (`/auth/callback?next=/auth`), so the click lands
    on the code-exchange handler.
  - [ ] Custom URL — it must still point at
    `{{ .SiteURL }}/auth/callback?next=/auth` and still carry the
    `token_hash`/`code`. A link to the site root or to `/auth` alone is a
    FAILURE: `/auth` never reads `code`, which is exactly the A-01 defect.
- [ ] Template recorded (paste the link line here, never any secret):

```

```

### 9.2 Real sign-up round trip (S-01/A-01)

- [ ] On the DEV app, sign up with a fresh address (e.g.
  `verifikasi+<tanggal>@example.com`).
- [ ] Read the confirmation email and confirm the link host/path are
  `/auth/callback` with `next=/auth` (S-02).
- [ ] Open the link in the same browser. Expected: the session is created (the
  code is exchanged) and the app lands **signed in**, not on a signed-out
  `/auth`.
- [ ] If the link lands signed-out, or `/auth` shows `missing_code`, that is the
  A-01 defect still present in the DEV template — fix the template, not the app.

### 9.3 Account-row sync and retry (S-01)

- [ ] Run on the same DEVELOPMENT target (read-only):

```sql
-- One profile row per confirmed account; no orphan on either side.
select count(*) from auth.users;
select count(*) from public.users;
select a.id from auth.users a
  left join public.users u on u.id = a.id
 where u.id is null;                          -- expect 0 rows
select u.id from public.users u
  left join auth.users a on a.id = u.id
 where a.id is null;                          -- expect 0 rows
-- The row is a plain account: no authority was created by signing up.
select id, username, platform_role from public.users
 where platform_role is not null;             -- expect only the Platform Admins you know
select count(*) from public.producer_memberships;  -- unchanged by sign-ups
```
- [ ] Attempt the SAME email a second time. Expected: Auth refuses
  (`User already registered`), `auth.users` gains no row, `public.users` gains no
  row.
- [ ] If the counts diverge (an account without a profile row), stop and treat it
  as a profile-sync failure: the atomic half is covered by
  `web/tests/auth-sign-up-db.test.ts`, so a divergence on DEV means something
  else (a hand-edited row, or a trigger that was dropped) — investigate before
  any further apply.

## 10. Live gate hardening + age-verification foundation — apply 0052–0055 (DEV)

Applies, in this order, to four forward-only, idempotent migrations from Tahap C:

| Migration | Finding | What it changes |
| --- | --- | --- |
| `0052_live_session_column_privileges.sql` | A-02 | `live_sessions`: table-level SELECT → safe-column SELECT for anon/authenticated; service_role keeps full read |
| `0053_live_viewer_presence_capacity.sql` | A-04 | `live_viewers.last_seen_at` presence lease + `touch_live_viewer_presence(text)`; capacity and the Realtime policies count active presence |
| `0054_live_comment_rate_limit.sql` | A-09 | shared `live_comment_rate_limits` store; `post_live_comment` claims the ~1/5s window atomically |
| `0055_age_verification_foundation.sql` | batas integrasi usia | provider-neutral `age_verifications` + `age_verification_events` + internal check function; **not** wired into `assert_viewer_eligible` |

Each file is pasted WHOLE, in order, in one run. They depend on `0008`/`0009`
(applied) and on each other's numbering only. `assert_viewer_eligible` and
`admit_live_viewer` keep denying every viewer (B1) after all four.

### 10.1 Pre-apply checks (read-only, run first)

```sql
-- The Live objects of 0008/0009 must exist:
select to_regclass('public.live_sessions');        -- expect not null
select to_regclass('public.live_viewers');         -- expect not null
select to_regproc('public.admit_live_viewer');     -- expect not null
-- The new objects must NOT exist yet:
select column_name from information_schema.columns
 where table_schema='public' and table_name='live_viewers'
   and column_name='last_seen_at';                 -- expect 0 rows
select to_regproc('public.touch_live_viewer_presence');   -- expect null
select to_regclass('public.live_comment_rate_limits');    -- expect null
select to_regclass('public.age_verifications');           -- expect null
-- Current (pre-0052) posture: this is the A-02 exposure being removed.
select has_table_privilege('anon','public.live_sessions','SELECT');  -- expect true BEFORE apply
```

### 10.2 Apply 0052 → 0053 → 0054 → 0055

- [ ] Paste `0052_live_session_column_privileges.sql`, run once. Confirm:

```sql
select has_table_privilege('anon','public.live_sessions','SELECT');           -- expect false
select has_column_privilege('anon','public.live_sessions','status','SELECT'); -- expect true
select has_column_privilege('anon','public.live_sessions','live_input_id','SELECT');     -- false
select has_column_privilege('authenticated','public.live_sessions','idempotency_key','SELECT'); -- false
select has_column_privilege('service_role','public.live_sessions','live_input_id','SELECT');    -- true
```

- [ ] Paste `0053_live_viewer_presence_capacity.sql`, run once. Confirm:

```sql
select column_name, is_nullable, column_default from information_schema.columns
 where table_schema='public' and table_name='live_viewers' and column_name='last_seen_at';
select indexname from pg_indexes
 where schemaname='public' and tablename='live_viewers' and indexname='live_viewers_presence_idx';
select has_function_privilege('anon','public.touch_live_viewer_presence(text)','EXECUTE');          -- false
select has_function_privilege('authenticated','public.touch_live_viewer_presence(text)','EXECUTE'); -- true
-- The effective Realtime policies now read the presence lease (not admitted_at):
select policyname, qual, with_check from pg_policies
 where schemaname='realtime' and tablename='messages' order by policyname;
```

- [ ] Paste `0054_live_comment_rate_limit.sql`, run once. Confirm:

```sql
select rowsecurity from pg_tables where schemaname='public' and tablename='live_comment_rate_limits'; -- true
select count(*) from pg_policies where schemaname='public' and tablename='live_comment_rate_limits'; -- 0
select has_table_privilege('authenticated','public.live_comment_rate_limits','SELECT');   -- false
select has_table_privilege('authenticated','public.live_comment_rate_limits','INSERT');   -- false
```

- [ ] Paste `0055_age_verification_foundation.sql`, run once. Confirm:

```sql
select rowsecurity from pg_tables where schemaname='public' and tablename='age_verifications';       -- true
select rowsecurity from pg_tables where schemaname='public' and tablename='age_verification_events'; -- true
select count(*) from pg_policies where schemaname='public' and tablename='age_verification_events';  -- 0
select column_name from information_schema.columns
 where table_schema='public' and table_name='age_verifications'
   and column_name in ('date_of_birth','document_number','selfie','biometric_ref');  -- expect 0 rows
select has_function_privilege('authenticated','public.age_verification_satisfied(uuid)','EXECUTE'); -- false
select has_function_privilege('anon','public.record_age_verification_event(text,text,text)','EXECUTE'); -- false
select has_function_privilege('service_role','public.record_age_verification_event(text,text,text)','EXECUTE'); -- true
```

- [ ] **Re-confirm the viewer gate is still fail-closed** — the whole point of
  0055 is that nothing is wired to it yet:

```sql
select prosrc from pg_proc where proname='assert_viewer_eligible';
-- expect the unconditional deny at the end of the body, and NO reference to
-- age_verifications / age_verification_satisfied anywhere in it:
select position('age_verification' in prosrc) = 0 as gate_untouched
  from pg_proc where proname='assert_viewer_eligible';   -- expect true
```

### 10.3 Access verification on DEV (one result set per script)

Each file is one transaction ending in `rollback;`, creates its own fixtures and
leaves no data behind. Every emitted row must read `passed = true`.

- [ ] `web/tests/db-regression/live-session-column-access.sql` (A-02)
- [ ] `web/tests/db-regression/live-viewer-presence-access.sql` (A-04)
- [ ] `web/tests/db-regression/live-comment-rate-limit-access.sql` (A-09)
- [ ] `web/tests/db-regression/age-verification-access.sql` (age foundation)
- [ ] `web/tests/db-regression/live-moderation-audit-access.sql` (A-08/A-10/A-11/A-12/A-13, §10.5)
- [ ] Any `passed = false` — stop. Fix the migration in the repo and re-apply on a
  fresh target. Do not "fix forward" in the database.

Automated equivalents (real Postgres engine via PGlite):
`web/tests/live-session-column-privileges.test.ts`,
`web/tests/live-viewer-presence-cap.test.ts`,
`web/tests/live-comment-rate-limit.test.ts`,
`web/tests/age-verification-foundation.test.ts`.

#### 10.3.1 Concurrent admission + two-instance comment window (**NOT-RUN** — needs two DB sessions)

The automated suites run on ONE database connection (PGlite), so they prove the
serialization CONTRACT — a blocking, session-scoped `pg_advisory_xact_lock` taken
BEFORE the capacity count (A-04), and one atomic conditional upsert inside
`post_live_comment` for the comment window (A-09) — rather than two genuinely
simultaneous transactions. Close that gap on DEV with two psql sessions against
the same database, then tick the boxes:

- [ ] **A-04 concurrent admission.** With the session already holding 100 active
  presences, run `select public.admit_live_viewer('<session_id>');` in session A
  and session B at the same time. Expect exactly one `live_capacity_full` (or
  none, if a lease expired), and never 101 present rows:
  `select count(*) from public.live_viewers where live_session_id = '<session_id>' and last_seen_at > now() - interval '5 minutes';`
- [ ] **A-09 two-instance window.** With two app instances running, post two
  comments for the SAME viewer + session within 5 seconds, alternating
  instances. Expect the second to be refused with `live_comment_rate_limited`
  and the stored row to stay put:
  `select * from public.live_comment_rate_limits where live_session_id = '<session_id>' and user_id = '<user_id>';`
  (one row; `last_comment_at` must NOT move on the denied attempt)
- [ ] Record the observed numbers here (a measurement, not a pass/fail claim):

```

```

### 10.4 S-04 / S-05 — Realtime runtime checks on DEV (**NOT-RUN**)

**Status: NOT-RUN.** What the suite already proves (RAN-PASSED) is the gate
itself on a real Postgres engine: `web/tests/live-realtime-gate-static.test.ts`
evaluates the private-channel RLS with the realtime topic GUC — a session with no
admitted presence sees nothing and cannot publish, an admitted viewer with a
fresh presence lease sees the broadcast and can publish, an expired lease or an
ended session is refused, and no other session's topic leaks. The remaining
questions need the running Realtime service and cannot be answered by any test in
this repository:

- [ ] **S-04 (join):** with the DEV app open on a Live, confirm the browser's
  Realtime socket for `live_session:<id>` reports `SUBSCRIBED` for an admitted
  viewer and `CHANNEL_ERROR` for a signed-out/anonymous tab (and that the client
  tears its channels down on the error rather than retrying a public channel).
- [ ] **S-04 (broadcast):** with a signed-in non-admitted account, call
  `POST /api/live/comments` directly (outside the UI). Expect
  `live_viewer_denied` (400) and **no** broadcast reaching an admitted viewer's
  tab.
- [ ] **S-04 (presence):** watch longer than the 5-minute grace window with the
  tab open and confirm the viewer keeps receiving comments (the heartbeat renews
  the lease), then close the tab and confirm that viewer stops being counted in
  `live_viewers` presence after the window.
- [ ] **S-05 (load):** with the maximum viewer count, measure comment delivery
  and the observable rejection rate of the ~1/5s window across at least two
  instances. Record: instance count, viewer count, comments attempted, delivered,
  rejected, and any socket teardown. This is a measurement, not an assertion —
  record the numbers here rather than a pass/fail claim:

```

```

  Until those boxes are ticked on DEV, S-04 stays PARTIAL (gate proven on
  Postgres, Realtime round trip NOT-RUN) and S-05 stays NOT-RUN.

### 10.5 Moderation audit trail, producer audit reader, Live-capability suspension — apply 0056 (DEV)

`0056_live_moderation_audit_trail.sql` is forward-only, non-destructive and
re-runnable. It closes A-12 (the operator-policy ACL that broke anon reads),
A-13 (the rolled-back denial audit), A-11 (the producer audit reader) and
A-10 (account-level Live-capability suspension). A-08 adds no SQL — it lives in
`lib/live/session-service.ts` + `app/api/admin/live/moderation/route.ts`.

| Migration | Finding | Effect |
| --- | --- | --- |
| `0056_live_moderation_audit_trail.sql` | A-08/A-10/A-11/A-12/A-13 | re-creates the three 0047 operator policies to use `is_active_live_operator_for_place`; adds `live_capability_suspensions` + `suspend/restore_live_capability`; adds `list_place_live_audit`; adds `record_live_admission_denied`; drops the inert audit insert from `admit_live_viewer`; widens the `live_audit.action` CHECK |

- [ ] Apply AFTER 0055. Paste `0056_live_moderation_audit_trail.sql`, run once. Confirm:

```sql
-- A-12: the policy no longer references the operator TABLE directly
select prosrc from pg_proc where proname='is_active_live_operator_for_place';
select qual from pg_policies where schemaname='public' and tablename='live_sessions'
  and policyname='live_sessions_live_operator_read';   -- expect is_active_live_operator_for_place(...)
-- A-12: anon reads the public metadata again, the sensitive columns stay dark
select has_column_privilege('anon','public.live_sessions','status','SELECT');          -- true
select has_column_privilege('anon','public.live_sessions','live_input_id','SELECT');   -- false
-- A-10: nol akses klien ke tabel suspend; RPC hanya untuk authenticated (moderator dicek di dalam)
select rowsecurity from pg_tables where schemaname='public' and tablename='live_capability_suspensions'; -- true
select count(*) from pg_policies where schemaname='public' and tablename='live_capability_suspensions';  -- 0
select has_function_privilege('anon','public.suspend_live_capability(uuid,text)','EXECUTE');   -- false
select has_function_privilege('authenticated','public.suspend_live_capability(uuid,text)','EXECUTE'); -- true
-- A-11: reader tanpa grant anon
select has_function_privilege('anon','public.list_place_live_audit(text)','EXECUTE');   -- false
-- A-13: recorder hanya service_role
select has_function_privilege('authenticated','public.record_live_admission_denied(text,uuid,text)','EXECUTE'); -- false
select has_function_privilege('service_role','public.record_live_admission_denied(text,uuid,text)','EXECUTE');  -- true
-- A-13: admit_live_viewer tidak lagi menulis live_audit di dalam transaksinya
select position('insert into public.live_audit' in prosrc) = 0 as no_inert_insert
  from pg_proc where proname='admit_live_viewer';   -- expect true
-- Regression: gate penonton masih fail-closed
select position('age_verification' in prosrc) = 0 as gate_untouched
  from pg_proc where proname='assert_viewer_eligible';   -- expect true
```

- [ ] `web/tests/db-regression/live-moderation-audit-access.sql`
  (A-08/A-10/A-11/A-12/A-13) — one result set (`ord, check_name, passed, detail`),
  rolls back its fixtures. Every row must read `passed = true`.

Automated equivalent (real Postgres engine via PGlite):
`web/tests/live-moderation-audit-trail.test.ts`.

- [ ] **Manual moderator round trip (DEV).** As a `platform_moderator`, call
  `POST /api/admin/live/capability` with `{ "userId": "<account>" }`; confirm
  `start_live_session` for a Place that account operates now raises
  `producer_authorization_required`, that exactly one `live_audit` row with
  actor/target/reason/time was appended, and that `DELETE /api/admin/live/capability`
  restores it. A repeated suspend/restore must change nothing.

## 11. Out of scope (explicitly NOT here)

- No SMS/OTP provider and no vendor credential (B5 blocker stays open until the product owner supplies a provider; `PHONE_OTP_HASH_SECRET` / B6 is the matching server-side secret).
- No Cloudflare account/credential configuration (B4 blocker stays open until the PO supplies `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` server-side).
- No age-verification vendor or mechanism (B1 stays fail-closed DENY, Phase 2.1). The profile date of birth is NOT that mechanism: MASTER_LIVE_POLICY §12.1 item 3 states a self-declared date of birth does not satisfy the viewer gate.
- No production apply, no production env changes, no scope/payment/monetization additions.
