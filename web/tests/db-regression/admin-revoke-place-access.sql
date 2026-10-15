-- admin-revoke-place-access.sql — Platform Admin mencabut hak kelola Produser
-- atas SATU Tempat (+ notifikasi ke pihak terdampak), migration 0057.
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/admin-revoke-place-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/admin-revoke-place-access-migration.test.ts. It seeds its own
-- isolated namespace, so the same 30 checks run on an empty database and on a
-- DEV database that already carries demo/PO data.
--
-- Contract verified (docs/audits/ADMIN_REVOKE_PLACE_ACCESS_AUDIT.md):
--   1. schema: producer_memberships gains ONE unique, non-null surrogate id;
--      the canonical PK (user_id, place_id) is unchanged;
--   2. place_audit keeps RLS-on / no policy / append-only and its action
--      vocabulary gains exactly the two revocation values;
--   3. the RPC is SECURITY DEFINER with a pinned search_path and only
--      service_role may EXECUTE it (anon/authenticated cannot);
--   4. a Platform Admin revokes ONE membership: the row disappears, an audit
--      row attributes the actor, the Tempat, the affected Produser, the role
--      and the result;
--   5. notifications: the revoked Produser gets exactly one non-disableable
--      `safety_account` notification (name, role, time in the Place timezone,
--      actor "Admin Singgah Lokal", what changed / did not change, next step via
--      the existing Bantuan entry, no link to the Tempat they just lost);
--      other active owner/manager get one `system` notification without any
--      contact data or internal admin detail; an editor gets none;
--   6. the last-owner safeguard refuses the revocation (fail-closed), audits
--      the refusal, and sends no notification;
--   7. re-submitting the same revocation is idempotent: a clear "already
--      revoked" outcome, no second audit row, no duplicate notification;
--   8. a non-admin actor and an unknown membership id are refused;
--   9. revoking access to one Tempat leaves the Produser's other memberships
--      and every unrelated table untouched;
--  10. anon/authenticated can neither read nor write the audit trail, and can
--      neither create nor rewrite notifications.
--
-- Output is a RESULT SET of (ord, check_name, passed, detail) — one row per
-- check. One transaction; ends with `rollback;` (nothing is persisted).

begin;

create temporary table admin_revoke_checks (
  ord        integer,
  check_name text,
  passed     boolean,
  detail     text
) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures — ISOLATED and re-seeded deterministically, so the result is the same
-- on a fresh database and on a DEV database that already holds demo/PO data.
--
-- The Places seeded by 0001 ('rumah-teh-lokal', 'kopi-dari-kebun',
-- 'dapur-rasa') are deliberately NOT used: their membership sets belong to the
-- application, not to this script. A Place that already carries other owners
-- would silently change the last-owner and co-manager results — and the
-- revocation under test would send notifications to real accounts. This script
-- therefore creates its OWN three Places, and every fixture row lives in ONE
-- reserved namespace ('regress-revoke-*', 'prod-admin-revoke-dev', the
-- 'cccccccc-1111-…' accounts) that no application code ever writes.
--
-- The namespace is cleared and re-seeded BEFORE any check runs, so a re-run — or
-- residue from a manual paste that stopped halfway — cannot change the outcome.
-- `place_audit` is append-only by design (0031 trigger) and is never deleted
-- here; the closing `rollback;` is what guarantees nothing is left behind.
-- ---------------------------------------------------------------------------
delete from public.notifications
 where user_id in (
   'cccccccc-1111-4000-8000-000000000001',
   'cccccccc-1111-4000-8000-000000000002',
   'cccccccc-1111-4000-8000-000000000003',
   'cccccccc-1111-4000-8000-000000000004',
   'cccccccc-1111-4000-8000-000000000005',
   'cccccccc-1111-4000-8000-000000000006',
   'cccccccc-1111-4000-8000-000000000007'
 );

delete from public.producer_memberships
 where user_id in (
   'cccccccc-1111-4000-8000-000000000001',
   'cccccccc-1111-4000-8000-000000000002',
   'cccccccc-1111-4000-8000-000000000003',
   'cccccccc-1111-4000-8000-000000000004',
   'cccccccc-1111-4000-8000-000000000005',
   'cccccccc-1111-4000-8000-000000000006',
   'cccccccc-1111-4000-8000-000000000007'
 )
    or place_id in ('regress-revoke-a', 'regress-revoke-b', 'regress-revoke-c');

-- Three Places owned by this script: A is the revocation target, B is the same
-- Produser's other Tempat (isolation), C has a single owner (last-owner
-- safeguard). Category/currency values match the CHECK constraints in force
-- after 0033/0039; the timezone trigger in 0003 accepts 'Asia/Jakarta'.
insert into public.places (id, name, short_description, category, type, area, timezone, currency)
values
  ('regress-revoke-a', 'Rumah Teh Regress A', 'Fixture isolasi regresi (dibuat dan di-rollback oleh skrip ini).', 'Perdagangan & Jasa', 'experience', 'Regress DEV', 'Asia/Jakarta', 'IDR'),
  ('regress-revoke-b', 'Kopi Regress B', 'Fixture isolasi regresi (dibuat dan di-rollback oleh skrip ini).', 'Perdagangan & Jasa', 'production', 'Regress DEV', 'Asia/Jakarta', 'IDR'),
  ('regress-revoke-c', 'Dapur Regress C', 'Fixture isolasi regresi (dibuat dan di-rollback oleh skrip ini).', 'Perdagangan & Jasa', 'production', 'Regress DEV', 'Asia/Jakarta', 'IDR')
on conflict (id) do update
  set name = excluded.name,
      short_description = excluded.short_description,
      category = excluded.category,
      type = excluded.type,
      area = excluded.area,
      timezone = excluded.timezone,
      currency = excluded.currency;

insert into auth.users (id, email, email_confirmed_at) values
  ('cccccccc-1111-4000-8000-000000000001', 'rev-admin@example.com', now()),
  ('cccccccc-1111-4000-8000-000000000002', 'rev-nonadmin@example.com', now()),
  ('cccccccc-1111-4000-8000-000000000003', 'rev-owner1@example.com', now()),
  ('cccccccc-1111-4000-8000-000000000004', 'rev-owner2@example.com', now()),
  ('cccccccc-1111-4000-8000-000000000005', 'rev-manager@example.com', now()),
  ('cccccccc-1111-4000-8000-000000000006', 'rev-editor@example.com', now()),
  ('cccccccc-1111-4000-8000-000000000007', 'rev-lone-owner@example.com', now())
on conflict (id) do nothing;

insert into public.users (id) values
  ('cccccccc-1111-4000-8000-000000000001'),
  ('cccccccc-1111-4000-8000-000000000002'),
  ('cccccccc-1111-4000-8000-000000000003'),
  ('cccccccc-1111-4000-8000-000000000004'),
  ('cccccccc-1111-4000-8000-000000000005'),
  ('cccccccc-1111-4000-8000-000000000006'),
  ('cccccccc-1111-4000-8000-000000000007')
on conflict (id) do nothing;

update public.users set platform_role = 'platform_moderator'
 where id = 'cccccccc-1111-4000-8000-000000000001';

insert into public.producers (id, display_name) values
  ('prod-admin-revoke-dev', 'Pengelola Revoke DEV')
on conflict (id) do update set display_name = excluded.display_name;

-- Re-seeded to a KNOWN state (upsert on the canonical PK), so the membership set
-- each check reads is exactly this one, whatever the surrounding database holds.
insert into public.producer_memberships (user_id, producer_id, place_id, role) values
  ('cccccccc-1111-4000-8000-000000000003', 'prod-admin-revoke-dev', 'regress-revoke-a', 'owner'),
  ('cccccccc-1111-4000-8000-000000000004', 'prod-admin-revoke-dev', 'regress-revoke-a', 'owner'),
  ('cccccccc-1111-4000-8000-000000000005', 'prod-admin-revoke-dev', 'regress-revoke-a', 'manager'),
  ('cccccccc-1111-4000-8000-000000000006', 'prod-admin-revoke-dev', 'regress-revoke-a', 'editor'),
  ('cccccccc-1111-4000-8000-000000000003', 'prod-admin-revoke-dev', 'regress-revoke-b', 'owner'),
  ('cccccccc-1111-4000-8000-000000000007', 'prod-admin-revoke-dev', 'regress-revoke-c', 'owner')
on conflict (user_id, place_id) do update
  set producer_id = excluded.producer_id, role = excluded.role;

-- ---------------------------------------------------------------------------
-- 1. Schema & posture (checks 1–10)
-- ---------------------------------------------------------------------------
insert into admin_revoke_checks values
  (1, 'membership_id_column_present',
      exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='producer_memberships'
                 and column_name='id' and is_nullable='NO'),
      'producer_memberships.id must exist and be NOT NULL'),
  (2, 'membership_id_unique_index',
      (select count(*) from pg_indexes
        where schemaname='public' and tablename='producer_memberships'
          and indexdef ilike '%unique%' and indexdef ilike '%(id)%') = 1,
      'one unique index on (id)'),
  (3, 'canonical_pk_unchanged',
      (select string_agg(a.attname, ',' order by a.attname)
         from pg_index i
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'public.producer_memberships'::regclass and i.indisprimary)
        = 'place_id,user_id',
      'PK stays (user_id, place_id)'),
  (4, 'audit_vocabulary_extended',
      (select pg_get_constraintdef(oid) from pg_constraint
        where conrelid='public.place_audit'::regclass and conname='place_audit_action_check')
        like '%producer_place_access_revoked%'
      and (select pg_get_constraintdef(oid) from pg_constraint
            where conrelid='public.place_audit'::regclass and conname='place_audit_action_check')
        like '%producer_place_access_revoke_denied%',
      'place_audit action vocabulary gains both revocation values'),
  (5, 'audit_rls_on_and_closed',
      (select relrowsecurity from pg_class where oid='public.place_audit'::regclass) = true
      and not has_table_privilege('anon', 'public.place_audit', 'SELECT')
      and not has_table_privilege('authenticated', 'public.place_audit', 'SELECT'),
      'place_audit: RLS on, no client read'),
  (6, 'rpc_security_definer_pinned_search_path',
      (select prosecdef from pg_proc where proname='revoke_producer_place_access') = true
      and (select proconfig::text from pg_proc where proname='revoke_producer_place_access')
          like '%search_path=public%',
      'SECURITY DEFINER with pinned search_path'),
  (7, 'rpc_execute_service_role_only',
      has_function_privilege('service_role',
        'public.revoke_producer_place_access(uuid, uuid)', 'EXECUTE'),
      'service_role may EXECUTE'),
  (8, 'rpc_not_executable_by_anon',
      not has_function_privilege('anon',
        'public.revoke_producer_place_access(uuid, uuid)', 'EXECUTE'),
      'anon must NOT EXECUTE'),
  (9, 'rpc_not_executable_by_authenticated',
      not has_function_privilege('authenticated',
        'public.revoke_producer_place_access(uuid, uuid)', 'EXECUTE'),
      'authenticated must NOT EXECUTE'),
  (10, 'notifications_client_has_no_insert',
      not has_table_privilege('authenticated', 'public.notifications', 'INSERT')
      and not has_table_privilege('anon', 'public.notifications', 'SELECT'),
      'clients cannot create/read others notifications');

-- ---------------------------------------------------------------------------
-- 2. Happy path: admin revokes a manager, audit + notifications (checks 11–17)
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin    uuid := 'cccccccc-1111-4000-8000-000000000001';
  v_manager  uuid := 'cccccccc-1111-4000-8000-000000000005';
  v_editor   uuid := 'cccccccc-1111-4000-8000-000000000006';
  v_owner1   uuid := 'cccccccc-1111-4000-8000-000000000003';
  v_target   uuid;
  v_outcome  jsonb;
  v_audit    record;
  v_notif    record;
  v_body     text;
begin
  perform set_config('request.jwt.claims', '', false); -- no session: actor comes from p_actor_id

  select id into v_target from public.producer_memberships
   where user_id = v_manager and place_id = 'regress-revoke-a';

  v_outcome := public.revoke_producer_place_access(v_admin, v_target);

  insert into admin_revoke_checks values
    (11, 'admin_revoke_returns_revoked',
        (v_outcome ->> 'ok')::boolean is true
        and v_outcome ->> 'status' = 'revoked'
        and (v_outcome ->> 'notified')::boolean is true,
        v_outcome::text),
    (12, 'membership_row_removed',
        not exists (select 1 from public.producer_memberships where id = v_target),
        'revoked membership id=' || v_target::text);

  select place_id, actor_id, action, detail
    into v_audit
    from public.place_audit
   where action = 'producer_place_access_revoked'
     and detail ->> 'membership_id' = v_target::text
   order by id desc limit 1;

  insert into admin_revoke_checks values
    (13, 'audit_attributes_actor_target_result',
        v_audit.place_id = 'regress-revoke-a'
        and v_audit.actor_id = v_admin
        and v_audit.detail ->> 'target_user_id' = v_manager::text
        and v_audit.detail ->> 'role' = 'manager'
        and v_audit.detail ->> 'result' = 'revoked',
        coalesce(v_audit.detail::text, 'no audit row'));

  select category, event_type, title, body, place_id
    into v_notif
    from public.notifications
   where user_id = v_manager and source_type = 'producer_membership'
     and source_id = v_target::text;

  v_body := coalesce(v_notif.body, '');

  insert into admin_revoke_checks values
    (14, 'revoked_producer_gets_one_safety_account_notification',
        (select count(*) from public.notifications
          where user_id = v_manager and source_type='producer_membership'
            and source_id = v_target::text) = 1
        and v_notif.category = 'safety_account'
        and v_notif.event_type = 'producer_place_access_revoked'
        and v_notif.title = 'Hak akses Tempat dicabut'
        and v_notif.place_id is null,
        coalesce(v_notif.category, 'no notification') || ' / ' || coalesce(v_notif.event_type, '-')),
    (15, 'revocation_notification_content',
        v_body like '%Admin Singgah Lokal%'
        and v_body like '%Rumah Teh Regress A%'
        and v_body like '%Pengelola%'
        and v_body like '%(Asia/Jakarta)%'
        and v_body like '%tidak lagi bisa mengelola Tempat itu%'
        and v_body like '%Tempat lain yang kamu kelola tidak berubah%'
        and v_body like '%menu Bantuan%'
        and v_body not like '%@example.com%'
        and v_body not ilike '%pembayaran%'
        and v_body not ilike '%checkout%',
        left(v_body, 160));

  insert into admin_revoke_checks values
    (16, 'other_owner_and_manager_notified_without_contact_data',
        (select count(*) from public.notifications
          where source_type='producer_membership' and source_id = v_target::text
            and event_type='producer_place_management_changed') = 2
        and (select count(*) from public.notifications
              where user_id = v_owner1 and event_type='producer_place_management_changed'
                and body like '%Pengelola Revoke DEV%'
                and body like '%Rumah Teh Regress A%'
                and body not like '%@example.com%'
                and body not like '%Admin Singgah Lokal%') = 1,
        'owner/manager peers notified, no email, no admin detail'),
    (17, 'editor_receives_no_notification',
        not exists (select 1 from public.notifications where user_id = v_editor),
        'editor notifications=0');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Last owner refused, audited, no notification (checks 18–20)
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin uuid := 'cccccccc-1111-4000-8000-000000000001';
  v_lone  uuid := 'cccccccc-1111-4000-8000-000000000007';
  v_target uuid;
  v_outcome jsonb;
begin
  perform set_config('request.jwt.claims', '', false);
  select id into v_target from public.producer_memberships
   where user_id = v_lone and place_id = 'regress-revoke-c';

  v_outcome := public.revoke_producer_place_access(v_admin, v_target);

  insert into admin_revoke_checks values
    (18, 'last_owner_refused',
        (v_outcome ->> 'ok')::boolean is false and v_outcome ->> 'status' = 'last_owner',
        v_outcome::text),
    (19, 'last_owner_row_survives',
        exists (select 1 from public.producer_memberships where id = v_target),
        'row kept'),
    (20, 'last_owner_refusal_audited_without_notification',
        exists (select 1 from public.place_audit
                 where action='producer_place_access_revoke_denied'
                   and detail ->> 'membership_id' = v_target::text
                   and detail ->> 'reason' = 'last_owner')
        and not exists (select 1 from public.notifications
                         where source_id = v_target::text),
        'denied audit row present, no notification');
end $$;

-- ---------------------------------------------------------------------------
-- 4. Idempotency, non-admin, unknown id, isolation (checks 21–27)
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin  uuid := 'cccccccc-1111-4000-8000-000000000001';
  v_nonadmin uuid := 'cccccccc-1111-4000-8000-000000000002';
  v_owner1 uuid := 'cccccccc-1111-4000-8000-000000000003';
  v_editor uuid := 'cccccccc-1111-4000-8000-000000000006';
  v_target uuid;
  v_before_notifications integer;
  v_before_audit integer;
  v_second jsonb;
  v_third jsonb;
  v_cross record;
  v_refused boolean := false;
begin
  perform set_config('request.jwt.claims', '', false);

  -- Editor revocation first, so we can prove the re-submit is idempotent.
  select id into v_target from public.producer_memberships
   where user_id = v_editor and place_id = 'regress-revoke-a';

  perform public.revoke_producer_place_access(v_admin, v_target);
  select count(*) into v_before_notifications from public.notifications
   where source_type='producer_membership' and source_id = v_target::text;
  select count(*) into v_before_audit from public.place_audit
   where action='producer_place_access_revoked' and detail ->> 'membership_id' = v_target::text;

  v_second := public.revoke_producer_place_access(v_admin, v_target);
  v_third  := public.revoke_producer_place_access(v_admin, v_target);

  insert into admin_revoke_checks values
    (21, 'double_revoke_is_idempotent',
        (v_second ->> 'ok')::boolean is false
        and v_second ->> 'status' = 'already_revoked'
        and (v_third ->> 'status') = 'already_revoked',
        v_second::text),
    (22, 'idempotent_revoke_adds_no_audit_or_notification',
        (select count(*) from public.notifications
          where source_type='producer_membership' and source_id = v_target::text) = v_before_notifications
        and (select count(*) from public.place_audit
              where action='producer_place_access_revoked'
                and detail ->> 'membership_id' = v_target::text) = v_before_audit,
        'notifications/audit unchanged');

  begin
    perform public.revoke_producer_place_access(v_nonadmin, v_target);
  exception when others then
    v_refused := true;
  end;

  insert into admin_revoke_checks values
    (23, 'non_admin_actor_refused',
        v_refused,
        'non-moderator p_actor_id must raise'),
    (24, 'unknown_membership_id_refused',
        public.revoke_producer_place_access(v_admin,
          '99999999-9999-4999-8999-999999999999') ->> 'status' = 'invalid_target',
        'unknown id -> invalid_target');

  select m.place_id, m.role into v_cross
    from public.producer_memberships m
   where m.user_id = v_owner1 and m.place_id = 'regress-revoke-b';

  insert into admin_revoke_checks values
    (25, 'other_place_membership_untouched',
        v_cross.role = 'owner',
        'same Produser keeps the other Tempat membership'),
    (26, 'revoked_user_has_no_membership_left_on_that_place',
        not exists (select 1 from public.producer_memberships
                     where user_id = v_editor and place_id = 'regress-revoke-a'),
        'management gate reads this row and now finds nothing'),
    (27, 'unrelated_tables_untouched',
        (select count(*) from auth.users where id = v_editor) = 1
        and (select count(*) from public.users where id = v_editor) = 1
        and (select count(*) from public.producers where id = 'prod-admin-revoke-dev') = 1,
        'auth.users / public.users / producers intact');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Client access boundary (checks 28–30)
-- ---------------------------------------------------------------------------
do $$
declare
  v_rows integer;
begin
  -- anon cannot read the audit trail.
  execute 'set role anon';
  begin
    select count(*) into v_rows from public.place_audit;
    execute 'reset role';
    insert into admin_revoke_checks values
      (28, 'anon_cannot_read_audit', false, 'anon read ' || v_rows || ' audit rows');
  exception when others then
    execute 'reset role';
    insert into admin_revoke_checks values (28, 'anon_cannot_read_audit', true, sqlerrm);
  end;

  -- authenticated cannot read the audit trail.
  execute 'set role authenticated';
  begin
    select count(*) into v_rows from public.place_audit;
    execute 'reset role';
    insert into admin_revoke_checks values
      (29, 'authenticated_cannot_read_audit', false, 'authenticated read ' || v_rows || ' audit rows');
  exception when others then
    execute 'reset role';
    insert into admin_revoke_checks values (29, 'authenticated_cannot_read_audit', true, sqlerrm);
  end;

  -- a client cannot forge a revocation notification.
  execute 'set role authenticated';
  begin
    insert into public.notifications (user_id, category, event_type, title, body)
    values ('cccccccc-1111-4000-8000-000000000003', 'system', 'palsu', 'x', 'y');
    execute 'reset role';
    insert into admin_revoke_checks values
      (30, 'client_cannot_create_notifications', false, 'client inserted a notification');
  exception when others then
    execute 'reset role';
    insert into admin_revoke_checks values (30, 'client_cannot_create_notifications', true, sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from admin_revoke_checks
order by ord;

rollback;
