# Live Migration — DEVELOPMENT Apply Checklist

Scope: applying `web/supabase/migrations/0008_live_sessions.sql` to the **Supabase DEVELOPMENT project only**. Never run any step of this checklist against production. No Cloudflare configuration is part of this checklist (B4 stays a separate, explicit step).

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

## 5. Out of scope (explicitly NOT here)

- No Cloudflare account/credential configuration (B4 blocker stays open until the PO supplies `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` server-side).
- No age-verification vendor or mechanism (B1 stays fail-closed DENY, Phase 2.1).
- No production apply, no production env changes, no scope/payment/monetization additions.
