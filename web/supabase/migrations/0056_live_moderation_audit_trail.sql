-- 0056 — LIVE-D: moderation audit trail, account Live-capability suspension,
-- and the closing fixes for A-08, A-10, A-11, A-12 and A-13.
--
-- Audit findings (docs/audits/LIVE_AUTH_AUDIT_v1.md):
--
--   A-12  Migration 0047's operator SELECT policies (on live_sessions, places,
--         production_stages) referenced public.live_operators directly. RLS
--         policy expressions are planned with the QUERYING role's privileges, so
--         an anon read failed with `permission denied for table live_operators`
--         before any row was considered — fail-closed, but it broke every PUBLIC
--         (anonymous) Live/Place read, e.g. GET /api/live/status and the LIVE
--         discovery filter. Fix (audit-prescribed, narrowest): the policies now
--         call a pinned-SECURITY-DEFINER helper that evaluates the caller's OWN
--         active delegation, so the client role needs no privilege on the
--         operator table. No grant is widened to anon and RLS is not disabled.
--
--   A-13  `admit_live_viewer` wrote an `admission_denied` audit row and then
--         `raise`d `live_capacity_full`; the exception rolled the row back with
--         the rest of the aborted statement, so denials were never recorded.
--         The denial itself stays exactly as fail-closed as before (this
--         migration never turns a denial into an allow); the record now happens
--         OUT OF BAND, after the RPC has denied, through a service-role-only RPC
--         (`record_live_admission_denied`) invoked by the trusted server path.
--         The misleading in-transaction insert is removed: it could never
--         commit.
--
--   A-10  No account-level Live capability could be suspended/restored with an
--         actor/target/reason/time audit trail. This adds ONLY the "suspend
--         Live" foundation: a canonical per-account suspension row, an RPC pair
--         restricted to `platform_moderator` (the role that already holds
--         moderation authority per MASTER_AUTHORITY §5/§6 and
--         MASTER_LIVE_POLICY §5.1) with idempotent state changes and audited
--         decisions, and enforcement in the ONE authority predicate every Live
--         operate path uses. It disables BROADCASTING/OPERATING Live only.
--         "Suspend platform account" and "permanent terminate" are explicitly
--         NOT implemented (POLICY DECISION NEEDED — P5) and no new role is
--         created.
--
--   A-11  No producer-scoped reader of `live_audit`. Adds a read-only,
--         Place-scoped RPC for an ACTIVE owner/manager of that exact Place
--         (delegated operators deliberately excluded). No cross-tenant read, no
--         direct SELECT grant on live_audit, no grant to anon.
--
--   A-08  Playback already cannot be re-issued for a session that is not live
--         (`status <> 'live'` fails the playback route before a token is
--         minted), and dropping the provider live input stops existing
--         playback. This migration adds no SQL for A-08; the server-side
--         revocation trigger lives in lib/live/session-service.ts +
--         app/api/admin/live/moderation/route.ts and the residual token-TTL
--         window is documented in the audit doc.
--
-- Forward-only, least privilege, non-destructive (adds one table, one helper,
-- re-creates three policies, extends the audit action set, and adds RPCs).
-- Monotonic: does not edit 0008/0047/0052/0053/0054/0055. DEV apply only.

begin;

-- ---------------------------------------------------------------------------
-- 1. Audit action set: account-level Live capability decisions (A-10)
-- ---------------------------------------------------------------------------
-- 0008 declared the CHECK inline on the column, so Postgres named it
-- `live_audit_action_check`; no later migration touched it.
alter table public.live_audit
  drop constraint if exists live_audit_action_check;

alter table public.live_audit
  add constraint live_audit_action_check check (action in (
    'session_started', 'session_ended', 'report_submitted', 'moderation_warn',
    'moderation_end', 'moderation_suspend', 'eligibility_granted',
    'eligibility_revoked', 'admission_denied', 'camera_check_passed', 'comment_removed',
    'moderation_flag_review', 'moderation_resolve_review', 'moderation_block_content',
    'live_capability_suspended', 'live_capability_restored'
  ));

-- ---------------------------------------------------------------------------
-- 2. A-12: operator predicate WITHOUT a client-role reference to live_operators
-- ---------------------------------------------------------------------------
-- Pinned SECURITY DEFINER, parameterised by PLACE only: it evaluates the
-- CALLER's own delegation (`auth.uid()`), so it leaks nothing to a caller and
-- anon always gets false. Clients must hold EXECUTE because RLS policy
-- expressions are evaluated as the querying role; the body then runs as the
-- definer and the caller needs no privilege on public.live_operators.
create or replace function public.is_active_live_operator_for_place(p_place_id text)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.live_operators lo
    where lo.user_id = auth.uid()
      and lo.place_id = p_place_id
      and lo.revoked_at is null
  );
$$;

revoke all on function public.is_active_live_operator_for_place(text) from public;
grant execute on function public.is_active_live_operator_for_place(text) to anon, authenticated, service_role;

-- Re-create the three 0047 operator policies so their expressions no longer
-- reference the operator TABLE. Same grant of access, evaluated differently.
drop policy if exists places_live_operator_read on public.places;
create policy places_live_operator_read
  on public.places for select
  using (public.is_active_live_operator_for_place(places.id));

drop policy if exists production_stages_live_operator_read on public.production_stages;
create policy production_stages_live_operator_read
  on public.production_stages for select
  using (
    status = 'published'
    and public.is_active_live_operator_for_place(production_stages.place_id)
  );

drop policy if exists live_sessions_live_operator_read on public.live_sessions;
create policy live_sessions_live_operator_read
  on public.live_sessions for select
  using (public.is_active_live_operator_for_place(live_sessions.place_id));

-- ---------------------------------------------------------------------------
-- 3. A-10: account-level Live capability suspension (foundation only)
-- ---------------------------------------------------------------------------
-- One canonical row per account. Active suspension = revoked_at is null.
-- Self-service is impossible: writes exist only through the moderator RPCs
-- below. Client roles hold ZERO access (RLS on, no policy, privileges revoked);
-- the trusted server path reads/writes through the definer RPCs.
create table if not exists public.live_capability_suspensions (
  user_id       uuid primary key references public.users(id) on delete cascade,
  suspended_at  timestamptz not null default now(),
  suspended_by  uuid references public.users(id) on delete set null,
  reason        text,
  revoked_at    timestamptz,
  revoked_by    uuid references public.users(id) on delete set null,
  revoke_reason text
);

alter table public.live_capability_suspensions enable row level security;
revoke all on public.live_capability_suspensions from public, anon, authenticated;
grant select on public.live_capability_suspensions to service_role;

comment on table public.live_capability_suspensions is
  'Account-level suspension of the Live capability (broadcast/operate). Only '
  'platform_moderator may suspend/restore; every decision is audited. This is '
  'NOT a platform-account suspension (P5: not implemented).';

-- Internal predicate: fail-closed account-level capability check.
create or replace function public.is_live_account_suspended(p_user_id uuid)
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1
    from public.live_capability_suspensions s
    where s.user_id = p_user_id
      and s.revoked_at is null
  );
$$;

revoke all on function public.is_live_account_suspended(uuid) from public, anon, authenticated;

-- The ONE authority predicate every Live operate path already calls. A
-- suspended account can neither start nor end/operate any Live. Delegated
-- operators are account-scoped too: a suspension follows the account.
create or replace function public.can_operate_live_for_place(
  p_user_id  uuid,
  p_place_id text
) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    not public.is_live_account_suspended(p_user_id)
    and (
      exists (
        select 1
        from public.producer_memberships m
        where m.user_id = p_user_id
          and m.place_id = p_place_id
          and m.role in ('owner', 'manager')
      )
      or exists (
        select 1
        from public.live_operators lo
        where lo.user_id = p_user_id
          and lo.place_id = p_place_id
          and lo.revoked_at is null
      )
    );
$$;

revoke all on function public.can_operate_live_for_place(uuid, text) from public, anon, authenticated;

-- Suspend: platform_moderator only; idempotent (a second call while already
-- suspended changes no state and appends no second audit row).
create or replace function public.suspend_live_capability(
  p_user_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_moderator_required' using errcode = '42501';
  end if;

  if p_user_id is null or not exists (
    select 1 from public.users where id = p_user_id
  ) then
    raise exception 'live_suspension_target_invalid' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.live_capability_suspensions
    where user_id = p_user_id and revoked_at is null
  ) then
    return; -- idempotent: already suspended
  end if;

  insert into public.live_capability_suspensions
    (user_id, suspended_at, suspended_by, reason, revoked_at, revoked_by, revoke_reason)
  values
    (p_user_id, now(), auth.uid(), p_reason, null, null, null)
  on conflict (user_id) do update
    set suspended_at = now(),
        suspended_by = auth.uid(),
        reason = p_reason,
        revoked_at = null,
        revoked_by = null,
        revoke_reason = null;

  insert into public.live_audit (live_session_id, actor_id, action, detail)
  values (
    null,
    auth.uid(),
    'live_capability_suspended',
    jsonb_build_object('target_user_id', p_user_id, 'reason', p_reason)
  );
end;
$$;

revoke execute on function public.suspend_live_capability(uuid, text) from public, anon;
grant execute on function public.suspend_live_capability(uuid, text) to authenticated;

-- Restore: platform_moderator only; idempotent the same way.
create or replace function public.restore_live_capability(
  p_user_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.users
    where id = auth.uid() and platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_moderator_required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.live_capability_suspensions
    where user_id = p_user_id and revoked_at is null
  ) then
    return; -- idempotent: nothing to restore
  end if;

  update public.live_capability_suspensions
  set revoked_at = now(),
      revoked_by = auth.uid(),
      revoke_reason = p_reason
  where user_id = p_user_id and revoked_at is null;

  insert into public.live_audit (live_session_id, actor_id, action, detail)
  values (
    null,
    auth.uid(),
    'live_capability_restored',
    jsonb_build_object('target_user_id', p_user_id, 'reason', p_reason)
  );
end;
$$;

revoke execute on function public.restore_live_capability(uuid, text) from public, anon;
grant execute on function public.restore_live_capability(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A-11: Place-scoped producer audit reader (owner/manager only)
-- ---------------------------------------------------------------------------
-- Read-only, no cross-tenant, no anon. Deliberately NOT an RLS SELECT on
-- live_audit (MASTER_LIVE_TECH §3 keeps the table dark to authenticated).
-- Delegated operators are excluded: the audit of a Place belongs to its
-- Pengelola, not to a delegated broadcaster.
create or replace function public.list_place_live_audit(p_place_id text)
returns table (
  id bigint,
  live_session_id text,
  action text,
  detail jsonb,
  created_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if not exists (
    select 1 from public.producer_memberships m
    where m.user_id = auth.uid()
      and m.place_id = p_place_id
      and m.role in ('owner', 'manager')
  ) then
    raise exception 'producer_authorization_required' using errcode = '42501';
  end if;

  return query
    select a.id, a.live_session_id, a.action, a.detail, a.created_at
    from public.live_audit a
    join public.live_sessions s on s.id = a.live_session_id
    where s.place_id = p_place_id
    order by a.created_at desc, a.id desc
    limit 200;
end;
$$;

revoke execute on function public.list_place_live_audit(text) from public, anon;
grant execute on function public.list_place_live_audit(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. A-13: out-of-band admission-denial recording
-- ---------------------------------------------------------------------------
-- The denial decision lives in admit_live_viewer and is unchanged (it still
-- raises live_capacity_full). The audit record is written here, on a SEPARATE
-- transaction issued by the trusted server path after the RPC refused — so it
-- survives the rollback that erased the old in-transaction insert and never
-- influences the decision. service_role only: a client cannot reach this RPC,
-- so it cannot forge or spam denial records.
create or replace function public.record_live_admission_denied(
  p_session_id text,
  p_actor_id uuid,
  p_reason text default 'capacity_full'
) returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if p_actor_id is null or not exists (
    select 1 from public.users where id = p_actor_id
  ) then
    raise exception 'live_audit_actor_invalid' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.live_sessions where id = p_session_id
  ) then
    raise exception 'live_session_not_found' using errcode = 'P0001';
  end if;

  insert into public.live_audit (live_session_id, actor_id, action, detail)
  values (
    p_session_id,
    p_actor_id,
    'admission_denied',
    jsonb_build_object('reason', p_reason, 'recorded_via', 'server')
  );
end;
$$;

revoke execute on function public.record_live_admission_denied(text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_live_admission_denied(text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5b. A-13: drop the in-transaction insert that the RAISE always rolled back
-- ---------------------------------------------------------------------------
-- Same function, same fail-closed decision, same capacity math (0053): only the
-- audit insert that could never commit is gone — it is now written by
-- record_live_admission_denied on a separate transaction. `create or replace`
-- keeps the existing EXECUTE ACL (authenticated; never public/anon).
create or replace function public.admit_live_viewer(p_session_id text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_concurrent integer;
begin
  perform public.assert_viewer_eligible(p_session_id);

  -- Serialize this session's capacity check + ledger insert (0027), so two
  -- concurrent admissions can never both pass the 100-concurrent gate.
  perform pg_advisory_xact_lock(
    hashtextextended('live_viewer_admission_lock:' || p_session_id, 0)
  );

  -- Concurrent capacity (PO 2026-09-18: "100 viewers" = concurrent; tech §6:
  -- count ACTIVE PRESENCE, never the ledger itself).
  select count(*) into v_concurrent
  from public.live_viewers
  where live_session_id = p_session_id
    and last_seen_at > now() - interval '5 minutes';

  if v_concurrent >= 100 then
    -- A-13: NO audit insert here — it would be rolled back by this RAISE.
    -- The trusted server path records the denial out of band via
    -- record_live_admission_denied() after catching this error.
    raise exception 'live_capacity_full' using errcode = 'P0001';
  end if;

  insert into public.live_viewers (live_session_id, user_id, last_seen_at)
  values (p_session_id, auth.uid(), now())
  on conflict (live_session_id, user_id) do update
    set admitted_at = now(),
        last_seen_at = now();

  -- MR2: persist viewer peak (policy §12.1 item 7 retention).
  update public.live_sessions
  set viewer_peak = greatest(viewer_peak, v_concurrent + 1)
  where id = p_session_id;

  return true;
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- 6. DEV apply notes
-- ---------------------------------------------------------------------------
-- Apply AFTER 0055. It adds one table, one helper, one read RPC, two moderator
-- RPCs and one service-role recording RPC, re-creates three RLS policies, and
-- widens the live_audit action CHECK. It deletes no data.
--
-- Post-apply verification (DEVELOPMENT only; the runnable script is
-- web/tests/db-regression/live-moderation-audit-access.sql, which rolls back):
--   * as anon: `select id, status from public.live_sessions` succeeds (A-12),
--     while `select live_input_id from public.live_sessions` still fails;
--   * as anon: `select id from public.places limit 1` succeeds;
--   * as an owner/manager: list_place_live_audit(<own place>) returns rows;
--   * as a producer of another Place / a delegated operator / anon:
--     list_place_live_audit(...) raises producer_authorization_required or is
--     denied by grant;
--   * as platform_moderator: suspend_live_capability(<account>) then
--     start_live_session for a Place that account operates raises
--     producer_authorization_required; restore_live_capability(<account>)
--     re-enables it; each decision appended exactly one audit row with actor,
--     target and reason, and a repeated suspend/restore changed nothing;
--   * service_role: record_live_admission_denied writes an admission_denied row
--     while admit_live_viewer still raises live_capacity_full and adds no
--     viewer row.
