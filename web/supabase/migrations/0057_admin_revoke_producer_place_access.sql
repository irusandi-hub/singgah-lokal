-- 0057 — ADMIN: mencabut hak kelola Produser atas SATU Tempat (+ notifikasi).
--
-- GAP YANG DITUTUP
-- Platform Admin (Authority Master §5: "Producer membership") belum punya jalan
-- apa pun untuk mencabut hak kelola seorang Produser atas SATU Tempat. Satu-satunya
-- penulis producer_memberships hari ini adalah `review_place_claim('approved')`
-- (0028) yang MENAMBAH ownership. Tidak ada jalur pencabutan, tidak ada pengaman
-- "owner terakhir", dan tidak ada atribusi/notifikasi atas pencabutan.
--
-- ATURAN YANG DIPATUHI
-- - MASTER 09 §2/§13: tindakan admin harus diatribusikan ke identitas admin yang
--   terautentikasi dan dicatat (actor, action, target, waktu, hasil). Karena itu
--   RPC ini menulis ke `place_audit` (0031) yang sudah ada — bukan tabel baru —
--   dan dua nilai `action` baru ditambahkan ke CHECK-nya.
-- - MASTER 09 §3/§14: otorisasi di server, least privilege. RPC SECURITY DEFINER
--   dengan `search_path` dipin, EXECUTE hanya untuk service_role; anon dan
--   authenticated dicabut. Verifikasi admin DI DALAM fungsi (bukan hanya di route).
-- - MASTER 09 §18: klien harus memvalidasi ulang state sebelum mutasi; baris
--   target di-LOCK (`for update`) sehingga balapan antar-admin terserialisasi.
-- - MASTER 09 §19: idempoten. Pencabutan ulang tidak mengubah apa pun dan tidak
--   menggandakan notifikasi/audit.
-- - MASTER 10 §12/§17/§21: notifikasi idempoten (kunci dedup 0026), kegagalan
--   notifikasi TIDAK membatalkan perubahan bisnis (savepoint + warning), dan
--   kanal in-app tetap menjadi baseline.
-- - AGENTS.md: fail-closed, idempoten, tanpa GRANT ke anon, tanpa mematikan RLS.
--
-- NON-DESTRUKTIF & FORWARD-ONLY
-- - `producer_memberships` hanya DITAMBAH satu kolom surrogate `id` (+ unique
--   index). PK komposit `(user_id, place_id)` dari 0001 tetap, tidak ada kolom,
--   policy, atau baris yang diubah/dihapus.
-- - `place_audit` hanya diperluas CHECK `action`-nya (pola yang sudah dipakai
--   0036 dan 0039); trigger append-only, RLS tanpa policy, dan grant-nya tetap.
-- - Tidak menyentuh migrasi 0046–0056, tidak mengubah kebijakan Live
--   (`assert_viewer_eligible`, `admit_live_viewer`), dan tidak memberi GRANT
--   baru ke anon. Idempoten (aman dijalankan ulang).

-- ---------------------------------------------------------------------------
-- 1. Identitas membership (surrogate id)
-- ---------------------------------------------------------------------------
-- Kontrak tugas: klien HANYA mengirim membership id; server memuat barisnya dan
-- menurunkan Produser + Tempat dari database (id Produser/Tempat dari klien tidak
-- dipercaya). Tabel ini tidak punya kolom id, jadi satu kolom surrogate
-- ditambahkan: nilai default volatile diisi per baris oleh Postgres, lalu
-- dikunci oleh unique index.
alter table public.producer_memberships
  add column if not exists id uuid not null default gen_random_uuid();

create unique index if not exists producer_memberships_id_key
on public.producer_memberships (id);

comment on column public.producer_memberships.id is
  'Surrogate membership identity (0057). PK kanonik tetap (user_id, place_id); kolom ini hanya memberi satu id yang bisa dirujuk klien admin untuk tindakan pencabutan.';

-- ---------------------------------------------------------------------------
-- 2. Kosakata audit: dua action baru pada trail place_audit (0031)
-- ---------------------------------------------------------------------------
-- Daftar lengkap = kosakata 0039 + dua nilai pencabutan. Tidak ada nilai lama
-- yang dihapus, jadi setiap baris trail yang sudah ada tetap valid.
alter table public.place_audit drop constraint if exists place_audit_action_check;
alter table public.place_audit
  add constraint place_audit_action_check check (action in (
    -- Platform Admin Place operations (workspace).
    'admin_place_created',
    'admin_place_updated',
    'admin_place_published',
    'admin_place_paused',
    'admin_place_archived',
    'admin_place_restored',
    -- Platform Admin Place claim decisions (the single ownership path).
    'place_claim_approved',
    'place_claim_rejected',
    -- Tempat Pilihan promotion decisions (Stage 4; flag-only).
    'admin_place_curated',
    'admin_place_uncurated',
    -- Developer Authority (Creator-controlled; Dummy Place only).
    'developer_place_dummy_marked',
    'developer_place_dummy_cleared',
    'developer_place_curated',
    'developer_place_uncurated',
    -- Producer membership revocation (0057).
    'producer_place_access_revoked',
    'producer_place_access_revoke_denied'
  ));

-- Lookup idempotensi: "apakah membership id ini sudah pernah dicabut?" — dijawab
-- dari trail, bukan dari tabel yang barisnya sudah hilang. Partial expression
-- index supaya pencarian tidak menjadi sequential scan saat trail bertumbuh.
create index if not exists place_audit_revoked_membership_idx
on public.place_audit ((detail ->> 'membership_id'))
where action = 'producer_place_access_revoked';

-- ---------------------------------------------------------------------------
-- 3. RPC pencabutan (admin check + lock + pengaman + cabut + audit + notifikasi)
-- ---------------------------------------------------------------------------
-- p_actor_id: identitas admin yang sudah diverifikasi route lewat
--   requirePlatformModerator(). Kalau ada sesi (auth.uid() tidak null), nilai
--   sesi MENANG — pemanggil ber-sesi tidak pernah bisa memalsukan pelaku.
-- p_membership_id: SATU-SATUNYA masukan klien. Produser dan Tempat diturunkan
--   dari baris membership, tidak pernah dari input.
create or replace function public.revoke_producer_place_access(
  p_actor_id uuid,
  p_membership_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_membership public.producer_memberships;
  v_place_id text;
  v_place_name text;
  v_place_timezone text;
  v_producer_name text;
  v_role_label text;
  v_when text;
  v_owner_count integer;
  v_co_manager record;
  v_notified_count integer := 0;
  v_notification_error text;
  v_result text;
begin
  -- 3.1 Otorisasi DI DALAM fungsi (fail-closed). Bukan Platform Admin => tolak
  -- SEBELUM ada tulisan apa pun, sehingga pihak tak berwenang tidak bisa
  -- mencemari trail audit.
  v_actor := p_actor_id;
  if auth.uid() is not null then
    v_actor := auth.uid();
  end if;
  if v_actor is null then
    raise exception 'platform_admin_required';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_actor and u.platform_role = 'platform_moderator'
  ) then
    raise exception 'platform_admin_required';
  end if;

  if p_membership_id is null then
    raise exception 'membership_target_invalid';
  end if;

  -- 3.2 Muat + KUNCI baris target (race-safe). Dua admin yang mencabut baris yang
  -- sama terserialisasi di sini.
  select * into v_membership
  from public.producer_memberships m
  where m.id = p_membership_id
  for update;

  if not found then
    -- Batasi baris yang tidak ada: sudah pernah dicabut (idempoten) atau id salah.
    select a.place_id into v_place_id
    from public.place_audit a
    where a.action = 'producer_place_access_revoked'
      and a.detail ->> 'membership_id' = p_membership_id::text
    order by a.created_at desc, a.id desc
    limit 1;

    if v_place_id is not null then
      select p.name into v_place_name from public.places p where p.id = v_place_id;
      return jsonb_build_object(
        'ok', false,
        'status', 'already_revoked',
        'placeName', v_place_name,
        'notified', false,
        'message', 'Hak akses Pengelola untuk Tempat '
          || coalesce(v_place_name, v_place_id) || ' sudah dicabut sebelumnya.'
      );
    end if;

    return jsonb_build_object(
      'ok', false,
      'status', 'invalid_target',
      'placeName', null,
      'notified', false,
      'message', 'Data akses Pengelola tidak ditemukan.'
    );
  end if;

  v_place_id := v_membership.place_id;

  select p.name, p.timezone into v_place_name, v_place_timezone
  from public.places p where p.id = v_place_id;

  -- 3.3 Pengaman owner (P1, fail-closed): pencabutan yang akan membuat Tempat
  -- TANPA owner aktif DITOLAK. Hanya berlaku untuk baris role 'owner'.
  -- Kunci dulu semua baris owner Tempat ini dalam urutan deterministik supaya
  -- dua pencabutan owner yang berbeda tidak bisa saling mendahului.
  if v_membership.role = 'owner' then
    perform 1 from public.producer_memberships m
    where m.place_id = v_place_id and m.role = 'owner'
    order by m.user_id
    for update;

    select count(*)::integer into v_owner_count
    from public.producer_memberships m
    where m.place_id = v_place_id and m.role = 'owner';

    if v_owner_count <= 1 then
      -- Penolakan oleh admin yang SAH dan punya target Place => dicatat
      -- (MASTER 09 §13: actor, action, target, hasil, konteks). TANPA notifikasi.
      insert into public.place_audit (
        place_id, actor_id, action, before_data, after_data, detail
      ) values (
        v_place_id,
        v_actor,
        'producer_place_access_revoke_denied',
        null,
        null,
        jsonb_build_object(
          'membership_id', p_membership_id,
          'target_user_id', v_membership.user_id,
          'producer_id', v_membership.producer_id,
          'role', v_membership.role,
          'result', 'denied',
          'reason', 'last_owner'
        )
      );

      return jsonb_build_object(
        'ok', false,
        'status', 'last_owner',
        'placeName', v_place_name,
        'notified', false,
        'message', 'Tidak dapat dicabut: Tempat ini akan tanpa Pemilik. '
          || 'Tambahkan atau pindahkan Pemilik lain terlebih dahulu.'
      );
    end if;
  end if;

  -- 3.4 Label role sesuai istilah terkunci (docs/UI_TERMINOLOGY_STANDARD.md §2 +
  -- instruksi tugas): owner = Pemilik, manager = Pengelola, editor = Editor.
  v_role_label := case v_membership.role
    when 'owner' then 'Pemilik'
    when 'manager' then 'Pengelola'
    else 'Editor'
  end;

  select pr.display_name into v_producer_name
  from public.producers pr where pr.id = v_membership.producer_id;

  -- Waktu pencabutan dirender di zona waktu Tempat (AGENTS.md: Place timezone
  -- adalah sumber kebenaran) dan zona itu dinamai eksplisit.
  if v_place_timezone is null or btrim(v_place_timezone) = '' then
    v_when := to_char(now() at time zone 'UTC', 'DD/MM/YYYY HH24:MI') || ' (UTC)';
  else
    v_when := to_char(now() at time zone v_place_timezone, 'DD/MM/YYYY HH24:MI')
      || ' (' || v_place_timezone || ')';
  end if;

  -- 3.5 CABUT: hapus baris membership (mekanisme yang ada — tabel ini tidak
  -- punya kolom status). Pengaruhnya langsung pada request berikutnya karena
  -- setiap gate server & setiap policy RLS membaca baris ini, tanpa cache.
  delete from public.producer_memberships where id = p_membership_id;

  -- 3.6 NOTIFIKASI di dalam transaksi yang sama (P2), memakai penulis resmi
  -- `notify_recipient` (0029) sehingga gate preferensi + kunci dedup 0026
  -- berlaku apa adanya. MASTER 10 §17: kegagalan notifikasi TIDAK boleh
  -- membatalkan perubahan bisnis — savepoint + warning, lalu dicatat di audit.
  begin
    -- 3.6a Penerima WAJIB: Produser yang dicabut. Kategori `safety_account`
    -- (wajib, tidak bisa dimatikan lewat preferensi) sehingga selalu sampai.
    -- place_id NULL: penerima tidak lagi boleh mengelola Tempat itu, jadi tidak
    -- ada tautan ke Tempat (P7). Langkah lanjut hanya lewat kanal bantuan yang
    -- sudah ada di aplikasi.
    perform public.notify_recipient(
      v_membership.user_id,
      'safety_account',
      'producer_place_access_revoked',
      'Hak akses Tempat dicabut',
      'Admin Singgah Lokal mencabut hak akses ' || v_role_label
        || ' kamu atas Tempat ' || coalesce(v_place_name, v_place_id)
        || ' pada ' || v_when || '.'
        || ' Kamu tidak lagi bisa mengelola Tempat itu.'
        || ' Akun dan Tempat lain yang kamu kelola tidak berubah.'
        || ' Jika kamu merasa ini keliru, hubungi kami lewat menu Bantuan di aplikasi.',
      null,
      'producer_membership',
      p_membership_id::text,
      jsonb_build_object(
        'membership_id', p_membership_id,
        'place_id', v_place_id,
        'producer_id', v_membership.producer_id,
        'role', v_membership.role,
        'revoked_by', 'platform_admin'
      )
    );

    -- 3.6b Penerima tambahan: owner/manager AKTIF LAIN di Tempat yang sama,
    -- supaya susunan pengelola yang berubah diketahui. Editor TIDAK diberi
    -- notifikasi (tidak ada master yang mewajibkannya). Isi sengaja TANPA email/
    -- kontak/ID internal Produser yang dicabut (MASTER 10 §14) dan tanpa detail
    -- internal admin.
    for v_co_manager in
      select distinct m.user_id
      from public.producer_memberships m
      where m.place_id = v_place_id
        and m.role in ('owner', 'manager')
        and m.user_id <> v_membership.user_id
    loop
      perform public.notify_recipient(
        v_co_manager.user_id,
        'system',
        'producer_place_management_changed',
        'Susunan pengelola Tempat berubah',
        coalesce(v_producer_name, 'Seorang pengelola') || ' tidak lagi mengelola Tempat '
          || coalesce(v_place_name, v_place_id) || ' sebagai ' || v_role_label
          || ' pada ' || v_when || '.',
        v_place_id,
        'producer_membership',
        p_membership_id::text,
        jsonb_build_object(
          'membership_id', p_membership_id,
          'place_id', v_place_id,
          'role', v_membership.role
        )
      );
    end loop;
  exception when others then
    v_notification_error := sqlerrm;
    raise warning 'producer_access_revocation_notification_failed: %', sqlerrm;
  end;

  select count(*)::integer into v_notified_count
  from public.notifications n
  where n.source_type = 'producer_membership'
    and n.source_id = p_membership_id::text;

  v_result := case
    when v_notification_error is null and v_notified_count >= 1 then 'revoked'
    else 'revoked_notification_failed'
  end;

  -- 3.7 AUDIT: satu baris append-only dengan pelaku = admin sendiri, target =
  -- Tempat + detail membership, hasil, dan konteks. Kalau tulisan ini gagal,
  -- seluruh transaksi (termasuk pencabutan) dibatalkan — perubahan tanpa trail
  -- adalah persis yang dilarang MASTER 09 §2/§13.
  insert into public.place_audit (
    place_id, actor_id, action, before_data, after_data, detail
  ) values (
    v_place_id,
    v_actor,
    'producer_place_access_revoked',
    jsonb_build_object(
      'membership_id', p_membership_id,
      'user_id', v_membership.user_id,
      'producer_id', v_membership.producer_id,
      'place_id', v_membership.place_id,
      'role', v_membership.role
    ),
    null,
    jsonb_build_object(
      'membership_id', p_membership_id,
      'target_user_id', v_membership.user_id,
      'producer_id', v_membership.producer_id,
      'role', v_membership.role,
      'result', v_result,
      'notification_error', v_notification_error,
      'notifications_written', v_notified_count
    )
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'revoked',
    'placeName', v_place_name,
    'producerName', v_producer_name,
    'role', v_membership.role,
    'notified', v_notification_error is null,
    'notificationsWritten', v_notified_count,
    'message', case
      when v_notification_error is null
        then 'Hak akses Pengelola dicabut dan notifikasi sudah dikirim.'
      else 'Hak akses Pengelola dicabut, tetapi notifikasi gagal dikirim.'
    end
  );
end;
$$;

-- Least privilege (pola 0028/0055/0056): tidak ada klien yang boleh memanggil
-- RPC ini. Hanya service_role (server code setelah requirePlatformModerator()).
revoke all on function public.revoke_producer_place_access(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_producer_place_access(uuid, uuid) to service_role;
