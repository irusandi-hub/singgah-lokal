# ADMIN-PLACE-REVOKE — "Cabut Hak Pengelolaan" di halaman detail Place (perluasan di atas #45)

Date: 2026-10-14
Branch: `feat/admin-place-detail-revoke-management`
Base: `feat/admin-revoke-producer-place-access` (PR #45). PR #40–#45 masih **OPEN /
belum di-merge** saat audit ini dibuat, jadi base = ujung rantai (#45) dan PR
tumpukan ini menyatakan base-nya di deskripsi. `main` belum memuat #45.
Task ini adalah **perluasan**, bukan pekerjaan ulang: seluruh RPC/route/notifikasi
#45 dipakai apa adanya.

Nomor migrasi: `0058` **bebas** di setiap branch lokal/remote (diperiksa pada
tree `origin/*`). Task ini **tidak memerlukan migrasi baru** — lihat §6.

Sources read before coding: `AGENTS.md`, `docs/masters/MASTER_INDEX_v1.0.md`,
`MASTER_AUTHORITY_STRUCTURE_v1.0.md`, MASTER 09 (Admin/Moderation & Governance),
`docs/UI_TERMINOLOGY_STANDARD.md`, `docs/HANDOFF_LIVE_MVP.md`,
`docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md`,
`docs/audits/ADMIN_REVOKE_PLACE_ACCESS_AUDIT.md` (hasil #45 — **tidak** diulang),
dan kode/migrasi di §1–§5.

---

## 1. `place_has_active_ownership` dan semua yang bergantung padanya

Definisi kanonik (`web/supabase/migrations/0028_place_claims.sql:92`):

```sql
create or replace function public.place_has_active_ownership(p_place_id text)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.producer_memberships m where m.place_id = p_place_id
  ) or exists (
    select 1 from public.places p where p.id = p_place_id and p.producer_id is not null
  );
$$;
```

Jadi kepemilikan = **membership ATAU `places.producer_id` non-null**.

Konsumen (satu-satunya, semuanya di 0028):

| Konsumen | Baris | Guna |
| --- | --- | --- |
| `list_claimable_places()` | 0028:127 | Tempat tanpa kepemilikan aktif boleh diklaim |
| `submit_place_claim(...)` | 0028:170 | Menolak klaim atas Tempat yang sudah dimiliki |
| `review_place_claim(...)` | 0028:303 | Menolak approval bila Tempat sudah dimiliki |

`place_has_active_ownership` **hanya** gerbang **klaim/kepemilikan**. Ia **bukan**
gerbang hak kelola.

## 2. Dari mana hak kelola diturunkan? (jawaban item audit 1)

Hak kelola **hanya** dari `producer_memberships`, dibuktikan pada setiap policy
dan setiap gate server (tanpa cache):

| Jalur | Bukti | Predikat |
| --- | --- | --- |
| `places_public_read`, `experiences_public_read`, `schedules_public_read` | `0001:202-204` | `producer_memberships` (`place_id`) |
| `places_producer_insert` | `0004:7` | `producer_memberships` (`producer_id`, role `owner`) |
| `places_producer_update` | `0004:15` | `producer_memberships` (`place_id`) |
| `experiences_producer_*`, `schedules_producer_*` | `0005` | `producer_memberships` (`place_id`) |
| `visit_intents_producer_read/update`, `visit_intent_history_read` | `0001:207-223` | `producer_memberships` (`place_id`) |
| `requireProducerAccess(request, placeId, roles)` | `web/lib/auth/server.ts:76` | query membership per-Place per-request |
| `resolvePlaceManagerAuthority` / `decideLiveOperateAuthority` | `web/lib/live/operator-authorization.ts:77` | query membership per-Place, **tanpa cache** |
| `GET /api/producer/visit-intents`, `PATCH /api/producer/visit-intents/[id]` | route | membership per-Place |
| `/producer`, `/producer/live`, `/api/auth/producer-session` | page/route | membership |
| `canManagePlace` (pure) | `web/lib/producer.ts:62` | **membership untuk Place itu ATAU `place.producer.id === access.producerId`** |
| `place_has_active_ownership` (claim gate) | `0028:92` | membership **ATAU** `places.producer_id` |

**Temuan (G-AUTH-1):** satu-satunya tempat di seluruh basis kode di mana hak
kelola bisa lolos **tanpa** baris membership untuk Place itu adalah baris
terakhir `canManagePlace`:

```ts
return access.placeId === place.id || place.producer?.id === access.producerId;
```

Bila `access.placeId` kosong (mis. access yang dibentuk dari
`SupabaseAuthProvider.authenticate()`, yang **tidak** men-select `place_id`),
predikat ini mengizinkan pengelolaan hanya karena `places.producer_id` cocok.
Karena pencabutan #45 **tidak** mengosongkan `places.producer_id`, seorang
Produser yang membership-nya sudah dicabut akan **tetap lolos** predikat ini.
Ini persis jalur alternatif `places.producer_id` yang diminta ditutup.

Catatan kejujuran: pada kode saat ini **tidak ada** jalur tulis server yang
hanya mengandalkan `canManagePlace` — setiap route Producer memanggil
`requireProducerAccess(request, <placeId>)` lebih dulu (yang membaca membership
per-Place), dan `respondAsProducer` menerima access dengan `placeId` terisi.
`getProducerPlaces`/`getProducerVisitIntents` tidak punya pemanggil produksi.
Jadi ini **jalur laten**, bukan eksploit yang terbukti. Karena default tugas
adalah **fail-closed**, predikat ini dipersempit (§6).

## 3. Skema audit Place yang ada, dan apakah #45 sudah menulis ke sana

Trail audit Place = `public.place_audit` (`0031_place_audit.sql`): append-only
(trigger `place_audit_block_mutation` menolak UPDATE/DELETE untuk semua penulis,
termasuk service role), `actor_id uuid not null references public.users(id)`,
`action text not null check (...)`, `before_data`/`after_data` jsonb, `detail`
jsonb, `created_at`. RLS menyala dengan **nol policy** dan tabel di-revoke dari
`public, anon, authenticated`.

Kosakata `action` diperluas oleh `0039` (Developer/Dummy) dan oleh **0057** yang
menambahkan dua nilai:

- `producer_place_access_revoked`
- `producer_place_access_revoke_denied`

**Jawaban:** #45 **sudah** menulis ke audit Place yang sama, di dalam transaksi
RPC yang sama, dengan label Indonesia di `web/lib/place-audit-format.ts`
(`producer_place_access_revoked: "Hak kelola Pengelola dicabut"`,
`producer_place_access_revoke_denied: "Pencabutan hak kelola ditolak"`).
Kegagalan `insert into place_audit` me-rollback seluruh transaksi (tidak ada
pencabutan tanpa trail). **Tidak ada audit kedua, tidak ada tabel audit baru,
tidak ada penulisan ganda.** Task ini **tidak menambah action** dan **tidak
menyentuh** perlindungan append-only.

## 4. Data bagian "Pengelola" di halaman detail Place (item audit 3)

`web/app/admin/places/[placeId]/page.tsx` merender bagian **Pengelola** dari
`getAdminPlaceDetail()` (`web/lib/admin/place-workspace.ts:180`). Bentuk baris
saat ini:

```ts
export type AdminPlaceMembershipRow = {
  userId: string; producerId: string; role: string; createdAt: string;
};
```

Read-nya: `.select("user_id, producer_id, role, created_at")`.

**Temuan (G-UI-1):** payload **tidak** memuat `producer_memberships.id`
(surrogate dari 0057). Tanpa id itu, halaman detail Place **tidak punya cara**
memanggil route pencabutan untuk sebuah baris. Bagian Pengelola juga hanya
menampilkan potongan `userId` (`userId.slice(0,8)…`) + role + tanggal — bukan
identitas akun dengan konvensi aman yang sudah ada (email via service role di
konteks Admin), dan tidak ada aksi per-baris. Ini delta wajib task ini.

**Empty state:** sudah ada — `"Belum ada membership."` (dan `"Tanpa Pengelola"`
bila `place.producer` null). Dipertahankan.

## 5. Interaksi dengan alur klaim & kepemilikan (item audit 4)

- Pencabutan #45 **tidak** menyetujui/menolak klaim: RPC hanya `delete from
  producer_memberships` + audit + notifikasi; tidak menyentuh `place_claims`.
  Approval klaim tetap satu-satunya INSERT membership owner (`review_place_claim`).
- **Tidak** mengubah role global: `users.platform_role` tidak disentuh; tidak ada
  role baru; `live_operators` (Operator Live) **independen** dari membership
  (batas H1, `docs/audits/LIVE_OPERATOR_BOUNDARY_AUDIT.md`) → pencabutan
  membership tidak mencabut akses Operator Live, dan itu memang benar.
- **`places.producer_id` tidak diubah** oleh pencabutan (keputusan #45 P/G7).
  Konsekuensi: `place_has_active_ownership` bisa tetap `true` walau tak ada akun
  pengelola. Karena pengaman owner-terakhir menjamin ≥1 owner tersisa, jalur ini
  tidak terpicu lewat pencabutan biasa. **Tidak** menambah alur transfer
  kepemilikan (dilarang tugas) → dicatat sebagai Policy Decision P-A2.

---

## 6. Celah NYATA yang tersisa (relatif terhadap #45) + rencana minimal

### G-UI-1 (wajib) — payload detail Place tidak membawa membership id
- **Tutup:** `getAdminPlaceDetail` select `id` juga; tambah `membershipId` (dan
  `userEmail` via konvensi aman `listAdminActorEmails`) ke
  `AdminPlaceMembershipRow`; bagian **Pengelola** dirender komponen klien baru
  yang menampilkan identitas akun, role, dan aksi **"Cabut Hak Pengelolaan"**.
  Tidak menyentuh `lib/admin/queries.ts` (dikunci "service client tepat sekali"
  oleh `tests/admin-canonical-reads.test.ts`).

### G-AUTH-1 (wajib, fail-closed) — `canManagePlace` mengizinkan lewat `places.producer_id`
- **Tutup (paling sempit):** hak kelola = membership untuk Place itu saja.
  Buang cabang `place.producer?.id === access.producerId`; wajibkan
  `access.placeId === place.id`. Konsisten dengan seluruh policy RLS + gate
  server yang sudah membership-scoped. Tidak ada alur transfer baru, tidak
  menyentuh `places.producer_id`, tidak menyentuh klaim.
- Dampak: hanya `web/tests/producer.test.ts` (satu-satunya pemakai predikat ini;
  `getProducerPlaces`/`getProducerVisitIntents` tidak punya pemanggil produksi).
  Tes itu mengunci **semantik lama producer-wide** → diamandemen **eksplisit**
  (§8), tidak ada assertion yang dihapus.

### Bukan celah (dikonfirmasi)
- Audit Place: #45 sudah benar (satu transaksi, append-only utuh) — tidak diubah.
- Notifikasi: #45 sudah benar (kategori yang ada, dedup 0026, `notify_recipient`);
  jalur dari halaman detail memakai RPC yang **sama** → perilaku identik, satu
  notifikasi, tanpa duplikat.
- Idempotensi & validasi: RPC hanya menerima membership id; id rusak
  divalidasi server (`isMembershipId`); Place/akun diturunkan dari baris
  membership di DB. Halaman detail hanya mengirim membership id → server tetap
  memverifikasi kepemilikan baris itu sendiri (kecocokan dengan Place detail
  bersifat tampilan; otoritasnya tetap baris membership).

### Rencana minimal (delta saja)
| # | Perubahan |
| --- | --- |
| A | `lib/admin/place-workspace.ts`: `AdminPlaceMembershipRow` += `membershipId`, `userEmail`; select `id`; resolusi email anggota |
| B | `lib/producer.ts`: persempit `canManagePlace` (membership-scoped; buang cabang producer_id) |
| C | UI: ekstrak aksi+dialog dari `AdminPengelolaTable.tsx` ke komponen bersama; komponen baru bagian "Pengelola" di halaman detail Place; label aksi **"Cabut Hak Pengelolaan"** (Data Pengelola tetap **"Cabut Hak Akses"**) |
| D | Tes: perluas kontrak UI + perilaku DB Postgres nyata (PGlite) untuk konteks halaman detail; amandemen eksplisit `producer.test.ts` & `admin-revoke-place-access-ui.test.ts` (rujukan markup pindah ke komponen bersama) |
| E | Runbook/HANDOFF: catat perluasan (tanpa migrasi baru) |

**Tidak ada migrasi baru.** `0058` tetap bebas dan tidak dipakai.

---

## 7. Matriks jalur otorisasi × kondisi SETELAH pencabutan

| # | Jalur | Predikat | Setelah membership dicabut |
| --- | --- | --- | --- |
| 1 | RLS read Tempat/Experience/Schedule | `producer_memberships` (place_id) | **TOLAK** (Tempat non-publik tersembunyi) |
| 2 | RLS `places_producer_update` | `producer_memberships` (place_id) | **TOLAK** |
| 3 | RLS `experiences_producer_*` / `schedules_producer_*` | membership (place_id) | **TOLAK** |
| 4 | RLS `visit_intents_producer_read/update` | membership (place_id) | **TOLAK** |
| 5 | `requireProducerAccess(placeId)` | membership (place_id) | **TOLAK** (403) |
| 6 | `resolvePlaceManagerAuthority` / `decideLiveOperateAuthority` | membership (place_id) | **TOLAK** |
| 7 | `/api/producer/visit-intents` (+`[id]`) | membership (place_id) | **TOLAK** (403) |
| 8 | `/api/auth/producer-session`, `/producer`, `/producer/live` | membership | entry disembunyikan / redirect bila tak ada membership |
| 9 | `canManagePlace` (pure) | **diperbaiki** → membership (place_id) | **TOLAK** (sebelumnya **LOLOS** via `places.producer_id`) |
| 10 | Otoritas Operator Live (`live_operators`) | assignment aktif per-Place (**independen**) | **TIDAK berubah** (memang tak bergantung membership) |
| 11 | Gerbang klaim `place_has_active_ownership` | membership **ATAU** `places.producer_id` | **tidak berubah** — `places.producer_id` tetap (P-A2) |
| 12 | Admin (Platform Admin) | `requirePlatformModerator()` + `platform_role` di DB | **tidak berubah** (di luar cakupan pencabutan) |

## 8. Rencana tes (hanya yang belum ada; perluas #45)

Perilaku Postgres nyata via PGlite (rantai migrasi nyata s/d 0057), plus kontrak
statis untuk markup yang tak bisa dijalankan di sandbox:

1. Konteks halaman detail: membership id yang disajikan payload detail Place
   memang memanggil RPC dan mencabut baris yang tepat (bukan baris lain).
2. Tanpa auth / user biasa / produser / owner Tempat itu / non-admin ditolak
   (route 403; RPC `platform_admin_required`).
3. Membership id yang bukan milik Place yang sedang dibuka tetap hanya mengubah
   baris membership itu sendiri (server menurunkan Place dari baris, bukan dari
   input) — tidak ada baris lain yang berubah.
4. Hanya membership target yang berubah; membership lain + Place lain utuh
   (hitung sebelum/sesudah: users, places, experiences, visit_intents).
5. Jalur alternatif `places.producer_id`/`place_has_active_ownership`: produser
   yang dicabut **gagal** mengelola Tempat itu lewat gate kelola nyata sesudah
   pencabutan (predikat membership-scoped; RLS membership).
6. Owner terakhir ditolak; owner non-terakhir, manager, editor berhasil.
7. Audit Place: satu catatan teratribusi per pencabutan sukses; penolakan owner
   terakhir tercatat; **kegagalan tulis audit membatalkan pencabutan (atomik,
   tanpa residu membership/notifikasi)**; append-only tetap (**UPDATE/DELETE
   ditolak oleh trigger 0031**); label terformat. Ketiga jaminan ini diuji
   langsung di `admin-place-detail-revoke.test.ts` (test 1, 4, 5) — bukan hanya
   diasumsikan dari "satu transaksi".

Catatan implementasi: dua jaminan terakhir (atomik + append-only) semula hanya
ada di rencana §8 ini, belum di suite; keduanya kini ditambahkan sebagai delta di
`admin-place-detail-revoke.test.ts` tanpa mengubah berkas tes #45.
8. UI statis: aksi **"Cabut Hak Pengelolaan"** terlihat untuk eligible; dialog
   menyebut akun + Tempat; Batal tidak mengubah state; sukses merefresh; gagal
   tanpa sukses palsu; loading mencegah submit ganda; empty state tetap; tanpa
   overflow 360/390px.
9. Regresi: detail Place, moderasi/klaim admin, akses produser Place lain, data
   Experiences/Visit Intents/Live, tes #45, gate Live
   (`assert_viewer_eligible`/`admit_live_viewer`) tetap hijau.

Tes lama yang diamandemen (eksplisit):
- `web/tests/producer.test.ts` — dua assertion producer-wide (`canManagePlace`,
  `getProducerVisitIntents` dengan access tanpa `placeId`) mencerminkan semantik
  lama yang kini ditutup. Diamandemen agar access menyertakan `placeId` (semantik
  baru: kelola = membership Place itu). Tidak ada assertion dihapus.
- `web/tests/admin-revoke-place-access-ui.test.ts` — assertion tentang **markup**
  dialog/aksi dipindah ke rujukan komponen bersama (markup memang dipindah lewat
  ekstraksi), tetap dengan kekuatan yang sama.

## 9. Policy Decisions

- **P-A1 — Hak kelola = membership-only (fail-closed).** `places.producer_id`
  tidak pernah menjadi izin kelola. Predikat `canManagePlace` dipersempit agar
  konsisten dengan setiap policy RLS + gate server. Alasan: satu-satunya jalur
  yang bisa meloloskan produser yang dicabut.
- **P-A2 — Pencabutan tidak mengubah `places.producer_id`.** Mengosongkannya
  berarti mengubah sinyal kepemilikan/klaim → alur transfer/konsen baru, yang
  dilarang tugas. Karena itu gerbang klaim (`place_has_active_ownership`) tidak
  diubah; `places.producer_id` tetap penanda **kepemilikan**, bukan izin kelola.
  UI menyajikan **membership** sebagai sumber kebenaran pengelola.
- **P-A3 — Tanpa migrasi baru.** 0057 sudah menyediakan `id`, kosakata audit, dan
  RPC. Tidak ada action audit baru, tidak ada perubahan RPC, tidak ada perubahan
  `places.producer_id`. `0058` dibiarkan bebas.
- **P-A4 — Satu jalur tulis, tanpa duplikasi.** Halaman detail memakai RPC/route
  #45 yang sama; tidak ada RPC/route/notifikasi kedua. Notifikasi lewat jalur ini
  berperilaku identik (satu notifikasi, tanpa duplikat) karena ditulis di dalam
  transaksi RPC yang sama.
- **P-A5 — Label aksi berbeda per konteks (disengaja).** Data Pengelola tetap
  **"Cabut Hak Akses"** (dikunci tes #45); halaman detail Place memakai
  **"Cabut Hak Pengelolaan"** sesuai instruksi tugas. Keduanya memanggil aksi
  yang sama.

## 10. Reuse vs baru

**Dipakai apa adanya (tanpa perubahan):** `revoke_producer_place_access` (0057),
`/api/admin/producer-memberships/[membershipId]/revoke`, `lib/admin/producer-membership-revoke.ts`,
kosakata+label audit 0057 (`place-audit-format.ts`), `recordPlaceAudit`/`place_audit`,
`notify_recipient` + kategori/event 0057, pengaman owner terakhir, gate klaim.

**Baru/diubah (delta):** `AdminPlaceMembershipRow` (+`membershipId`,`userEmail`) &
read di `place-workspace.ts`; penyempitan `canManagePlace` di `lib/producer.ts`;
komponen bersama aksi+dialog pencabutan (ekstraksi dari `AdminPengelolaTable.tsx`);
komponen baru bagian "Pengelola" halaman detail Place; tes perluasan + amandemen
eksplisit.
