-- 0013: Lock EXECUTE on internal Live helpers (gap 6, privilege lockdown).
--
-- The default Postgres ACL grants EXECUTE on functions to PUBLIC. Migration
-- 0008 explicitly revoked public/anon EXECUTE on the client-facing Live RPCs
-- but never hardened the internal helpers created after that block — the
-- trigger functions (default PUBLIC EXECUTE) and the cleanup/gate helpers.
-- None of these is ever called directly by a client:
--
--   assert_viewer_eligible(text)   internal fail-closed gate, called only by
--                                  other RPCs
--   heal_live_duration_caps()      internal duration-cap sweeper
--   release_live_input(text)       provider-cleanup pointer handoff, called
--                                  only by server routes
--   list_ended_live_inputs()       provider-cleanup sweep backlog, called
--                                  only by server routes
--   block_live_audit_mutation()    trigger function (audit append-only)
--   live_stage_guard()             trigger function (stage auto-end)
--
-- Fail-closed posture: EXECUTE is revoked from PUBLIC and anon; the four
-- helpers keep their authenticated grant (server routes run as authenticated
-- callers); the two trigger functions keep no direct EXECUTE at all (trigger
-- execution runs as the table owner and is unaffected by these ACLs).

revoke execute on function public.assert_viewer_eligible(text)
from public, anon;
grant execute on function public.assert_viewer_eligible(text)
to authenticated;

revoke execute on function public.heal_live_duration_caps()
from public, anon;
grant execute on function public.heal_live_duration_caps()
to authenticated;

revoke execute on function public.release_live_input(text)
from public, anon;
grant execute on function public.release_live_input(text)
to authenticated;

revoke execute on function public.list_ended_live_inputs()
from public, anon;
grant execute on function public.list_ended_live_inputs()
to authenticated;

revoke execute on function public.block_live_audit_mutation()
from public, anon, authenticated;

revoke execute on function public.live_stage_guard()
from public, anon, authenticated;
