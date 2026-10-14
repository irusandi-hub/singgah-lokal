# ADMIN-REVOKE — Platform Admin mencabut hak kelola Produser atas SATU Tempat

Date: 2026-10-14
Branch: `feat/admin-revoke-producer-place-access`
Base: `fix/live-operator-least-privilege` (tip of the still-open stack PR #40→#44;
#40 has base `main`). This task's PR is stacked on the same tip because none of
#40–#44 is merged yet.

Sources read before coding: `AGENTS.md`, `docs/masters/MASTER_INDEX_v1.0.md`,
`MASTER_AUTHORITY_STRUCTURE_v1.0.md`, MASTER 09 (Platform Admin/Moderation &
Governance), MASTER 10 (Notification & Communication), MASTER 08 (Producer App),
`docs/UI_TERMINOLOGY_STANDARD.md`, `docs/HANDOFF_LIVE_MVP.md`,
`docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md`, `docs/audits/LIVE_OPERATOR_BOUNDARY_AUDIT.md`,
and the code/migrations listed under §1–§6.

---

## 1. Relasi kanonik akun ↔ produser ↔ Tempat ↔ membership

| Objek | Bukti |
| --- | --- |
| `auth.users` (Supabase Auth) → `public.users` | `web/supabase/migrations/0001_visit_intent_foundation.sql:1` (`handle_new_user()` trigger; `public.users.id` FK → `auth.users(id)`) |
| `public.users` N:M `public.places` via `producer_memberships` | `0001_visit_intent_foundation.sql:81` — `create table public.producer_memberships (user_id uuid …, producer_id text …, place_id text …, role text …, created_at, primary key (user_id, place_id))` |
| **Satu baris = satu membership** | PK komposit `(user_id, place_id)`; tidak ada kolom `status` dan **tidak ada kolom `id`** |
| `producer_memberships.producer_id` → `public.producers(id)` | FK `on delete cascade` (0001) |
| `places.producer_id` → `public.producers(id)`, nullable | `0001`; Admin Place dibuat dengan `producer_id = null` (`web/lib/admin/place-workspace.ts:createAdminPlace`) |
| Arti role | CHECK `role in ('owner','manager','editor')` (0001). MASTER 08 §3: *Owner* = kendali penuh atas akun Produser, Tempat, konten, Visit Intent, AI, dan akses tim; *Manager* = kendali operasional/konten untuk Tempat yang ditugaskan. `web/lib/producer.ts`: `canEditPlace` (ketiganya), `canPublishPlace` (owner/manager), `canManagePlace` (owner/manager; editor **tidak** mengelola). |
| RLS membership | `0001`: `alter table public.producer_memberships enable row level security` + satu policy `memberships_self_read for select using (user_id = auth.uid())`. **Tidak ada** policy INSERT/UPDATE/DELETE → klien tidak bisa menulis; penulisan hanya lewat service role / RPC SECURITY DEFINER. |

## 2. Aturan kepemilikan/transfer; konsep "owner terakhir"

| Pertanyaan | Bukti | Jawaban |
| --- | --- | --- |
| Predikat kepemilikan kanonik | `0028_place_claims.sql:105` — `public.place_has_active_ownership(p_place_id)` = `exists(producer_memberships untuk place itu)` **atau** `places.producer_id is not null` | Satu definisi, dipakai gate klaim |
| Siapa yang memberi ownership | `0028` — hanya `review_place_claim(p_decision='approved')` yang meng-INSERT baris `producer_memberships` role `owner`. Tidak ada alur lain. | Klaim = satu-satunya jalur ownership saat ini |
| Alur transfer kepemilikan | **Tidak ada.** Tidak ada RPC/route/UI "transfer kepemilikan". | Sesuai larangan tugas: jangan membuat alur transfer |
| Konsep "owner terakhir" di kode/migration | **Tidak ada.** Tidak ada trigger, constraint, atau RPC yang menjaga minimal satu owner | Ini celah yang ditutup dengan **Policy Decision P1** (fail-closed) |
| Asumsi "Place selalu punya owner" | **Salah.** `createAdminPlace` sengaja membuat Tempat **tanpa** owner (`producer_id = null`, tanpa membership) agar bisa diklaim. | P1 diberlakukan hanya sebagai pengaman *pencabutan*: tidak boleh *membuat* Tempat kehilangan owner, bukan "Place harus punya owner" |

## 3. Membership dihapus (DELETE) atau ditandai (status)?

**DELETE.** `producer_memberships` (0001) tidak punya kolom `status`/`revoked_at`;
satu-satunya mekanisme yang ada adalah menghapus baris. Tidak ada migrasi
0046–0056 yang menambah kolom status ke tabel ini. `live_operators` memakai
`revoked_at`, tetapi itu entitas **berbeda** dan tidak boleh disamakan
(`docs/audits/LIVE_OPERATOR_BOUNDARY_AUDIT.md` H1). Karena itu pencabutan =
`DELETE FROM public.producer_memberships WHERE …`, memakai mekanisme yang ada.

## 4. Jalur kelola Tempat yang bergantung pada membership — dan apakah dicek di SERVER tiap request

Semuanya membaca baris `producer_memberships` secara langsung, **tanpa cache**,
sehingga pencabutan berlaku pada request berikutnya:

| Jalur | Bukti | Dicek server? |
| --- | --- | --- |
| `requireProducerAccess(request, placeId, roles)` | `web/lib/auth/server.ts` | Ya — query membership per request |
| `resolvePlaceManagerAuthority` / `decideLiveOperateAuthority` | `web/lib/live/operator-authorization.ts` | Ya — query membership per request, tanpa cache (komentar modul eksplisit) |
| `GET /api/producer/visit-intents` | `web/app/api/producer/visit-intents/route.ts` | Ya — filter membership owner/manager di server |
| `GET /api/auth/producer-session` | `web/app/api/auth/producer-session/route.ts` | Ya — hanya untuk visibilitas navigasi; otorisasi tetap di route Producer |
| RLS `places_public_read`, `experiences_public_read`, `schedules_public_read`, `visit_intents_producer_read/update`, `visit_intent_history_read` | `0001:202-223` | Ya — policy mengevaluasi `producer_memberships` dengan `auth.uid()` pada tiap statement |
| `canManagePlace` (pure) | `web/lib/producer.ts` | Tidak memutuskan sendiri — `access` di-resolve server-side oleh `requireProducerAccess` |

**Jalur yang diperiksa tanpa membership:** tidak ditemukan jalur kelola Tempat
yang hanya mengandalkan autentikasi. (Audit sebelumnya sudah menutup
`/producer` dan `/producer/visit-intents` untuk operator-only di PR #44.)
Tidak ada jalur baru yang perlu ditutup untuk task ini; pengaman tambahan yang
dipasang di sini adalah **deny-by-default di RPC** (jika baris membership sudah
tidak ada, seluruh RPC menolak).

## 5. Dampak turunan ke data lain (FK / cascade) — catatan

- `producer_memberships` adalah **anak** dari `users`, `producers`, dan `places`;
  menghapus satu baris membership **tidak** meng-cascade apa pun. Tidak ada tabel
  lain yang memiliki FK ke `producer_memberships`.
- `places.producer_id` adalah kolom terpisah dan **tidak** diubah oleh fitur ini.
  Jadi setelah pencabutan, sebuah Tempat bisa tetap punya `places.producer_id`
  (sinyal ownership kanonik 0028) tetapi tanpa akun pengelola.
- `live_operators` (Operator Live) **independen** dari membership (H1 audit batas
  Live): operator tidak kehilangan akses Live karena pencabutan membership.
- Data lain (auth.users, public.users, producers, places, experiences,
  visit_intents) tidak disentuh; dibuktikan dengan hitung baris sebelum/sesudah
  di `web/tests/admin-revoke-place-access.test.ts`.

## 6. Notifikasi — infrastruktur yang ada (dipakai apa adanya, tanpa sistem baru)

| Aspek | Bukti |
| --- | --- |
| Tabel | `public.notifications` — `0025_notifications.sql`: `id, user_id, category (6 nilai), event_type, title, body, place_id, source_type, source_id, metadata, read_at, created_at`; CHECK `(source_type is null) = (source_id is null)` |
| Dedup/idempotensi | `0026_live_followed_notifications.sql`: unique index `notifications_dedup_idx (user_id, source_type, source_id, event_type)` |
| Penulis (fan-out) | `0029_notification_fanout.sql`: **satu** penulis server-side `public.notify_recipient(user_id, category, event_type, title, body, place_id, source_type, source_id, metadata)` SECURITY DEFINER — menerapkan gate preferensi + `on conflict … do nothing`; `revoke all … from public, anon, authenticated` |
| Siapa yang boleh menulis | Hanya fungsi DB / service role. Klien tidak punya INSERT (0025: `grant select` + `grant update (read_at)` saja) |
| RLS baca/tulis | `notifications_self_read` (`user_id = auth.uid()`), `notifications_self_update_read_at` + trigger `guard_notifications_client_update` (hanya `read_at` yang boleh berubah oleh penerima) |
| Preferensi | `0024 notification_preferences` — 6 kategori; `safety_account` **wajib** (tidak bisa dimatikan); gate di `notify_recipient` |
| Realtime unread | `0029` `broadcast_notification_unread` + `notifications_realtime_receive` (topic `notifications:{auth.uid()}`); publikasi tabel oleh `0030` |
| Halaman | `web/app/notifications/page.tsx` + `web/components/notification-inbox-item.tsx` — render **generik** (title/body/waktu + opsional tautan Place via `resolveNotificationHref`), tanpa switch per `event_type` ⇒ tipe baru tidak butuh UI baru |
| Saluran lain | Email/push **belum** diimplementasikan (MASTER 10 §4 menyebut opsional/future) ⇒ tidak ada yang perlu dipanggil |

**Kesimpulan §6:** tabel notifikasi **bisa ditulis oleh fungsi DB**, jadi
notifikasi dicabut **di dalam transaksi RPC yang sama** (pola 0026/0029), dengan
`notify_recipient` sebagai penulis. Ini **Policy Decision P2**.

---

## 7. Celah (gap) yang ditemukan

1. **G1 — Tidak ada aksi cabut.** `/admin/producer-membership` (Data Pengelola)
   hanya menampilkan relasi (`AdminPengelolaTable`) — tidak ada kontrol untuk
   mencabut hak kelola seorang Produser atas satu Tempat. Ini inti task.
2. **G2 — Tidak ada identitas membership.** `producer_memberships` tidak punya
   kolom `id`; PK komposit `(user_id, place_id)`. Kontrak tugas ("klien hanya
   mengirim membership id") memerlukan **surrogate id** → migrasi 0057
   (aditif, forward-only, default `gen_random_uuid()` + unique index).
3. **G3 — Tidak ada pengaman "owner terakhir".** Tidak ada trigger/constraint yang
   mencegah pencabutan membuat Tempat tanpa owner aktif → pengaman fail-closed
   **P1** di dalam RPC.
4. **G4 — Tidak ada audit trail khusus membership.** Trailer audit Admin yang ada
   adalah `place_audit` (0031): append-only, RLS tanpa policy, `actor_id NOT NULL`,
   `action` ber-CHECK, `detail jsonb`. Digunakan apa adanya; CHECK `action`
   diperluas dengan dua nilai baru (0057). Ini **Policy Decision P3**.
5. **G5 — Tidak ada event notifikasi "akses dicabut".** MASTER 10 §6 punya
   "Moderation action" (Producer/Admin) dan "Security/account alert"
   (Affected account). Event baru dibangun di atas `notify_recipient`, kategori
   yang sudah ada. **P4**.
6. **G6 (temuan, bukan bug task ini)** — Otoritas Operator Live **tidak** bergantung
   pada membership yang dicabut (H1). Maka sesuai instrumen task (d), Operator
   Live **tidak** dinotifikasi; dicatat sebagai temuan di sini.
7. **G7 (temuan)** — `places.producer_id` tetap menunjuk produser setelah
   pencabutan sehingga `place_has_active_ownership` bisa tetap `true` walau tak ada
   akun pengelola. Dicatat sebagai batasan; fitur ini **tidak** mengubah
   `places.producer_id` (bukan bagian dari hak kelola, dan mengubahnya berarti
   menyentuh consent pemilik/klaim).

---

## 8. Rencana implementasi (dan file/objek DB)

| # | Perubahan |
| --- | --- |
| A | `web/supabase/migrations/0057_admin_revoke_producer_place_access.sql` (baru, forward-only): (a) surrogate `producer_memberships.id uuid not null default gen_random_uuid()` + unique index; (b) perluas CHECK `place_audit.action` dengan `producer_place_access_revoked` & `producer_place_access_revoke_denied`; (c) expression index untuk lookup idempotensi; (d) RPC SECURITY DEFINER `revoke_producer_place_access(p_actor_id uuid, p_membership_id uuid)` yang memverifikasi admin di dalam DB, mengunci baris, menerapkan pengaman owner, mencabut, menulis audit, dan mengirim notifikasi dalam satu transaksi; `revoke all … from public, anon, authenticated` + `grant execute … to service_role` |
| B | `web/lib/admin/producer-membership-revoke.ts` (baru): pemetaan hasil RPC → kode/message Indonesia; **tidak** menyentuh `lib/admin/queries.ts` (yang dikunci tepat satu `createSupabaseServiceClient()`) |
| C | `web/app/api/admin/producer-memberships/[membershipId]/revoke/route.ts` (baru): `requirePlatformModerator()` → panggil RPC → status/label Indonesia |
| D | `web/lib/admin/queries.ts`: `AdminProducerPlaceRow.membershipId` + `select("id, …")` |
| E | `web/app/admin/producer-membership/AdminPengelolaTable.tsx`: kolom aksi + dialog konfirmasi (komponen klien baru `RevokeProducerAccessAction.tsx`) |
| F | `web/lib/place-audit-format.ts`: dua action baru + label Indonesia |
| G | Tes: `web/tests/admin-revoke-place-access.test.ts` (PGlite, perilaku nyata), `web/tests/admin-revoke-place-access-ui.test.ts` (kontrak UI/route), `web/tests/db-regression/admin-revoke-place-access.sql` (result set `ord, check_name, passed, detail`) |
| H | `docs/HANDOFF_LIVE_MVP.md`, `docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md` (langkah DEV + NOT RUN) |

---

## 9. Matriks role × kondisi (perilaku akhir)

| Role/aktor | Kondisi baris target | Hasil |
| --- | --- | --- |
| Platform Admin (`platform_moderator`) | role `owner`, >1 owner di Tempat | **DICABUT** + audit + notifikasi |
| Platform Admin | role `owner`, **owner terakhir** | **DITOLAK** (`last_owner`) + audit penolakan, **tanpa** notifikasi |
| Platform Admin | role `manager` / `editor` | **DICABUT** + audit + notifikasi |
| Platform Admin | membership id tidak ada & tak pernah dicabut | **DITOLAK** (`invalid_target`) + audit penolakan |
| Platform Admin | membership sudah dicabut (idempoten) | **SUDAH DICABUT** (tanpa efek samping, tanpa audit kedua, **tanpa** notifikasi ganda) |
| Pengguna terautentikasi biasa / Produser / owner Tempat itu / developer/Creator tanpa `platform_moderator` | apa pun | **DITOLAK** (route 403; RPC tanpa EXECUTE grant → `permission denied`) |
| Anon (belum masuk) | apa pun | **DITOLAK** (route 403/redirect; RPC tanpa grant) |
| Service role tanpa admin valid (`p_actor_id` non-moderator) | apa pun | **DITOLAK** (`platform_admin_required` di dalam DB) |

## 10. Matriks penerima notifikasi

| Penerima | Diberi notifikasi? | Kategori | `event_type` | Catatan |
| --- | --- | --- | --- | --- |
| Produser yang dicabut | **SELALU** | `safety_account` (wajib, tak bisa dimatikan) | `producer_place_access_revoked` | `place_id = null` — tautan ke Tempat tidak diberikan karena ia tak lagi mengelolanya |
| Owner/manager aktif LAIN di Tempat yang sama | **Ya** | `system` | `producer_place_management_changed` | `place_id` diisi (mereka masih mengelola) → tautan `/places/{id}` valid |
| Editor | **Tidak** | — | — | Tidak ada master yang mewajibkannya |
| Admin pelaku | **Tidak** | — | — | Cukup umpan balik UI + audit |
| Operator Live (jika ada) | **Tidak** | — | — | **Temuan:** otorisasinya independen dari membership (tidak ada cara ia "tahu aksesnya berubah" karena memang tidak berubah) |
| Produser Tempat lain / pengguna tak terkait | **Tidak** | — | — | Bukan penerima yang berhak (MASTER 10 §14) |
| Pencabutan ditolak / idempoten | **Tidak** | — | — | Tidak ada perubahan; penolakan tetap masuk audit |

**Rantai dedup:** `(user_id, source_type='producer_membership', source_id=membership id, event_type)`
— kunci yang sudah ada (0026). Pencabutan ulang tidak menggandakan.

---

## 11. Rencana tes

1. Admin sah mencabut akses yang boleh dicabut (RPC nyata di PGlite) — baris hilang, audit tercatat.
2. Tanpa autentikasi & tanpa admin ditolak (route + RPC tanpa grant).
3. Non-admin ditolak: user biasa, produser, owner Tempat itu, developer/Creator tanpa peran admin — lewat route nyata **dan** RPC langsung.
4. Membership id palsu ditolak; id produser/Place dari klien diabaikan (RPC hanya menerima membership id → server menurunkan produser+Tempat dari DB).
5. Mencabut satu Tempat tidak memengaruhi Tempat lain milik Produser yang sama.
6. Hitung baris sebelum/sesudah: auth.users, public.users, producers, places, experiences, visit_intents tetap utuh.
7. Pengaman owner terakhir; owner non-terakhir, manager, editor bisa dicabut.
8. Produser yang dicabut gagal mengelola Tempat itu **segera** (membership 0 baris; RLS Tempat non-publik tertutup; gate server yang membaca membership menolak).
9. Idempoten untuk pencabutan ganda; kontrak kunci baris `FOR UPDATE` (konkurensi sungguhan = **NOT RUN**).
10. Audit tercatat; anon & non-admin tidak bisa membaca/menulis audit.
11. Notifikasi: isi tepat (nama Tempat, role terkunci, waktu zona Tempat, pelaku "Admin Singgah Lokal", apa yang berubah/tidak, langkah lanjut lewat Bantuan), penerima tepat, tidak ada duplikat, RLS penerima-saja, klien/anon tak bisa membuat/mengubah, kegagalan notifikasi tidak membatalkan pencabutan (dicatat di audit), halaman notifikasi merender tipe baru.
12. UI: konfirmasi wajib, tombol terkunci saat proses, keadaan sukses/error (termasuk peringatan notifikasi gagal), aksi per baris merujuk produser+Tempat, tanpa overflow mobile (statis; browser **NOT RUN**).
13. Regresi: tes admin/produser/notifikasi/Live/keamanan tetap hijau.

## 12. Policy Decisions (default yang dipilih; tidak mengubah aturan produk yang terkunci)

- **P1 — Pengaman owner terakhir (fail-closed).** Pencabutan yang akan membuat
  Tempat tanpa owner aktif (`role = 'owner'`) DITOLAK dengan pesan jelas. Tidak
  ada alur transfer yang dibuat. Manager/editor dan owner non-terakhir boleh
  dicabut. Master tidak mendefinisikan aturan lain, jadi ini default fail-closed
  yang diminta tugas.
- **P2 — Notifikasi di dalam transaksi RPC.** Tabel notifikasi dapat ditulis oleh
  fungsi DB (`notify_recipient`, 0029), jadi notifikasi dibuat dalam transaksi
  yang sama; kegagalan notifikasi **dikurung** (savepoint + `raise warning`,
  MASTER 10 §17) dan dicatat di audit sebagai `revoked_notification_failed`,
  sehingga pencabutan tidak pernah dibatalkan oleh kegagalan notifikasi.
- **P3 — Audit memakai `place_audit` (0031), bukan tabel baru.** Trail Admin
  Place yang sudah ada memuat actor/action/target/waktu/result/reason
  (MASTER 09 §13). Dua nilai `action` baru ditambahkan ke CHECK-nya. Tulis hanya
  dari RPC SECURITY DEFINER; RLS tanpa policy + revoked dari klien tetap utuh.
- **P4 — Kategori notifikasi yang ada, tanpa kategori baru.** Produser yang
  dicabut → `safety_account` (wajib, dijamin sampai). Owner/manager lain →
  `system` (opsional; menghormati preferensi pengguna persis seperti event
  `system` lain). Tidak ada kategori/event di luar enam yang terkunci.
- **P5 — Alasan pencabutan tidak diminta.** Skema audit/RPC yang ada tidak
  menyimpan alasan pada `place_audit.action` yang baru; tugas hanya mewajibkan
  alasan bila skema memang menyimpannya. Jadi alasan **tidak** diwajibkan dan
  tidak dikarang.
- **P6 — Penolakan otorisasi tidak menulis audit.** Penolakan karena *bukan
  Platform Admin* (route 403 / RPC `platform_admin_required`) menghentikan
  permintaan **sebelum** ada tulisan, sehingga penyerang tak terautorisasi tidak
  bisa mencemari trail. Penolakan oleh admin yang sah (id tak valid, owner
  terakhir, sudah dicabut) **tetap** tercatat di audit. Ini penyimpangan yang
  disengaja dan terdokumentasi dari daftar literal tugas (yang menyebut "bukan
  admin" ikut tercatat) — dipilih demi keamanan trail.
- **P7 — Tautan notifikasi untuk produser yang dicabut = tanpa tautan.**
  `place_id` dikosongkan untuk penerima yang tak lagi mengelola Tempat
  (memenuhi "bukan ke Place yang sudah tidak boleh ia kelola"); penerima lain
  memakai tautan Place yang sudah ada. Tidak ada rute/alur baru yang dikarang.
- **P8 — Bahasa role.** owner → "Pemilik", manager → "Pengelola", editor →
  "Editor", sesuai instruksi tugas dan istilah terkunci
  `docs/UI_TERMINOLOGY_STANDARD.md` §2 ("Pengelola" = role Produser;
  tidak diterjemahkan/dikarang ulang).
