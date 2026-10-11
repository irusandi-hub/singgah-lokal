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
profile + phone OTP foundation), which depends on `0047` only.

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

## 8. Out of scope (explicitly NOT here)

- No SMS/OTP provider and no vendor credential (B5 blocker stays open until the product owner supplies a provider; `PHONE_OTP_HASH_SECRET` / B6 is the matching server-side secret).
- No Cloudflare account/credential configuration (B4 blocker stays open until the PO supplies `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` server-side).
- No age-verification vendor or mechanism (B1 stays fail-closed DENY, Phase 2.1). The profile date of birth is NOT that mechanism: MASTER_LIVE_POLICY §12.1 item 3 states a self-declared date of birth does not satisfy the viewer gate.
- No production apply, no production env changes, no scope/payment/monetization additions.
