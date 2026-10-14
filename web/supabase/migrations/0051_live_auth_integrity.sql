-- 0051_live_auth_integrity.sql
-- LIVE AUTH INTEGRITY — cleanup-RPC lockdown (A-03) + verified-email gate for
-- the delegated Operator Live authority (A-06; product decision P4 applied to
-- the OPERATOR-DELEGATE scope only — see the policy note in section 2).
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

-- ---------------------------------------------------------------------------
-- 2. A-06 — a VERIFIED EMAIL is required for the delegated Operator authority
-- ---------------------------------------------------------------------------
-- Audit finding A-06: an account whose email was never confirmed could hold a
-- delegated Operator Live assignment and broadcast Live, while a viewer with
-- the same unconfirmed email is refused by assert_viewer_eligible (0008).
-- The authoritative source is auth.users.email_confirmed_at — never a client
-- boolean or user metadata.
--
-- POLICY DECISION (recorded): the masters leave the requirement undecided for
-- owner/manager (MASTER_LIVE_POLICY §2.2 / MASTER_LIVE_TECH §4.2 name no email
-- prerequisite; audit §5.3 carries no A-06 flag for Pengelola Tempat). The
-- requirement is therefore applied to the OPERATOR-DELEGATE scope only, exactly
-- what audit §5.5 flags (A-06 row): the operator branch of the authority
-- predicate and the invitation-accept RPC. An owner/manager is unaffected —
-- same posture as before this migration. If the product owner later extends it,
-- the same EXISTS subquery joins the membership branch.

-- 2.1 The ONE SQL authority predicate: the operator branch now also requires
--     the account's email to be confirmed in auth.users. The owner/manager
--     branch is byte-for-byte the 0049 rule. Internal: no client EXECUTE.
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
        -- A-06: delegated operator authority requires a CONFIRMED email.
        and exists (
          select 1
          from auth.users u
          where u.id = p_user_id
            and u.email_confirmed_at is not null
        )
    );
$$;

revoke all on function public.can_operate_live_for_place(uuid, text) from public, anon, authenticated;

-- 2.2 accept_live_operator_invitation — the INVITEE must have a confirmed
--     email BEFORE the invitation is even looked up (fail closed at the
--     earliest point; the answer reveals only a fact about the caller's own
--     account, never about any invitation). Everything else — the state
--     machine, replacement, the advisory lock, the audit history — is the
--     byte-for-byte 0048 behaviour, so the two layers can never disagree:
--     a caller the RPC refuses also fails can_operate_live_for_place.
create or replace function public.accept_live_operator_invitation(
  p_invitation_id uuid
) returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_row   public.live_operator_invitations;
begin
  if v_actor is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;

  -- A-06: a verified email is a prerequisite for delegated operator access.
  if not exists (
    select 1 from auth.users u
    where u.id = v_actor and u.email_confirmed_at is not null
  ) then
    raise exception 'email_verification_required' using errcode = 'P0001';
  end if;

  select * into v_row
  from public.live_operator_invitations
  where id = p_invitation_id
  for update;

  if not found then
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  if v_row.invited_user_id <> v_actor then
    -- Not the invitee: identical to "not found" (no existence leak).
    raise exception 'live_operator_invitation_not_found' using errcode = 'P0001';
  end if;

  if v_row.status = 'pending' and v_row.expires_at <= now() then
    update public.live_operator_invitations set status = 'expired' where id = p_invitation_id;
    raise exception 'live_operator_invitation_expired' using errcode = 'P0001';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'live_operator_invitation_invalid' using errcode = 'P0001';
  end if;

  -- Serialize concurrent accepts/replacements for the SAME Place.
  perform pg_advisory_xact_lock(hashtext('live_operator_place:' || v_row.place_id));

  -- Replacement: revoke the previous active operator (a DIFFERENT user) first,
  -- so max-one-active holds; the partial unique index is the backstop.
  update public.live_operators
     set revoked_at = now()
   where place_id = v_row.place_id
     and revoked_at is null
     and user_id <> v_row.invited_user_id;

  -- Keep the invitation history consistent: a previous accepted invitation for
  -- this Place is now revoked (fires its revocation notification).
  update public.live_operator_invitations
     set status = 'revoked'
   where place_id = v_row.place_id
     and status = 'accepted'
     and id <> p_invitation_id;

  insert into public.live_operators (user_id, place_id, granted_by, granted_at, revoked_at)
  values (v_row.invited_user_id, v_row.place_id, v_row.invited_by_producer_id, now(), null)
  on conflict (user_id, place_id) do update
    set revoked_at = null,
        granted_by = excluded.granted_by,
        granted_at = now();

  update public.live_operator_invitations
     set status = 'accepted'
   where id = p_invitation_id;
end;
$$;

-- No privilege statement here on purpose: `create or replace function`
-- PRESERVES the existing ACL, and 0048 already set the exact least-privilege
-- posture for this RPC
-- (`revoke all ... from public, anon, authenticated` + `grant execute ... to
-- authenticated`). Re-stating the grant would only duplicate 0048's decision in
-- a migration about the email gate, so the posture is inherited, not re-derived.
-- The A-03 section above still changes EXECUTE, for the two cleanup RPCs only.

commit;

-- ---------------------------------------------------------------------------
-- 3. DEV apply notes
-- ---------------------------------------------------------------------------
-- Apply AFTER 0050 (next free number after 0050 across every branch/PR).
-- It replaces NO table and deletes no data; it changes two function bodies
-- (2.1/2.2) and the EXECUTE posture of two cleanup RPCs (section 1).
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
--   -- A-06: the predicate stays internal, and an operator path now needs a
--   -- confirmed email (verify by RPC on DEV: an unconfirmed invitee's accept
--   -- raises email_verification_required).
--   select has_function_privilege('authenticated',
--     'public.can_operate_live_for_place(uuid,text)', 'EXECUTE');  -- expect false
-- The runnable scripts for the whole posture are
-- web/tests/db-regression/live-cleanup-rpc-access.sql and
-- web/tests/db-regression/live-operator-email-verification-access.sql
-- (both roll back).
