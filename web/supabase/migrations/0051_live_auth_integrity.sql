-- 0051_live_auth_integrity.sql
-- LIVE AUTH INTEGRITY — cleanup-RPC lockdown (A-03). Section 2 (A-06,
-- verified-email gate for the delegated Operator Live authority) is added in
-- the same migration file by the A-06 changeset of this branch.
--
-- Evidence: docs/audits/LIVE_AUTH_AUDIT_v1.md §3 (A-03, A-06).
--
-- It is FORWARD-ONLY and it changes NOTHING about the viewer gate:
--   * assert_viewer_eligible / admit_live_viewer / post_live_comment /
--     submit_live_report keep their fail-closed B1 deny-all (untouched);
--   * 0008, 0013, 0047, 0048, 0049 and 0050 are NOT modified (this migration
--     only replaces function bodies / privileges where noted);
--   * it grants nothing to anon or public and weakens no policy.
--
-- DEV apply only; never production without an explicit product decision.
begin;

-- ---------------------------------------------------------------------------
-- 1. A-03 — provider-cleanup RPCs become SERVICE-ROLE ONLY
-- ---------------------------------------------------------------------------
-- Audit finding A-03: release_live_input and list_ended_live_inputs verified
-- only the SESSION STATE, never the caller, yet were EXECUTE-granted to
-- every authenticated account (0008/0013). Any signed-in user could therefore
-- null another tenant's live_input_id (breaking the "pointer first, then
-- provider delete" cleanup contract, PO item 10) and enumerate the live_input_id
-- of every ended session cross-tenant (SECURITY DEFINER bypasses live_sessions
-- RLS).
--
-- Both RPCs are server INFRASTRUCTURE, not user actions: the only callers in
-- the code base are the cleanup paths in lib/live/session-service.ts (end
-- wrapper) and lib/live/session-service-cap.ts (ended-input sweep, invoked
-- from /api/live/status), which now open a service-role connection for these
-- two calls. The user-facing start/end RPCs are unchanged.
--
-- The function BODIES are intentionally left as-is: with no client EXECUTE
-- grant, the missing caller check is unreachable from any session, and the
-- service role is the trusted server path (Authority §2/§3: infrastructure
-- credentials stay server-side only).
revoke execute on function public.release_live_input(text) from public, anon, authenticated;
revoke execute on function public.list_ended_live_inputs() from public, anon, authenticated;
grant execute on function public.release_live_input(text) to service_role;
grant execute on function public.list_ended_live_inputs() to service_role;

commit;

-- ---------------------------------------------------------------------------
-- 3. DEV apply notes
-- ---------------------------------------------------------------------------
-- Apply AFTER 0050 (next free number after 0050 across every branch/PR).
-- It replaces NO function body and deletes no data; the only effect is the
-- EXECUTE privilege change above.
--
-- Post-apply verification (DEVELOPMENT only):
--   select has_function_privilege('anon',
--     'public.release_live_input(text)', 'EXECUTE');          -- expect false
--   select has_function_privilege('authenticated',
--     'public.release_live_input(text)', 'EXECUTE');          -- expect false
--   select has_function_privilege('anon',
--     'public.list_ended_live_inputs()', 'EXECUTE');          -- expect false
--   select has_function_privilege('authenticated',
--     'public.list_ended_live_inputs()', 'EXECUTE');          -- expect false
--   select has_function_privilege('service_role',
--     'public.release_live_input(text)', 'EXECUTE');          -- expect true
--   select has_function_privilege('service_role',
--     'public.list_ended_live_inputs()', 'EXECUTE');          -- expect true
-- The runnable script for the whole posture (incl. the service-role happy
-- path) is web/tests/db-regression/live-cleanup-rpc-access.sql (rolls back).
