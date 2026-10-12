-- 0054 — A-09: the comment rate limit lives in the SHARED store, not in
-- server-process memory.
--
-- Audit finding (docs/audits/LIVE_AUTH_AUDIT_v1.md A-09): the ~1/5s per-viewer
-- comment limit was enforced by a `Map` inside the Next.js process
-- (lib/live/session-service.ts), so on any multi-instance/serverless deployment
-- a viewer could spread requests across instances and bypass the limit.
-- MASTER_LIVE_TECH §6 names the acceptable mechanisms explicitly — "rate
-- limiting is server-side (e.g. in-RPC window check or edge middleware —
-- TUNABLE mechanism)" — so the canonical window belongs with the canonical
-- comment path, which is the database, not an instance's memory.
--
-- Fix:
--   * `public.live_comment_rate_limits` — one row per (session, viewer) holding
--     the last accepted comment time. Client roles have ZERO access (RLS on,
--     no policy, all privileges revoked): only the server-side RPC path touches
--     it. No new external service is introduced.
--   * `post_live_comment` now claims the slot itself, with a single atomic
--     conditional upsert (`on conflict … do update … where last_comment_at <=
--     now() - interval`). The row lock makes concurrent attempts from ANY
--     number of instances race-safe: exactly one wins per window.
--
-- Unchanged: the gate order (assert_viewer_eligible first), the TUNABLE window
-- value (5 s — mirrored by LIVE_COMMENT_MIN_INTERVAL_MS), the 300-character
-- TUNABLE length limit, the same error code (`live_comment_rate_limited`) the
-- route/UI already map, and the ephemeral-comment rule — this table stores no
-- comment text at all (policy §12.1 item 6), only a per-viewer timestamp, and
-- a denied attempt never extends its own window.
--
-- Forward-only, least privilege, non-destructive. DEV apply only.

begin;

-- ---------------------------------------------------------------------------
-- 1. Shared rate-limit store (zero client access)
-- ---------------------------------------------------------------------------
create table if not exists public.live_comment_rate_limits (
  live_session_id text not null references public.live_sessions(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  last_comment_at timestamptz not null,
  primary key (live_session_id, user_id)
);

comment on table public.live_comment_rate_limits is
  'A-09: shared per-viewer comment window. Stores the last accepted comment time only — never comment text. Server-side (SECURITY DEFINER RPC) access only; no client role holds any privilege.';

alter table public.live_comment_rate_limits enable row level security;

-- Fail closed: no policy and no grant for clients (the implicit PUBLIC default
-- is revoked too, so only the function owner and the service role can reach it).
revoke all on public.live_comment_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on public.live_comment_rate_limits to service_role;

-- ---------------------------------------------------------------------------
-- 2. post_live_comment — same contract, shared-store window
-- ---------------------------------------------------------------------------
create or replace function public.post_live_comment(p_session_id text, p_body text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_claimed timestamptz;
begin
  perform public.assert_viewer_eligible(p_session_id);

  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 300 then
    raise exception 'live_comment_too_long' using errcode = 'P0001';
  end if;

  -- Comments are ephemeral (no live_comments table, policy §12.1 item 6), but
  -- the RATE LIMIT is canonical state (A-09): one atomic claim per viewer per
  -- session in the shared store. The conditional UPDATE only writes when the
  -- previous accepted comment is already outside the TUNABLE ~1/5s window, so
  -- (a) concurrent attempts from different server instances cannot both win,
  -- and (b) a denied attempt leaves the stored timestamp untouched — denied
  -- attempts never extend the window.
  insert into public.live_comment_rate_limits (live_session_id, user_id, last_comment_at)
  values (p_session_id, auth.uid(), now())
  on conflict (live_session_id, user_id) do update
    set last_comment_at = excluded.last_comment_at
    where public.live_comment_rate_limits.last_comment_at <= now() - interval '5 seconds'
  returning last_comment_at into v_claimed;

  if not found then
    raise exception 'live_comment_rate_limited' using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

commit;
