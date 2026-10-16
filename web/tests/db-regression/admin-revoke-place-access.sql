-- admin-revoke-place-access.sql — Platform Admin mencabut kewenangan pengelolaan
-- digital seorang Produser atas SATU Tempat (+ notifikasi ke pihak terdampak).
-- Migration 0058 (kebijakan pengelolaan digital permanen) di atas 0057.
--
-- Runnable on the DEVELOPMENT project (SQL Editor paste, or
-- `psql "$SUPABASE_DEV_DB_URL" -f tests/db-regression/admin-revoke-place-access.sql`)
-- and executed automatically on a real Postgres engine by
-- web/tests/admin-revoke-place-access-migration.test.ts. It seeds its own
-- isolated namespace, so the same checks run on an empty database and on a
-- DEV database that already carries demo/PO data.
--
-- Contract verified (docs/audits/PLACE_MANAGEMENT_POLICY_AUDIT.md):
--   1. schema: producer_memberships keeps ONE unique, non-null surrogate id;
--      the canonical PK (user_id, place_id) is unchanged;
--   2. place_audit keeps RLS-on / no policy / append-only and its action
--      vocabulary still carries the revocation values (the 0057 "denied" value
--      stays only so old trail rows remain valid — 0058 never writes it);
--   3. the RPC is SECURITY DEFINER with a pinned search_path and only
--      service_role may EXECUTE it (anon/authenticated cannot);
--   4. a Platform Admin revokes ONE membership with a MANDATORY reason: the row
--      disappears and an audit row attributes the actor, the Tempat, the
--      affected Produser, the role, the REASON, and the outcome;
--   5. notifications: the revoked Produser gets exactly one non-disableable
--      `safety_account` notification (name, role, time in the Place timezone,
--      actor "Admin Singgah Lokal", what changed / did not change, the digital
--      -only scope, next step via the existing Bantuan entry, no link to the
--      Tempat they just lost); other active owner/manager get one `system`
--      notification without contact data or internal admin detail; an editor
--      gets none;
--   6. KEBIJAKAN MANAGERLESS: revoking the LAST manager SUCCEEDS (no
--      'last_owner' refusal), the Tempat survives with its publication state,
--      the stale `places.producer_id` is released so the Tempat is claimable
--      again through the official claim process, and the outcome is audited;
--   7. a reason that is missing, blank, too short, or too long is refused with
--      NO side effect at all (no delete, no audit, no notification);
--   8. re-submitting the same revocation is idempotent: a clear "already
--      revoked" outcome, no second audit row, no duplicate notification;
--   9. a non-admin actor and an unknown membership id are refused;
--  10. revoking access to one Tempat leaves the Produser's other memberships
--      and every unrelated table untouched;
--  11. anon/authenticated can neither read nor write the audit trail, and can
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
-- would silently change the co-manager results — and the revocation under test
-- would send notifications to real accounts. This script therefore creates its
-- OWN three Places, and every fixture row lives in ONE reserved namespace
-- ('regress-revoke-*', 'prod-admin-revoke-dev', the 'cccccccc-1111-…'
-- accounts) that no application code ever writes.
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

-- The script's own Produser entity first: the Places below reference it, and
-- it is what makes the managerless release observable (checks 18–21).
insert into public.producers (id, display_name) values
  ('prod-admin-revoke-dev', 'Pengelola Revoke DEV')
on conflict (id) do update set display_name = excluded.display_name;

-- Three Places owned by this script: A is the revocation target (several
-- managers, so it stays managed), B is the same Produser's other Tempat
-- (isolation), C is the LAST-manager case (kebijakan managerless, 0058).
-- Category/currency values match the CHECK constraints in force after
-- 0033/0039; the timezone trigger in 0003 accepts 'Asia/Jakarta'.
insert into public.places (
  id, name, short_description, category, type, area, timezone, currency,
  producer_id, publication_status, claim_status
)
values
  ('regress-revoke-a', 'Rumah Teh Regress A', 'Fixture isolasi regresi (dibuat dan di-rollback oleh skrip ini).', 'Perdagangan & Jasa', 'experience', 'Regress DEV', 'Asia/Jakarta', 'IDR', 'prod-admin-revoke-dev', 'published', 'unverified'),
  ('regress-revoke-b', 'Kopi Regress B', 'Fixture isolasi regresi (dibuat dan di-rollback oleh skrip ini).', 'Perdagangan & Jasa', 'production', 'Regress DEV', 'Asia/Jakarta', 'IDR', null, 'published', 'unverified'),
  ('regress-revoke-c', 'Dapur Regress C', 'Fixture isolasi regresi (dibuat dan di-rollback oleh skrip ini).', 'Perdagangan & Jasa', 'production', 'Regress DEV', 'Asia/Jakarta', 'IDR', 'prod-admin-revoke-dev', 'published', 'unverified')
on conflict (id) do update
  set name = excluded.name,
      short_description = excluded.short_description,
      category = excluded.category,
      type = excluded.type,
      area = excluded.area,
      timezone = excluded.timezone,
      currency = excluded.currency,
      publication_status = excluded.publication_status,
      claim_status = excluded.claim_status,
      -- A and C start pointing at the script's own Produser, which is what makes
      -- the managerless release observable (checks 18–21). B stays NULL.
      producer_id = excluded.producer_id;

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
      'place_audit action vocabulary keeps both revocation values'),
  (5, 'audit_rls_on_and_closed',
      (select relrowsecurity from pg_class where oid='public.place_audit'::regclass) = true
      and not has_table_privilege('anon', 'public.place_audit', 'SELECT')
      and not has_table_privilege('authenticated', 'public.place_audit', 'SELECT'),
      'place_audit: RLS on, no client read'),
  (6, 'rpc_security_definer_pinned_search_path',
      (select prosecdef from pg_proc
        where proname='revoke_producer_place_access'
          and pg_get_function_arguments(oid) = 'p_actor_id uuid, p_membership_id uuid, p_reason text') = true
      and (select proconfig::text from pg_proc
            where proname='revoke_producer_place_access'
              and pg_get_function_arguments(oid) = 'p_actor_id uuid, p_membership_id uuid, p_reason text')
          like '%search_path=public%',
      'SECURITY DEFINER with pinned search_path'),
  (7, 'rpc_execute_service_role_only',
      has_function_privilege('service_role',
        'public.revoke_producer_place_access(uuid, uuid, text)', 'EXECUTE'),
      'service_role may EXECUTE'),
  (8, 'rpc_not_executable_by_anon',
      not has_function_privilege('anon',
        'public.revoke_producer_place_access(uuid, uuid, text)', 'EXECUTE'),
      'anon must NOT EXECUTE'),
  (9, 'rpc_not_executable_by_authenticated',
      not has_function_privilege('authenticated',
        'public.revoke_producer_place_access(uuid, uuid, text)', 'EXECUTE'),
      'authenticated must NOT EXECUTE'),
  (10, 'legacy_two_arg_overload_removed',
      (select count(*) from pg_proc where proname='revoke_producer_place_access') = 1,
      '0058 must drop the reason-less (uuid, uuid) overload');

-- ---------------------------------------------------------------------------
-- 2. Happy path: admin revokes a manager, audit + notifications (checks 11–17)
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin    uuid := 'cccccccc-1111-4000-8000-000000000001';
  v_manager  uuid := 'cccccccc-1111-4000-8000-000000000005';
  v_editor   uuid := 'cccccccc-1111-4000-8000-000000000006';
  v_owner1   uuid := 'cccccccc-1111-4000-8000-000000000003';
  v_reason   text := 'Akun tidak lagi memiliki kewenangan mengelola Tempat ini.';
  v_target   uuid;
  v_outcome  jsonb;
  v_audit    record;
  v_notif    record;
  v_body     text;
begin
  perform set_config('request.jwt.claims', '', false); -- no session: actor comes from p_actor_id

  select id into v_target from public.producer_memberships
   where user_id = v_manager and place_id = 'regress-revoke-a';

  v_outcome := public.revoke_producer_place_access(v_admin, v_target, v_reason);

  insert into admin_revoke_checks values
    (11, 'admin_revoke_returns_revoked',
        (v_outcome ->> 'ok')::boolean is true
        and v_outcome ->> 'status' = 'revoked'
        and (v_outcome ->> 'notified')::boolean is true
        and (v_outcome ->> 'managerless')::boolean is false
        and (v_outcome ->> 'managerCount')::integer = 3,
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
    (13, 'audit_attributes_actor_target_reason_result',
        v_audit.place_id = 'regress-revoke-a'
        and v_audit.actor_id = v_admin
        and v_audit.detail ->> 'target_user_id' = v_manager::text
        and v_audit.detail ->> 'role' = 'manager'
        and v_audit.detail ->> 'reason' = v_reason
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
        and v_body like '%tidak menentukan kepemilikan hukum%'
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
-- 3. KEBIJAKAN MANAGERLESS (checks 18–21): pengelola terakhir dapat dicabut,
--    Tempat tetap ada, penanda Produser basi dilepas, hasilnya tercatat.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin  uuid := 'cccccccc-1111-4000-8000-000000000001';
  v_owner1 uuid := 'cccccccc-1111-4000-8000-000000000003';
  v_lone   uuid := 'cccccccc-1111-4000-8000-000000000007';
  v_reason text := 'Intervensi administratif untuk melindungi pengguna atau integritas platform.';
  v_target uuid;
  v_outcome jsonb;
  v_pointer text;
  v_status  text;
  v_audit   record;
begin
  perform set_config('request.jwt.claims', '', false);

  -- 18. Selagi masih ada pengelola lain, penanda Produser TIDAK dilepas.
  select id into v_target from public.producer_memberships
   where user_id = v_owner1 and place_id = 'regress-revoke-a';
  perform public.revoke_producer_place_access(v_admin, v_target, v_reason);
  select producer_id into v_pointer from public.places where id = 'regress-revoke-a';
  insert into admin_revoke_checks values
    (18, 'other_managers_keep_producer_pointer',
        v_pointer = 'prod-admin-revoke-dev',
        'producer_id kept while a manager remains: ' || coalesce(v_pointer, 'NULL'));

  -- 19. Pengelola TERAKHIR pada Tempat C: pencabutan BERHASIL (tanpa 'last_owner').
  select id into v_target from public.producer_memberships
   where user_id = v_lone and place_id = 'regress-revoke-c';
  v_outcome := public.revoke_producer_place_access(v_admin, v_target, v_reason);

  insert into admin_revoke_checks values
    (19, 'last_manager_revoked_managerless',
        (v_outcome ->> 'ok')::boolean is true
        and v_outcome ->> 'status' = 'revoked'
        and (v_outcome ->> 'managerless')::boolean is true
        and (v_outcome ->> 'managerCount')::integer = 0
        and v_outcome ->> 'reason' = v_reason,
        v_outcome::text),
    (20, 'managerless_place_survives_with_pointer_released',
        exists (select 1 from public.places
                 where id = 'regress-revoke-c'
                   and producer_id is null
                   and publication_status = 'published'
                   and claim_status = 'unverified')
        and not exists (select 1 from public.producer_memberships where place_id = 'regress-revoke-c')
        and public.place_has_active_ownership('regress-revoke-c') = false,
        'Tempat C tersimpan tanpa pengelola, penanda dilepas, kembali dapat diklaim');

  select place_id, actor_id, detail
    into v_audit
    from public.place_audit
   where action = 'producer_place_access_revoked'
     and detail ->> 'membership_id' = v_target::text
   order by id desc limit 1;
  select publication_status into v_status from public.places where id = 'regress-revoke-c';

  insert into admin_revoke_checks values
    (21, 'managerless_revocation_audited_with_reason_and_outcome',
        v_audit.place_id = 'regress-revoke-c'
        and v_audit.actor_id = v_admin
        and v_audit.detail ->> 'reason' = v_reason
        and v_audit.detail ->> 'result' = 'revoked'
        and (v_audit.detail ->> 'managerless')::boolean is true
        and (v_audit.detail ->> 'producer_pointer_released')::boolean is true
        and (v_audit.detail ->> 'manager_count')::integer = 0
        and v_audit.detail ->> 'place_publication_status' = v_status
        and exists (select 1 from public.notifications
                     where user_id = v_lone and source_id = v_target::text),
        coalesce(v_audit.detail::text, 'no audit row'));
end $$;

-- ---------------------------------------------------------------------------
-- 4. ALASAN WAJIB (checks 22–23): permintaan tanpa alasan sah ditolak TANPA efek
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin   uuid := 'cccccccc-1111-4000-8000-000000000001';
  -- A membership that is still present at this point in the script: keeping the
  -- target distinct from the ones already revoked above is what makes "refused
  -- with no side effect" observable.
  v_survivor uuid := 'cccccccc-1111-4000-8000-000000000004';
  v_target  uuid;
  v_before_audit integer;
  v_before_notifs integer;
begin
  perform set_config('request.jwt.claims', '', false);

  select id into v_target from public.producer_memberships
   where user_id = v_survivor and place_id = 'regress-revoke-a';
  select count(*) into v_before_audit from public.place_audit;
  select count(*) into v_before_notifs from public.notifications;

  insert into admin_revoke_checks values
    (22, 'missing_or_malformed_reason_refused_without_side_effects',
        public.revoke_producer_place_access(v_admin, v_target, null) ->> 'status' = 'invalid_reason'
        and public.revoke_producer_place_access(v_admin, v_target, '') ->> 'status' = 'invalid_reason'
        and public.revoke_producer_place_access(v_admin, v_target, 'ab') ->> 'status' = 'invalid_reason'
        and public.revoke_producer_place_access(v_admin, v_target, repeat('x', 501)) ->> 'status' = 'invalid_reason'
        and (select count(*) from public.place_audit) = v_before_audit
        and (select count(*) from public.notifications) = v_before_notifs,
        'null / empty / too short / too long all refused with no write'),
    (23, 'refused_reason_leaves_membership_and_pointer_untouched',
        exists (select 1 from public.producer_memberships where id = v_target)
        and (select producer_id from public.places where id = 'regress-revoke-a') = 'prod-admin-revoke-dev',
        'membership row and places.producer_id untouched');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Idempotency, non-admin, unknown id, isolation (checks 24–30)
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin  uuid := 'cccccccc-1111-4000-8000-000000000001';
  v_nonadmin uuid := 'cccccccc-1111-4000-8000-000000000002';
  v_owner1 uuid := 'cccccccc-1111-4000-8000-000000000003';
  v_editor uuid := 'cccccccc-1111-4000-8000-000000000006';
  v_reason text := 'Akun melanggar ketentuan platform.';
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

  perform public.revoke_producer_place_access(v_admin, v_target, v_reason);
  select count(*) into v_before_notifications from public.notifications
   where source_type='producer_membership' and source_id = v_target::text;
  select count(*) into v_before_audit from public.place_audit
   where action='producer_place_access_revoked' and detail ->> 'membership_id' = v_target::text;

  v_second := public.revoke_producer_place_access(v_admin, v_target, v_reason);
  v_third  := public.revoke_producer_place_access(v_admin, v_target, v_reason);

  insert into admin_revoke_checks values
    (24, 'double_revoke_is_idempotent',
        (v_second ->> 'ok')::boolean is false
        and v_second ->> 'status' = 'already_revoked'
        and (v_third ->> 'status') = 'already_revoked',
        v_second::text),
    (25, 'idempotent_revoke_adds_no_audit_or_notification',
        (select count(*) from public.notifications
          where source_type='producer_membership' and source_id = v_target::text) = v_before_notifications
        and (select count(*) from public.place_audit
              where action='producer_place_access_revoked'
                and detail ->> 'membership_id' = v_target::text) = v_before_audit,
        'notifications/audit unchanged');

  begin
    perform public.revoke_producer_place_access(v_nonadmin, v_target, v_reason);
  exception when others then
    v_refused := true;
  end;

  insert into admin_revoke_checks values
    (26, 'non_admin_actor_refused',
        v_refused,
        'non-moderator p_actor_id must raise'),
    (27, 'unknown_membership_id_refused',
        public.revoke_producer_place_access(v_admin,
          '99999999-9999-4999-8999-999999999999', v_reason) ->> 'status' = 'invalid_target',
        'unknown id -> invalid_target');

  select m.place_id, m.role into v_cross
    from public.producer_memberships m
   where m.user_id = v_owner1 and m.place_id = 'regress-revoke-b';

  insert into admin_revoke_checks values
    (28, 'other_place_membership_untouched',
        v_cross.role = 'owner',
        'same Produser keeps the other Tempat membership'),
    (29, 'revoked_user_has_no_membership_left_on_that_place',
        not exists (select 1 from public.producer_memberships
                     where user_id = v_editor and place_id = 'regress-revoke-a'),
        'management gate reads this row and now finds nothing'),
    (30, 'unrelated_tables_untouched',
        (select count(*) from auth.users where id = v_editor) = 1
        and (select count(*) from public.users where id = v_editor) = 1
        and (select count(*) from public.producers where id = 'prod-admin-revoke-dev') = 1,
        'auth.users / public.users / producers intact');
end $$;

-- ---------------------------------------------------------------------------
-- 6. Client access boundary (checks 31–33)
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
      (31, 'anon_cannot_read_audit', false, 'anon read ' || v_rows || ' audit rows');
  exception when others then
    execute 'reset role';
    insert into admin_revoke_checks values (31, 'anon_cannot_read_audit', true, sqlerrm);
  end;

  -- authenticated cannot read the audit trail.
  execute 'set role authenticated';
  begin
    select count(*) into v_rows from public.place_audit;
    execute 'reset role';
    insert into admin_revoke_checks values
      (32, 'authenticated_cannot_read_audit', false, 'authenticated read ' || v_rows || ' audit rows');
  exception when others then
    execute 'reset role';
    insert into admin_revoke_checks values (32, 'authenticated_cannot_read_audit', true, sqlerrm);
  end;

  -- a client cannot forge a revocation notification.
  execute 'set role authenticated';
  begin
    insert into public.notifications (user_id, category, event_type, title, body)
    values ('cccccccc-1111-4000-8000-000000000003', 'system', 'palsu', 'x', 'y');
    execute 'reset role';
    insert into admin_revoke_checks values
      (33, 'client_cannot_create_notifications', false, 'client inserted a notification');
  exception when others then
    execute 'reset role';
    insert into admin_revoke_checks values (33, 'client_cannot_create_notifications', true, sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Result set (one row per check)
-- ---------------------------------------------------------------------------
select ord, check_name, passed, detail
from admin_revoke_checks
order by ord;

rollback;
