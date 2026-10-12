-- 0052 — A-02: `live_sessions` provider-sensitive columns are no longer public.
--
-- Audit finding (docs/audits/LIVE_AUTH_AUDIT_v1.md A-02): migration 0008 granted
-- `select on public.live_sessions to anon, authenticated` (table level) and RLS
-- restricts ROWS, never COLUMNS. Every column was therefore readable by anyone
-- holding the anon key — including:
--   * live_input_id   — the provider (Cloudflare) input UID, and
--   * idempotency_key — the Producer's start idempotency key.
-- MASTER_LIVE_TECH_v1.0.md §1.2/§5 states this data is server-side only
-- ("live_input_id … server-side only"; "Stream credentials are server-side
-- only"). This is a recon/policy exposure, not a direct escalation: a publish
-- URL still requires the server API token and playback still requires a signed
-- token.
--
-- Fix, exactly as the audit prescribes: revoke the table-level SELECT from
-- anon/authenticated and re-grant SELECT on the NON-sensitive columns only.
-- PostgREST/column privileges then make the two columns invisible to clients,
-- while every existing read path keeps working (the sensitive reads move to the
-- server's service-role connection — see web/lib/live/session-service*.ts).
--
-- Least privilege / no widening:
--   * NOTHING is granted to `anon` that it did not already have — the column
--     grant is a strict SUBSET of the previous table grant.
--   * `authenticated` keeps the same rows (RLS policies are untouched) and the
--     same non-sensitive columns.
--   * service_role keeps full read access (server infrastructure), stated
--     explicitly instead of relying on platform defaults.
--   * No write grant is added anywhere; DML stays RPC-only (0008).
--
-- Idempotent, forward-only, non-destructive: grants only, no data or schema
-- change, no function body touched, and migrations 0008/0047/0051/0054 are not
-- edited.

begin;

-- Table-level SELECT off (both client roles), then the explicit safe column set.
revoke select on public.live_sessions from anon, authenticated;

-- Safe columns only: identifiers, lifecycle metadata, and the content gate.
-- live_input_id and idempotency_key are deliberately NOT listed.
grant select (
  id,
  place_id,
  producer_id,
  stage_id,
  status,
  created_at,
  started_at,
  ended_at,
  ended_reason,
  end_note,
  viewer_peak,
  content_status
) on public.live_sessions to anon, authenticated;

-- Server infrastructure (admin surfaces, sweeps, provider cleanup, playback
-- signing) reads the pointer columns through the service role.
grant select on public.live_sessions to service_role;

commit;
