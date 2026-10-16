-- 0058 — KEBIJAKAN PENGELOLAAN DIGITAL: Tempat boleh berdiri tanpa Pengelola.
--
-- ATURAN PRODUK YANG DITEGAKKAN (permanen)
-- A. Peran di aplikasi = kewenangan digital, BUKAN kepemilikan hukum. Peran
--    'owner' tidak pernah menetapkan, menjamin, atau memindahkan kepemilikan
--    nyata atas Tempat.
-- B. Platform Admin dapat mencabut kewenangan pengelolaan digital seorang akun
--    atas SATU Tempat berdasarkan kebijakan platform dan Ketentuan Penggunaan,
--    TANPA wajib menunjuk pengelola pengganti.
-- C. Tempat tanpa Pengelola digital adalah keadaan yang SAH: dapat tetap
--    tersimpan/terbit, atau diarsipkan. Tempat dan riwayatnya tidak dihapus.
-- D. Pencabutan berlaku pada SEMUA jalur otorisasi: baris
--    `producer_memberships` (satu-satunya sumber kewenangan kelola — dibaca
--    oleh gate server, RPC, dan setiap policy RLS) hilang, dan penanda
--    `places.producer_id` tidak lagi bisa dipakai sebagai jalur alternatif.
-- E. Mencabut satu pengelola tidak mengubah Tempat lain, membership lain, isi
--    Tempat, Kegiatan, catatan kunjungan, atau riwayat administrasi.
--
-- YANG DIUBAH DARI 0057 (forward-only; 0057 tidak pernah diedit)
-- 1. PENGAMAN "owner terakhir" DIHAPUS. 0057 menolak pencabutan yang akan
--    meninggalkan Tempat tanpa owner aktif (`status: 'last_owner'`). Aturan C
--    menyatakan keadaan tanpa pengelola itu sah, jadi penolakan itu DICABUT dan
--    diganti dengan penetapan keadaan managerless yang aman dan tercatat.
--    Nilai audit 'producer_place_access_revoke_denied' tetap ada di CHECK
--    `place_audit` supaya baris trail lama tetap valid — 0058 sendiri tidak
--    pernah menulisnya lagi.
-- 2. ALASAN PENCABUTAN WAJIB (`p_reason`, 3–500 karakter). Tanpa alasan yang
--    sah, RPC menolak SEBELUM menyentuh data (fail closed) dan tidak menulis
--    apa pun. Alasan dicatat di trail audit.
-- 3. SERIALISASI PER-TEMPAT (`pg_advisory_xact_lock` pada place_id). Dua
--    pencabutan pada Tempat yang SAMA tidak dapat saling mendahului: tanpa itu,
--    dua transaksi dapat sama-sama menghitung "masih ada 1 pengelola" dan
--    sama-sama meninggalkan penanda Produser yang basi. Kunci baris target
--    (`for update`) tetap dipakai untuk pencabutan ganda atas baris yang sama.
-- 4. PELEPASAN PENANDA PRODUSER. Bila setelah pencabutan Tempat tidak lagi
--    punya SATU pun membership, dan `places.producer_id` menunjuk Produser yang
--    barusan dicabut, penanda itu dilepas menjadi NULL. Ini yang membuat Tempat
--    benar-benar managerless: `place_has_active_ownership` (0028) kembali false,
--    sehingga Tempat dapat diklaim ulang lewat PROSES RESMI klaim — bukan
--    dibiarkan terkunci pada Produser yang sudah tidak berwenang. Informasi
--    historisnya tidak hilang: snapshot membership (user, producer, role) dan
--    nilai penanda sebelum/sesudah tersimpan permanen di `place_audit`.
--
-- SIGNAtUR RPC BERUBAH (uuid, uuid) -> (uuid, uuid, text). Fungsi lama DILEPAS:
-- dua overload dengan nama sama akan ambigu, dan membiarkan versi tanpa alasan
-- berarti aturan "alasan wajib" dapat dilangkahi. URUTAN DEPLOY: terapkan 0058
-- SEBELUM men-deploy kode aplikasi yang memanggilnya (lihat runbook).
--
-- NON-DESTRUKTIF & FORWARD-ONLY
-- - Tidak ada tabel/kolom yang dihapus. Satu-satunya DELETE tetap baris
--   membership yang dicabut; satu-satunya UPDATE adalah pelepasan penanda
--   Produser yang dijelaskan di atas.
-- - `producer_memberships` (kolom id dari 0057), `place_audit` (append-only,
--   RLS tanpa policy), dan seluruh migrasi 0046–0057 tidak disentuh.
-- - Tidak ada GRANT baru ke anon; EXECUTE tetap hanya untuk service_role.
-- - Idempoten: aman dijalankan ulang.

-- ---------------------------------------------------------------------------
-- 1. RPC pencabutan v2 — kebijakan managerless
-- ---------------------------------------------------------------------------
drop function if exists public.revoke_producer_place_access(uuid, uuid);

create or replace function public.revoke_producer_place_access(
  p_actor_id uuid,
  p_membership_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid;
  v_reason text;
  v_membership public.producer_memberships;
  v_place_id text;
  v_place_name text;
  v_place_timezone text;
  v_place_producer_id text;
  v_place_publication text;
  v_producer_name text;
  v_role_label text;
  v_when text;
  v_remaining integer := 0;
  v_pointer_released boolean := false;
  v_co_manager record;
  v_notified_count integer := 0;
  v_notification_error text;
  v_result text;
begin
  -- 1.1 Otorisasi DI DALAM fungsi (fail-closed). Bukan Platform Admin => tolak
  -- SEBELUM ada tulisan apa pun. Sesi (auth.uid()) selalu menang atas
  -- p_actor_id, sehingga pemanggil ber-sesi tidak bisa memalsukan pelaku.
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

  -- 1.2 Alasan WAJIB (kebijakan B). Divalidasi server-side, sebelum data apa
  -- pun disentuh, dan tanpa menulis baris audit (tidak ada target yang sah).
  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    return jsonb_build_object(
      'ok', false,
      'status', 'invalid_reason',
      'placeName', null,
      'producerName', null,
      'role', null,
      'reason', null,
      'notified', false,
      'managerCount', null,
      'managerless', null,
      'placePublicationStatus', null,
      'message', 'Alasan pencabutan wajib diisi (3–500 karakter).'
    );
  end if;

  if p_membership_id is null then
    return jsonb_build_object(
      'ok', false,
      'status', 'invalid_target',
      'placeName', null,
      'producerName', null,
      'role', null,
      'reason', null,
      'notified', false,
      'managerCount', null,
      'managerless', null,
      'placePublicationStatus', null,
      'message', 'Data akses Pengelola tidak ditemukan.'
    );
  end if;

  -- 1.3 Muat baris target TANPA kunci, semata untuk mengetahui Tempat-nya.
  select * into v_membership
  from public.producer_memberships m
  where m.id = p_membership_id;

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
        'producerName', null,
        'role', null,
        'reason', null,
        'notified', false,
        'managerCount', null,
        'managerless', null,
        'placePublicationStatus', null,
        'message', 'Hak akses Pengelola untuk Tempat '
          || coalesce(v_place_name, v_place_id) || ' sudah dicabut sebelumnya.'
      );
    end if;

    return jsonb_build_object(
      'ok', false,
      'status', 'invalid_target',
      'placeName', null,
      'producerName', null,
      'role', null,
      'reason', null,
      'notified', false,
      'managerCount', null,
      'managerless', null,
      'placePublicationStatus', null,
      'message', 'Data akses Pengelola tidak ditemukan.'
    );
  end if;

  v_place_id := v_membership.place_id;

  -- 1.4 SERIALISASI PER-TEMPAT (aturan D–E). Semua pencabutan untuk Tempat yang
  -- sama berjalan satu per satu, sehingga hitungan sisa pengelola dan pelepasan
  -- penanda Produser tidak pernah berlomba. Kunci dilepas otomatis di akhir
  -- transaksi.
  perform pg_advisory_xact_lock(hashtext('revoke_producer_place_access:' || v_place_id));

  -- 1.5 Baca ulang + KUNCI baris target (idempotensi pencabutan ganda baris yang
  -- sama; 0020 menjamin satu baris per (user, place)).
  select * into v_membership
  from public.producer_memberships m
  where m.id = p_membership_id
  for update;

  if not found then
    select p.name into v_place_name from public.places p where p.id = v_place_id;
    return jsonb_build_object(
      'ok', false,
      'status', 'already_revoked',
      'placeName', v_place_name,
      'producerName', null,
      'role', null,
      'reason', null,
      'notified', false,
      'managerCount', null,
      'managerless', null,
      'placePublicationStatus', null,
      'message', 'Hak akses Pengelola untuk Tempat '
        || coalesce(v_place_name, v_place_id) || ' sudah dicabut sebelumnya.'
    );
  end if;

  select p.name, p.timezone, p.producer_id, p.publication_status
    into v_place_name, v_place_timezone, v_place_producer_id, v_place_publication
  from public.places p where p.id = v_place_id;

  -- Label role sesuai istilah terkunci (docs/UI_TERMINOLOGY_STANDARD.md §2).
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

  -- 1.6 CABUT: hapus baris membership. Tabel ini tidak punya kolom status, dan
  -- SETIAP gate server maupun policy RLS membaca baris ini tanpa cache — jadi
  -- kewenangan hilang seketika pada request berikutnya (aturan D).
  delete from public.producer_memberships where id = p_membership_id;

  select count(*)::integer into v_remaining
  from public.producer_memberships m
  where m.place_id = v_place_id;

  -- 1.7 KEADAAN MANAGERLESS (aturan C). Bila Tempat tidak lagi punya satu pun
  -- pengelola dan penanda Produser masih menunjuk Produser yang barusan dicabut,
  -- penanda dilepas. Tempat TETAP ADA (tidak dihapus, tidak diarsipkan otomatis),
  -- isi dan riwayatnya utuh, dan jalur pemulihannya adalah proses klaim resmi —
  -- bukan penunjukan pengganti yang dipaksakan.
  if v_remaining = 0
     and v_place_producer_id is not null
     and v_place_producer_id = v_membership.producer_id then
    update public.places
       set producer_id = null,
           updated_at = now()
     where id = v_place_id;
    v_pointer_released := true;
  end if;

  -- 1.8 NOTIFIKASI di dalam transaksi yang sama, memakai penulis resmi
  -- `notify_recipient` (0029) sehingga gate preferensi + kunci dedup 0026
  -- berlaku apa adanya. MASTER 10 §17: kegagalan notifikasi TIDAK boleh
  -- membatalkan perubahan bisnis — savepoint + warning, lalu dicatat di audit.
  begin
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
        || ' Pencabutan ini hanya berlaku pada kewenangan pengelolaan digital di platform'
        || ' dan tidak menentukan kepemilikan hukum atas Tempat.'
        || ' Jika kamu merasa ini keliru, ajukan peninjauan lewat menu Bantuan di aplikasi.',
      null,
      'producer_membership',
      p_membership_id::text,
      jsonb_build_object(
        'membership_id', p_membership_id,
        'place_id', v_place_id,
        'producer_id', v_membership.producer_id,
        'role', v_membership.role,
        'revoked_by', 'platform_admin',
        'reason', v_reason
      )
    );

    -- Penerima tambahan: owner/manager AKTIF LAIN di Tempat yang sama. Editor
    -- TIDAK diberi notifikasi. Isi sengaja TANPA email/kontak/ID internal
    -- Produser yang dicabut (MASTER 10 §14) dan tanpa detail internal admin.
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

  -- 1.9 AUDIT: satu baris append-only dengan pelaku = admin sendiri, Tempat,
  -- akun/membership, ALASAN, waktu, dan hasil operasi (aturan B + MASTER 09
  -- §13). Kalau tulisan ini gagal, seluruh transaksi (termasuk pencabutan)
  -- dibatalkan — perubahan tanpa trail adalah yang dilarang.
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
      'role', v_membership.role,
      'place_producer_id', v_place_producer_id,
      'membership_count', v_remaining + 1
    ),
    jsonb_build_object(
      'producer_id', case when v_pointer_released then null else v_place_producer_id end,
      'membership_count', v_remaining
    ),
    jsonb_build_object(
      'membership_id', p_membership_id,
      'target_user_id', v_membership.user_id,
      'producer_id', v_membership.producer_id,
      'role', v_membership.role,
      'reason', v_reason,
      'result', v_result,
      'manager_count', v_remaining,
      'managerless', v_remaining = 0,
      'producer_pointer_released', v_pointer_released,
      'place_publication_status', v_place_publication,
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
    'reason', v_reason,
    'notified', v_notification_error is null,
    'notificationsWritten', v_notified_count,
    'managerCount', v_remaining,
    'managerless', v_remaining = 0,
    'placePublicationStatus', v_place_publication,
    'message', case
      when v_notification_error is not null
        then 'Hak akses Pengelola dicabut, tetapi notifikasi gagal dikirim.'
      when v_remaining = 0
        then 'Hak akses Pengelola dicabut dan notifikasi sudah dikirim. Tempat ini sekarang tanpa Pengelola aktif.'
      else 'Hak akses Pengelola dicabut dan notifikasi sudah dikirim.'
    end
  );
end;
$$;

comment on function public.revoke_producer_place_access(uuid, uuid, text) is
  'Kebijakan pengelolaan digital (0058): Platform Admin mencabut kewenangan kelola digital satu akun atas satu Tempat. Alasan wajib. Tempat boleh tetap ada tanpa Pengelola aktif; penanda places.producer_id dilepas bila Tempat kehilangan pengelola terakhir, sehingga Tempat dapat diklaim ulang lewat proses klaim resmi. Tidak ada pengelola pengganti yang dipaksakan.';

-- Least privilege (pola 0028/0055/0056/0057): tidak ada klien yang boleh
-- memanggil RPC ini. Hanya service_role (server code setelah
-- requirePlatformModerator()).
revoke all on function public.revoke_producer_place_access(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.revoke_producer_place_access(uuid, uuid, text) to service_role;
