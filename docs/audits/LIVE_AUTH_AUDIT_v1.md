# LIVE_AUTH_AUDIT_v1 — Audit Berbasis Bukti: Auth, Age Gate, Live Access, Live Management

Status: **AUDIT ONLY** — tahap ini TIDAK mengubah kode aplikasi, migrasi, atau kebijakan.
Satu-satunya perubahan yang diizinkan di tahap ini: dokumen ini dan (opsional) tes
karakterisasi di `web/tests/audit/`. Perbaikan dikerjakan di Tahap B–D memakai ID temuan
di dokumen ini.

- Tanggal audit: 2026-10-11
- Repo: `https://github.com/irusandi-hub/singgah-lokal`
- Branch kerja: `audit/live-auth-baseline`
- **BASE: `main`** — PR #37, #38, #39 sudah **MERGED**, jadi tidak ada rantai PR yang
  belum merge; audit dilakukan pada `main` terbaru dan PR audit ini juga berbasis `main`.
- **HEAD yang diaudit: `e8797ef62df03e700dd2013acd3974af3ea5efa2`** (`Merge pull request #39 from irusandi-hub/feat/account-mobile-ui`)
- Sumber otoritatif yang dibaca: `AGENTS.md`, `web/AGENTS.md`,
  `docs/masters/MASTER_INDEX_v1.0.md`, `MASTER_LIVE_POLICY_v1.0.md`,
  `MASTER_LIVE_TECH_v1.0.md`, `MASTER_AUTHORITY_STRUCTURE_v1.0.md`,
  `MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0.md`,
  `docs/HANDOFF_LIVE_MVP.md`, `docs/UI_TERMINOLOGY_STANDARD.md`,
  `docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md`, migrasi `0001`–`0050`.

## 0. Status akses DEV

**NOT-RUN.** Alasan (bukan asumsi):

- Supabase CLI tidak terpasang di sandbox (`which supabase` → tidak ada; `npx --no-install supabase --version` → paket tidak ada dan tidak diinstal).
- Kredensial disimpan di `.env.local` (kunci: `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), tetapi sandbox
  **memblokir akses env/sensitive-file secara langsung** dari perintah terminal
  (`Direct env and sensitive-file access is blocked`), sehingga tidak ada cara
  membaca state DEV tanpa membocorkan rahasia. Tidak ada `DATABASE_URL`/connection
  string DEV di repo.
- Karena itu: **drift migrasi, state tabel DEV, dan pengujian klik-nyata di DEV =
  NOT-RUN.** Sesuai instruksi, audit dilanjutkan berbasis repo + migrasi saja, dan
  tidak ada satu pun perubahan yang dilakukan pada DEV.

Project ref DEV yang tercatat di repo (dokumen, bukan nilai rahasia):
`qiwexmzbysujmqctrsiq` (`docs/AUTH_GOOGLE_OAUTH_SETUP.md:14`,
`docs/AUTH_APPLE_OAUTH_SETUP.md:17`). Tidak ada URL/project lain yang disentuh.

---

## 1. Ringkasan temuan

| Tingkat | Jumlah CONFIRMED | Jumlah SUSPECTED |
| --- | --- | --- |
| CRITICAL | 0 | 0 |
| HIGH | 1 (A-01) | 2 (S-01, S-02) |
| MEDIUM | 5 (A-02…A-06) | 2 (S-03, S-04) |
| LOW | 5 (A-07…A-11) | 1 (S-05) |

Sebaran per tahap perbaikan: **B (auth/signup/signin) = 3** (A-01, A-06, A-07),
**C (age gate/admisi/komentar) = 5** (A-02, A-03, A-04, A-05, A-09),
**D (produser/moderasi/admin) = 3** (A-08, A-10, A-11).

Lima temuan teratas:

1. **A-01 (HIGH, B)** — Tautan konfirmasi email sign-up mengarah ke `/auth`, tetapi
   hanya `/auth/callback` yang menukar `code`; tidak ada handler di `/auth`.
2. **A-02 (MEDIUM, C)** — `anon`/`authenticated` boleh `select` seluruh kolom
   `public.live_sessions`, termasuk `live_input_id` (UID input provider) dan
   `idempotency_key`.
3. **A-03 (MEDIUM, B/C)** — `release_live_input` dan `list_ended_live_inputs`
   di-grant ke `authenticated` **tanpa** pemeriksaan kepemilikan Place.
4. **A-04 (MEDIUM, C)** — Batas 100 penonton konkuren dihitung dari baris admission
   berumur < 5 menit, sehingga penonton yang bertahan >5 menit tidak lagi dihitung.
5. **A-05 (MEDIUM, C/UI)** — Salinan UI menyiratkan jalur verifikasi yang bisa
   diselesaikan ("Menunggu verifikasi akses Live"), padahal backend menolak semua
   penonton by design.

### Jawaban singkat atas pertanyaan wajib laporan akhir

- **Apakah Live masih fail-closed? YA.** Bukti:
  `web/supabase/migrations/0008_live_sessions.sql` → `public.assert_viewer_eligible(p_session_id text)`
  mengakhiri badannya dengan `raise exception 'live_viewer_denied' using errcode = 'P0001';`
  tanpa syarat (komentar: "B1 (blocked): verified-age mechanism is Phase 2.1; until then deny all").
  Tidak ada jalur admisi lain: `admit_live_viewer` (0008, didefinisikan ulang di
  `0027_live_viewer_cap_race_guard.sql` **tetap** memanggil `assert_viewer_eligible` sebagai
  pemeriksaan pertama), `post_live_comment`, `submit_live_report` juga memanggil gate yang sama,
  dan `0009_live_realtime_private_channels.sql` hanya mengizinkan join channel privat bagi
  `auth.uid()` yang punya baris `live_viewers` (baris itu hanya bisa dibuat oleh
  `admit_live_viewer`). Kredensial stream juga hanya keluar setelah gate:
  `web/app/api/live/playback/route.ts` memanggil `admitLiveViewer(...)` **sebelum**
  `signPlaybackToken(...)`, dan gagal-tertutup bila signing key tidak ada.
- **Apakah `date_of_birth`/telepon dipakai sebagai bukti usia di mana pun? TIDAK.**
  Bukti: `grep -rn "date_of_birth"` → hanya `lib/account/age.ts`, `lib/account/profile.ts`,
  `lib/account/profile-read.ts`, `app/api/account/profile/route.ts`,
  `components/account/account-profile-edit-client.tsx`, `0050_profile_phone_verification.sql`,
  dan tes. `calculateAge`/`validateDateOfBirth` dipakai **hanya** untuk menampilkan usia
  dan sanity-bound (tidak ke masa depan, ≤120 tahun); tidak ada satu pun kode eligibility
  (RPC Live, route Live, `assert_viewer_eligible`) yang membaca `date_of_birth` atau
  `phone_verified_at`. Header `lib/account/age.ts` menyatakannya eksplisit: "nothing here
  grants eligibility". `MASTER_LIVE_TECH_v1.0.md` §2.1 juga menyebut mekanisme usia =
  **BLOCKED/TUNABLE → Phase 2.1**.
- **Sel matriks peran "POLICY DECISION NEEDED":** (a) apakah **akun tanpa email
  terverifikasi** boleh memegang otoritas Operator Live dan memulai Live; (b) apakah
  **suspend akun level-platform** (bukan hanya kapabilitas Live) adalah sebuah konsep
  produk; (c) apakah peran **editor** boleh membaca/menonton Live Place-nya (sekarang
  boleh *read* sesi, tetapi dilarang start/end).
- **Keputusan/kredensial yang dibutuhkan dari pemilik produk:** lihat §7.

---

## 2. Audit per butir (cakupan 1–11)

### 2.1 Sign Up

| Aspek | Bukti | Catatan |
| --- | --- | --- |
| Form | `web/app/auth/sign-up/sign-up-form.tsx` | Field: `name`, `email`, `password`, `passwordConfirmation`. **Tidak ada field `date_of_birth`** — audit butir 1 menyebut "validasi email/password/DOB", tetapi DOB **tidak** dikumpulkan di sign-up (dikumpulkan nanti di `/account/profile`). |
| Validasi | `web/lib/auth/sign-up.ts` (`validateSignUpInput`, `MIN_SIGN_UP_PASSWORD_LENGTH = 8`) + `app/api/auth/sign-up/route.ts` | Validasi dijalankan **di klien dan di route** (server-side) — bukan hanya klien. Email: regex sederhana; password: panjang ≥ 8 + konfirmasi. |
| Pembuatan user Supabase Auth | `app/api/auth/sign-up/route.ts` → `supabase.auth.signUp({ email, password, options: { data: { display_name } } })` | Tidak ada `producer_id`, `role`, atau `platform_role` yang diterima dari klien. |
| Sinkronisasi `public.users` | `0001_visit_intent_foundation.sql` → `public.handle_new_user()` + trigger `on_auth_user_created` (`after insert on auth.users`) → `insert into public.users (id) values (new.id) on conflict (id) do nothing` | Idempoten. Hanya `id` yang diisi: **tidak ada role/hak istimewa yang bisa dititipkan lewat trigger**. |
| Perilaku saat gagal | Trigger adalah `AFTER INSERT` pada transaksi yang sama → kegagalan trigger membatalkan insert `auth.users` (atomik di sisi transaksi); `handle_new_user` juga `on conflict do nothing` sehingga retry tidak menduplikasi. | Tepi-tepi ini **belum diuji**; lihat S-01 (butuh DEV). |
| Email konfirmasi + callback + redirect | `app/api/auth/sign-up/route.ts:38` → `emailRedirectTo: ${origin}/auth`; satu-satunya penukar kode adalah `app/auth/callback/route.ts:43` → `exchangeCodeForSession(code)`; `app/auth/auth-form.tsx` **tidak** membaca `code` (`grep -n "code"` → hanya `?error=`). | **A-01 (HIGH)**: tujuan redirect konfirmasi tidak punya handler penukar kode. |
| Duplikat / retry / kegagalan parsial | `signUp` mengembalikan `created: true, authenticated: <bool>, needsEmailConfirmation: <bool>`; form menampilkan status "Akun dibuat" yang berbeda untuk kedua cabang. | Klien menangani kedua hasil; tidak ada retry otomatis (baik). |
| Klien/metadata menetapkan role? | `grep -rn "user_metadata\|app_metadata" app lib components` → **0 hasil**. Tidak ada pembacaan metadata untuk otorisasi; otoritas selalu dari tabel (`producer_memberships`, `live_operators`, `users.platform_role`). | Aman: role tidak bisa ditetapkan dari klien/metadata. |
| Eksposur data profil ke pengguna lain | `0001` → policy `users_self_access on public.users for select using (id = auth.uid())`; tidak ada policy SELECT lain pada `public.users`; `0047`/`0050` hanya menambah GRANT UPDATE kolom (bukan SELECT). | Satu-satunya jalur “nama pengguna lain” adalah RPC definit `list_*_live_operator*`/`resolve_account_by_username` yang mengembalikan **username saja** dan hanya kepada owner/manager Place terkait. |

### 2.2 Sign In / Sign Out / Sesi

| Aspek | Bukti | Catatan |
| --- | --- | --- |
| Login | `app/api/auth/sign-in/route.ts` → `signInWithPassword`; error selalu `authentication_failed` 401; `Cache-Control: no-store`. | Tidak membedakan email tidak ada vs password salah (baik). |
| OAuth | `app/auth/callback/route.ts`, `app/api/auth/oauth/{google,apple}/route.ts`, `lib/auth/return-to.ts` (`sanitizeReturnTo`). | `next` disanitasi → tidak ada open redirect. |
| Status email terverifikasi — sumber otoritatif | Live: `0008` `assert_viewer_eligible` membaca `auth.users.email_confirmed_at is null` (di dalam DB, dari sesi). Akun: `app/api/account/profile/route.ts` & `lib/account/profile-read.ts` memakai `user.email_confirmed_at` dari `supabase.auth.getUser()` (server), bukan boolean klien. | Bukan boolean klien. |
| Refresh / kedaluwarsa / revokasi sesi | `@supabase/ssr` `createServerClient` + cookie (`lib/supabase/server.ts`). | Tidak ada penyimpanan sesi paralel. |
| Sign-out | `app/api/auth/sign-out/route.ts` → `supabase.auth.signOut()`; melepas Creator lease (`lib/creator/session-lease.ts`) dan menghapus cookie gate Creator. | Keluar nyata di server; UI (`components/sign-out-button.tsx`) baru berpindah setelah server mengonfirmasi. |
| Proteksi route di server vs hanya klien | Server: `app/admin/layout.tsx` (`requirePlatformModerator` → 403 / redirect `/auth?returnTo=%2Fadmin`), `app/developer/layout.tsx`, `app/account/page.tsx:121`, `app/account/profile/page.tsx:28`, `app/producer/page.tsx:43`, `app/notifications/page.tsx:39`, `app/visit-intents/page.tsx:43`. | Tidak ada `middleware.ts` di repo (0 hasil) — setiap halaman/route memakai guard server sendiri. Tidak ada halaman terproteksi yang hanya mengandalkan klien (dicek lewat daftar `redirect("/auth...")` di atas). |
| Akses URL langsung | Sama seperti di atas — guard di layout/page server dijalankan pada request langsung. | Terverifikasi secara statis. |
| Ganti akun | Tidak ada mekanisme khusus; sesi cookie diganti oleh `signOut` + `signIn`. | — |
| Perubahan role saat sesi aktif | `lib/auth/server.ts`, `lib/live/platform.ts`, `lib/live/operator-authorization.ts` membaca DB **setiap panggilan** (tidak ada cache otorisasi); pernyataan eksplisit di header `operator-authorization.ts` ("no authorization cache"). `live_operators.revoked_at is null` → pencabutan berlaku pada panggilan berikutnya. | Efektif segera. |
| Akun disuspend | `grep -rni "suspend"` → hanya `live_eligibility.active=false` di `moderate_live` (`0008`), tanpa kolom/status suspend akun di migrasi mana pun. | **A-10 + POLICY DECISION NEEDED**: tidak ada konsep "akun disuspend" (login diblokir). Yang ada hanya suspend kapabilitas Live produser. |

### 2.3 Age gate

- Semua pembacaan `date_of_birth`: lihat §2.1 dan §0 — **tidak ada** kode yang
  memperlakukannya sebagai bukti usia. `lib/account/age.ts` (header) menyatakan itu
  sebagai *Policy Gap* eksplisit; `0050` mengulanginya di header migrasi.
- Provider/webhook/tabel verifikasi usia: **tidak ada**. Tidak ada tabel
  `age_verification*`, tidak ada webhook, tidak ada vendor, tidak ada env var terkait
  (grep `date_of_birth`, `age_verification`, `verify_age` kosong di luar jalur profil).
- Kesiapan batas integrasi: gate sudah berbentuk satu fungsi fail-closed
  (`assert_viewer_eligible`) yang dipanggil oleh **semua** jalur partisipasi
  (`admit_live_viewer`, `post_live_comment`, `submit_live_report`). Itu titik
  integrasi yang benar untuk Phase 2.1 — tetapi belum ada request/status/callback,
  replay guard, atau kedaluwarsa verifikasi usia (tidak ada entitasnya sama sekali).
- Penyimpanan data pribadi berlebih: `public.users` menyimpan `full_name`,
  `date_of_birth`, `phone_e164`, `avatar_path` (self-owned). Tidak ada penyimpanan
  dokumen identitas/biometrik. Untuk verifikasi usia ke depan, kebijakan retensi
  belum ada → §7.

### 2.4 Admisi penonton

| Aspek | Bukti | Catatan |
| --- | --- | --- |
| `assert_viewer_eligible` | `0008` (fungsi) | Urutan: self-heal duration cap → sesi ada & `status='live'` → `content_status='ok'` → `email_confirmed_at is not null` & `auth.uid()` ada → **deny-all (B1)**. |
| `admit_live_viewer` | `0008`, didefinisikan ulang `0027` | Memanggil `assert_viewer_eligible` lebih dulu; kapasitas diserialisasi dengan `pg_advisory_xact_lock(hashtextextended('live_viewer_admission_lock:'||session,0))` (perbaikan race). |
| RPC/route lain yang bisa memberi tontonan / kredensial stream | `app/api/live/playback/route.ts` (satu-satunya pemberi kredensial), `app/api/live/comments/route.ts` (admit + broadcast), `app/api/live/reports/route.ts` → `submit_live_report`. `app/api/live/status` dan `app/api/live/discovery` hanya metadata publik (tanpa kredensial). | Tidak ada jalur lain yang mengembalikan `live_input_id`/URL/token. |
| Urutan pemeriksaan & token playback | playback: body → sesi live → Place published → health provider (`getLiveInputStatus`, null ⇒ 503) → `admitLiveViewer` → `signPlaybackToken` (null ⇒ 503, tanpa fallback URL mentah). | **Kredensial tidak pernah keluar sebelum gate lolos.** |
| Race condition | 0027 (kapasitas) + 0008 (global cap via advisory lock, per-Place via partial unique index). | Lihat A-04 untuk kelemahan *semantik* penghitungan. |
| Kapasitas | `admit_live_viewer` menghitung `live_viewers where admitted_at > now() - interval '5 minutes'`; `viewer_peak = greatest(viewer_peak, v_concurrent+1)` (check ≤ 100). | **A-04**. |
| Masa berlaku token playback | `lib/live/stream-token.ts` → TTL `LIVE_PLAYBACK_TOKEN_TTL_SECONDS` (60 s), RS256, kunci hanya di env server (`CLOUDFLARE_STREAM_SIGNING_KEY[_ID]`). | **A-08**: token tidak bisa dicabut dalam TTL-nya. |

### 2.5 Komentar dan interaksi

- Kirim komentar: `app/api/live/comments/route.ts` → moderasi konten dulu
  (`lib/live/comment-moderation-core.ts`), lalu `admitLiveViewer` + `postLiveComment`
  (yang memanggil `assert_viewer_eligible`), lalu broadcast Realtime privat
  (`live_session:{id}`, `private: true`, auth dari `/api/auth/realtime-token`).
  Hasil `channel.send` diperiksa: `delivery !== "ok"` ⇒ 503 (`live_comment_delivery_failed`).
- Baca: Realtime broadcast + policy `0009` `live_realtime_receive` (harus punya baris
  `live_viewers` dalam 5 menit).
- Laporkan: `app/api/live/reports/route.ts` → `submit_live_report` (memanggil
  `assert_viewer_eligible`; CR1 "fail-closed: reports use the same gate"). Baca laporan:
  `GET` route dengan `requireProducerAccess(request, place_id, ["owner","manager"])`.
- Pemalsuan user id: tidak ada `user_id` yang diterima dari klien di jalur ini —
  `auth.uid()` dipakai di RPC, `userData.user.id` di route.
- Rate limit: `web/lib/live/session-service.ts` → `enforceCommentRateLimit` dengan `Map`
  memori proses (**A-09**).
- Pengguna disuspend: berlaku tidak langsung — suspend hanya menonaktifkan
  `live_eligibility` (start Live), bukan komentar. Lihat A-10.

### 2.6 Produser / siaran

| Aspek | Bukti | Catatan |
| --- | --- | --- |
| Akses antarmuka Creator | `app/developer/layout.tsx` → `requireCreator()` (`lib/auth/creator.ts`, allowlist email di env `SINGGAH_CREATOR_EMAILS`); API `app/api/developer/platform-admins/route.ts`. | Creator dipin di env, bukan role DB — konsisten Authority §4 (Creator bukan `platform_moderator`). |
| Kepemilikan/otorisasi Place | `lib/live/operator-authorization.ts` (`resolvePlaceManagerAuthority`, `hasActiveLiveOperatorAssignment`, `canOperateLiveForPlace`); SQL mirror `0049` → `public.can_operate_live_for_place(uuid,text)` (internal, EXECUTE dicabut dari `public/anon/authenticated`). | Satu predikat dipakai bersama route + RPC. |
| Start | Route: `app/api/live/start/route.ts` (auth + `canOperateLiveForPlace`) dan RPC `start_live_session` (`0049`: `can_operate_live_for_place`), producer_id **diturunkan**, bukan dari klien. | Lihat A-07 untuk endpoint kembar yang lebih ketat. |
| End | `app/api/live/end/route.ts` (Place diturunkan dari **sesi**, bukan dari klien) + RPC `end_live_session` (`0012` + `0049`) dengan idempotency key dan verifikasi alasan (`producer_ended`/`moderation`/`duration_cap`/`source_stage_unpublished`). | Idempoten; percobaan end ulang dengan key sama mengembalikan `true` tanpa baris audit ganda. |
| Reconnect / publish url | `app/api/producer/live/sessions/[sessionId]/publish-url/route.ts` → `getLiveInputPublishUrl` (re-fetch ke Cloudflare dengan token API server; UID saja tidak cukup). | URL publish tidak pernah dipersist/dilog. |
| Konkurensi | global 5 via `pg_try_advisory_xact_lock(hashtext('live_global_start_lock'))` + per-Place 1 via indeks unik parsial; replay idempotency-key. | Dual enforcement. |
| Kelayakan Place | `live_eligibility` (≥1 baris `active`) **per producer**, bukan per Place; grant hanya via `grant_live_eligibility` (platform_moderator) atau dev-seed `lib/live/dev-seed.ts`. | Sesuai policy §2.4/§12.1. |
| Operator delegasi | `live_operators` (`0047`), `live_operator_invitations` (`0048`), authority (`0049`); UI `components/account/account-live-operator-manager.tsx`, route `/api/account/live-operators*`, `/api/live-operator-invitations*`. | Sudah ada di branch/base dan tertutup tes. Invite me-resolve akun **existing** via email dengan respons seragam (tidak ada enumerasi). |

### 2.7 Moderasi

| Aspek | Bukti | Catatan |
| --- | --- | --- |
| Status konten | `live_sessions.content_status in ('ok','review','blocked')` (0008); `moderate_live` action `flag_review`/`resolve_review`/`block_content`; `assert_viewer_eligible` menolak bila `content_status <> 'ok'`. | Set hanya lewat RPC moderator. |
| Flag/`reports` | `live_reports` (unique per session+reporter+category ⇒ idempotent), `live_audit.action='report_submitted'`. | Laporan tidak bisa ada selama gate B1 menolak semua penonton. |
| Suspend | `moderate_live` `'suspend'`: `end_live_session(...,'moderation')` + `update live_eligibility set active=false where producer_id = ...`. | Kapabilitas Live, bukan suspend akun (A-10). |
| Terminate | **Tidak ada** — tidak ada konsep terminate akun/Place di migrasi Live mana pun. | POLICY DECISION (A-10). |
| Gate role | Semua RPC moderasi memeriksa `public.users.platform_role = 'platform_moderator'` di dalam fungsi (`grant_live_eligibility`, `revoke_live_eligibility`, `moderate_live`, `end_live_session` reason `moderation`); UI di balik `requirePlatformModerator`. | Berlapis: EXECUTE untuk `authenticated` hanya transport; otorisasi di dalam fungsi. |
| Log audit | `live_audit` append-only (trigger `block_live_audit_mutation` menolak UPDATE/DELETE; tanpa policy SELECT untuk authenticated; `revoke all ... from public, anon, authenticated`); dibaca server-side oleh `lib/admin/queries.ts` `listAdminAudit()` di balik `requirePlatformModerator`. | `lib/admin/queries.ts` memakai service role untuk pembacaan ini. |
| Duplikat | `end_live_session` idempoten (`detail->>'end_idempotency_key'`); `submit_live_report` `on conflict do nothing`; `admit_live_viewer` upsert. | — |
| Sesi suspend/berakhir masih memberi admisi/kredensial lama? | Admisi baru: `assert_viewer_eligible` menolak `status <> 'live'`. Sesi yang berakhir juga hilang dari `live_sessions_public_read` (`status='live'`). **Kredensial lama**: token playback berumur 60 s tetap valid di provider sampai kedaluwarsa (A-08); penghentian nyata video bergantung pada penghapusan input provider (best-effort + sweep). | A-08. |

### 2.8 Database / RLS / RPC (per objek)

| Objek | RLS | Grant | SECURITY DEFINER | Catatan bukti |
| --- | --- | --- | --- | --- |
| `public.users` | on; `users_self_access` (select self), `users_username_self_update` (update self) | `revoke update` lalu `grant update (username, full_name, date_of_birth, phone_e164, avatar_path)`; **`phone_verified_at` & `platform_role` di luar grant** | trigger `guard_profile_write` (definer, `search_path=public`) + EXECUTE dicabut | 0001/0047/0050 |
| `public.phone_otp_challenges` | on, **0 policy**, `revoke all from public, anon, authenticated` | tidak ada | tidak ada | 0050 |
| `public.record_phone_otp_verification(uuid,text)` | — | EXECUTE: authenticated saja | definer + `search_path=public`; `set_config('singgah.phone_verification','on',true)` untuk membuka guard | 0050; tidak bisa dipakai untuk mengeset verifikasi milik orang lain (actor dari `auth.uid()`) |
| `public.live_sessions` | on; policy select: `live_sessions_public_read` (status live + Place published), `live_sessions_producer_read` (owner/manager/editor), `live_sessions_live_operator_read` (0047) | `grant select ... to anon, authenticated`; DML dicabut | — | **A-02**: select tingkat-baris tanpa pembatasan kolom ⇒ `live_input_id`/`idempotency_key` ikut terbaca `anon` |
| `public.live_viewers` | on; `live_viewers_own_read` | select ke anon+authenticated (praktis nol baris untuk anon) | — | 0008 |
| `public.live_reports` | on; `live_reports_reporter_read`, `live_reports_producer_read` (owner/manager) | select ke anon+authenticated; DML dicabut | — | 0008 |
| `public.live_eligibility` | on; `live_eligibility_producer_read` | select ke anon+authenticated (praktis nol baris untuk anon) | — | 0008 |
| `public.live_audit` | on; **tanpa policy select** | tanpa grant untuk anon/authenticated; append-only trigger | `block_live_audit_mutation` EXECUTE dicabut | 0008/0013 |
| `public.live_operators` | on; `live_operators_self_read`, `live_operators_producer_read` | `grant select to authenticated`; tulis hanya via RPC | `grant_live_operator_access`, `revoke_live_operator_access` (cek owner/manager, `granted_by` diturunkan) | 0047 |
| `public.live_operator_invitations` | on; `..._invitee_read`, `..._manager_read` | `grant select to authenticated` | 6 RPC (`invite/accept/reject/cancel/revoke/list_*`) semuanya menurunkan aktor dari `auth.uid()`; state machine + imutabilitas dipaksa trigger `guard_live_operator_invitation_write`; indeks unik parsial `(place_id) where status='accepted'` dan `(place_id) where revoked_at is null` | 0048 |
| RPC Live publik | — | `assert_viewer_eligible`, `admit_live_viewer`, `post_live_comment`, `submit_live_report`, `start_live_session`, `end_live_session`, `apply_live_duration_cap`, `heal_live_duration_caps`, `release_live_input`, `list_ended_live_inputs`, `moderate_live`, `grant/revoke_live_eligibility`: EXECUTE `authenticated` saja (`public`/`anon` dicabut) | definer + `search_path=public` | **A-03** untuk `release_live_input`/`list_ended_live_inputs` |
| `public.can_operate_live_for_place(uuid,text)` | — | EXECUTE dicabut dari `public, anon, authenticated` | definer | 0049 — benar-benar internal |
| Realtime `realtime.messages` | policy `live_realtime_receive`/`_send` | — | — | 0009 |
| Service role | dipakai di `lib/admin/*`, `lib/creator/*`, `lib/developer/*`, `lib/producer/application.ts`, `lib/place-claim-storage.ts`, `lib/ai-media*`, `lib/account/{avatar-storage,phone-otp-service}.ts`, `lib/supabase/admin.ts` | hanya server (`server-only`), tidak pernah ke klien | — | `lib/supabase/admin.ts` hanya melempar nama env yang hilang, bukan nilai |

**Bypass UI:** untuk setiap operasi terproteksi, `authenticated` biasa **tidak** bisa
memanggil langsung (DML dicabut), tetapi bisa memanggil RPC. Dua RPC Live yang
**tidak** memeriksa otoritas pelaku adalah `release_live_input` dan
`list_ended_live_inputs` (A-03). `apply_live_duration_cap` aman (hanya berlaku bila cap
60 menit sudah lewat, diverifikasi ulang oleh `end_live_session` CR2).
`heal_live_duration_caps` aman (tanpa parameter; hanya menyembuhkan sesi yang kadaluarsa).

### 2.9 Drift repo vs DEV

**NOT-RUN** (lihat §0). Tidak ada `config.toml`, tidak ada akses DB/session DEV.
Bukti tidak langsung dari repo bahwa migrasi Live belum diapply ke DEV: runbook
`docs/runbooks/LIVE_MIGRATION_APPLY_CHECKLIST.md` §0–§7 masih berbentuk checklist
"pre-apply" (expect `to_regclass(...) = null`) untuk `0008` dan `0047`–`0050`, dan
`docs/HANDOFF_LIVE_MVP.md` mencatat blocker B1/B2/B4/B5/B6 + langkah apply DEV. Ini
**indikasi dokumen**, bukan pengukuran DEV — tidak diklaim sebagai hasil.

### 2.10 UI

| Layar | Bukti | Catatan |
| --- | --- | --- |
| Masuk / Daftar | `app/auth/page.tsx`, `app/auth/auth-form.tsx`, `app/auth/sign-up/sign-up-form.tsx` | `force-dynamic`; pesan error dari kode server; tidak ada pesan sukses saat backend menolak (`created !== true` ⇒ error). |
| Status verifikasi akun | `components/account/account-profile-{client,edit-client}.tsx`, `lib/account/profile-view.ts` (`verificationStatusLabel`: "Belum ada" / "Belum terverifikasi" / "Terverifikasi") | Sumber: data server. Tepat tiga grup: **Informasi Pribadi** (foto, nama, username, tanggal lahir), **Kontak** (email read-only), **Verifikasi** (email + telepon). DOB berada di Informasi Pribadi, **bukan** di Verifikasi — tidak menyiratkan DOB = verifikasi. |
| Akses Live terbatas | `app/live/[sessionId]/page.tsx:74`, `app/live/[sessionId]/LiveViewerClient.tsx:160,227,248,280` | **A-05**: teks menyiratkan jalur verifikasi yang bisa diselesaikan. |
| Kontrol produser | `app/producer/live/LiveConsole.tsx` (Mulai/Akhiri Live, camera check, publish URL re-fetch) | Memanggil `/api/live/start`, `/api/live/end`, `/api/producer/live/sessions/{id}/publish-url`. |
| Kontrol moderator/admin | `app/admin/layout.tsx` (guard), `app/admin/live/page.tsx` (read-only), `app/admin/moderation/page.tsx` (read-only + jejak audit) | Halaman admin **tidak** memutasi; aksi enforcement hanya lewat API/RPC. |
| Status sesi | `app/live/[sessionId]/page.tsx` (Berakhir / Sedang tayang), realtime `status` event di klien | — |
| Loading/retry/error | `loading.tsx` admin, `AdminErrorState`, state `playbackError`/`notice` di viewer | Tidak ada klaim sukses palsu yang ditemukan di jalur Live (delivery broadcast gagal ⇒ pesan gagal). |

### 2.11 Cakupan tes

- **Ada** (contoh paling relevan): `web/tests/live-policy.test.ts`,
  `live-privileges.test.ts`, `live-viewer-cap-race.test.ts`, `live-hardening.test.ts`,
  `live-migration-validity.test.ts`, `live-realtime.test.ts`, `live-stream-token.test.ts`,
  `live-comment-rate-limit.test.ts`, `live-comment-moderation.test.ts`,
  `live-operator-authority-migration.test.ts`, `live-operator-authorization.test.ts`,
  `live-operator-invitations-{migration,endpoints}.test.ts`, `live-cleanup-order.test.ts`,
  `auth-sign-up-validation.test.ts`, `auth-claims`→`auth-return-to.test.ts`,
  `account-profile-{model,surface,phone-migration}.test.ts`, `db-regression/*.sql`.
- **Tidak ada** (celah bukti untuk temuan di dokumen ini):
  - yang **ada** di area sign-up hanya sumber-level + unit: `auth-sign-up-validation.test.ts` (validator murni) dan `auth-google-oauth.test.ts` (route menolak `role`/`producer_id` dari klien; badan trigger `handle_new_user` hanya `insert into public.users (id)`). Yang **tidak ada**: tes yang menjalankan `POST /api/auth/sign-up` end-to-end (`auth.signUp` → `auth.users` → trigger → `public.users`), tes semantik kegagalan parsial/retry email yang sama, dan tes yang menegaskan tujuan `emailRedirectTo` cocok dengan handler callback (A-01, S-01).
  - tidak ada tes yang menegaskan kolom mana yang terbaca `anon` dari `live_sessions` (A-02); **catatan Tahap C:** `live-privileges.test.ts` justru **mengunci** grant tingkat-tabel `grant select on public.live_sessions to anon, authenticated;` sebagai perilaku yang diinginkan, jadi perbaikan A-02 harus memperbarui tes itu secara eksplisit;
  - tidak ada tes otorisasi untuk `release_live_input`/`list_ended_live_inputs` (A-03);
  - tidak ada tes untuk semantik jendela kapasitas >5 menit (A-04);
  - tidak ada tes/e2e yang mengukur `scrollWidth <= clientWidth` di viewport nyata dan tidak ada tes runtime untuk admission/realtime (butuh DEV).

---

## 3. Daftar temuan — CONFIRMED

Format: **ID — judul** · tingkat · tahap · butuh keputusan kebijakan.

### A-01 — Tautan konfirmasi email sign-up mengarah ke halaman yang tidak menukar kode · HIGH · Tahap B · tanpa keputusan kebijakan

- Bukti: `web/app/api/auth/sign-up/route.ts:38` → `emailRedirectTo: \`${new URL(request.url).origin}/auth\``; satu-satunya pemanggil `exchangeCodeForSession` adalah `web/app/auth/callback/route.ts:43`; `web/app/auth/auth-form.tsx` tidak memiliki pembacaan `code` (grep `code` hanya menemukan `?error=` dan `provider`).
- Dampak: tautan konfirmasi mendarat di `/auth`, yang tidak menukar `code` (alur PKCE/cookie `@supabase/ssr`) sehingga sesi pasca-konfirmasi tidak terbentuk; pengguna harus masuk manual dan UI tidak pernah menyatakan konfirmasi berhasil. Ini juga membuat `email_confirmed_at` tidak dapat dipastikan lewat jalur aplikasi.
- Perbaikan yang diusulkan: arahkan `emailRedirectTo` ke `/auth/callback?next=/auth` (atau halaman `/auth/confirm` yang menukar `code`/`token_hash` lalu menampilkan status konfirmasi Indonesia), dan tambahkan tes yang menegaskan tujuan redirect selalu punya handler.
- Tes pembuktian: belum ada → ditambahkan sebagai tes karakterisasi (A-01) di `web/tests/audit/`.

### A-02 — `anon`/`authenticated` dapat membaca `live_input_id` dan `idempotency_key` dari `live_sessions` · MEDIUM · Tahap C · tanpa keputusan kebijakan

- Bukti: `web/supabase/migrations/0008_live_sessions.sql` → `grant select on public.live_sessions to anon, authenticated;` + policy `live_sessions_public_read` (`status='live'` dan Place `published`). RLS adalah pembatasan **baris**, bukan kolom, sehingga seluruh kolom — termasuk `live_input_id` (UID input Cloudflare) dan `idempotency_key` — terbaca oleh siapa pun yang memegang anon key.
- Dampak: membocorkan identifier provider dan kunci idempotensi produser ke publik/anon; bertentangan dengan `MASTER_LIVE_TECH_v1.0.md` §1.2/§5 ("`live_input_id` … server-side only", "Stream credentials are server-side only"). Bukan eskalasi langsung: URL publish hanya bisa di-fetch dengan token API server (`lib/live/cloudflare.ts` `getLiveInputPublishUrl`) dan playback menuntut token bertanda tangan, jadi nilainya bersifat recon/pelanggaran kebijakan.
- Perbaikan: cabut `select` tingkat-tabel lalu berikan GRANT kolom eksplisit **tanpa** `live_input_id`/`idempotency_key` (atau ekspos lewat view/RPC khusus), dan batasi `select *` di route aplikasi ke daftar kolom.
- Catatan Tahap C: `web/tests/live-privileges.test.ts` mengunci grant tingkat-tabel ini sebagai perilaku yang diinginkan, jadi perbaikan harus memperbarui tes tersebut, bukan hanya migrasi baru.
- Tes pembuktian: ditambahkan sebagai tes karakterisasi (A-02).

### A-03 — `release_live_input` dan `list_ended_live_inputs` tidak memeriksa otoritas pemanggil · MEDIUM · Tahap B/C · tanpa keputusan kebijakan

- Bukti: `0008` (badan fungsi) — `release_live_input(p_session_id text)` hanya memverifikasi `status='ended'`, tanpa `can_operate_live_for_place`; `list_ended_live_inputs()` mengembalikan `live_input_id` **semua** sesi `ended` (limit 50) tanpa scope Place. Keduanya di-grant ke `authenticated` (`0008` dan `0013_live_rpc_privilege_lockdown.sql`).
- Dampak: (1) setiap akun terautentikasi bisa mengosongkan `live_input_id` sesi `ended` milik pihak lain — memutus kontrak cleanup "pointer dulu, hapus provider" (PO item 10) dan meninggalkan input provider yatim tanpa retry handle; (2) enumerasi UID input sesi `ended` lintas tenant, termasuk Place yang tidak published (melewati RLS karena SECURITY DEFINER). Belum bisa disalahgunakan untuk menonton/menyiarkan, tetapi jelas operasi lintas tenant.
- Perbaikan: tambahkan pemeriksaan `can_operate_live_for_place(auth.uid(), <place sesi>)` di kedua RPC (atau turunkan grant ke service role dan panggil hanya dari route server).
- Tes pembuktian: ditambahkan sebagai tes karakterisasi (A-03).

### A-04 — Batas 100 penonton konkuren tidak menghitung penonton yang bertahan >5 menit · MEDIUM · Tahap C · tanpa keputusan kebijakan

- Bukti: `0027_live_viewer_cap_race_guard.sql` (dan `0008`) `admit_live_viewer`:
  `select count(*) ... from public.live_viewers where live_session_id = p_session_id and admitted_at > now() - interval '5 minutes'` lalu `if v_concurrent >= 100 then raise exception 'live_capacity_full'`. Policy `0009` `live_realtime_receive` memakai jendela 5 menit yang sama.
- Dampak: "100" = *concurrent* (policy §6, §12.2 #1) tetapi implementasinya adalah "admission dalam 5 menit terakhir". Penonton yang menonton >5 menit berhenti dihitung; 100 admission pada T dan 100 lagi pada T+6 menit menghasilkan ~200 penonton nyata dengan hitungan 100. `viewer_peak` juga ter-understatement. Saat ini dampaknya nol karena B1 menolak semua penonton, tetapi menjadi nyata begitu mekanisme usia Phase 2.1 aktif.
- Perbaikan: hitung konkurensi dari presence Realtime (sesuai `MASTER_LIVE_TECH_v1.0.md` §6) atau lease/heartbeat eksplisit dengan kedaluwarsa server-side, bukan jendela admission.
- Tes pembuktian: ditambahkan sebagai tes karakterisasi (A-04).

### A-05 — Salinan UI menyiratkan jalur verifikasi yang bisa diselesaikan · MEDIUM · Tahap C (+salinan UI) · tanpa keputusan kebijakan

- Bukti: `web/app/live/[sessionId]/page.tsx:74` "Akses Live memerlukan akun terverifikasi (email terverifikasi + usia ≥ 18)."; `web/app/live/[sessionId]/LiveViewerClient.tsx:280` "Menunggu verifikasi akses Live (email terverifikasi + usia ≥ 18).", serta pemetaan error 160/227/248.
- Dampak: menyiratkan bahwa penonton dapat memenuhi syarat (padahal tidak ada mekanisme verifikasi usia; gate menolak semua), dan menampilkan keadaan berharap ("Menunggu verifikasi") di tempat backend memberi penolakan permanen. Bertentangan dengan aturan UI yang sudah dipegang proyek (jangan mengklaim/menyiratkan hasil yang tidak terjadi; "status messages … never claim success when an operation fails", `UI_TERMINOLOGY_STANDARD.md` §1).
- Perbaikan: nyatakan kapabilitas apa adanya (mis. "Verifikasi usia belum tersedia — akses menonton Live belum dapat diberikan.") dan hapus kata "Menunggu …" pada jalur yang pasti ditolak; jaga agar syarat tetap disebut sebagai syarat, bukan langkah yang bisa diselesaikan.
- Tes pembuktian: copy dikunci sebagian oleh `live-ui.test.ts`; tes baru diperlukan saat teks berubah (belum ada tes untuk kalimat ini).

### A-06 — Tidak ada syarat email terverifikasi untuk Operator Live / start Live · MEDIUM · Tahap B · **POLICY DECISION NEEDED**

- Bukti: `0048_live_operator_invitations.sql` → `accept_live_operator_invitation` hanya memeriksa `invited_user_id = auth.uid()`; tidak ada `auth.users.email_confirmed_at`. `0049` `can_operate_live_for_place` tidak memeriksa verifikasi email. `start_live_session` (`0049`) tidak memeriksa `email_confirmed_at`. Bandingkan dengan penonton yang wajib email terverifikasi (`0008` `assert_viewer_eligible`).
- Dampak: akun dengan email belum terverifikasi dapat memegang otoritas Operator Live dan menyiarkan Live untuk Place, sedangkan penonton dengan kondisi sama ditolak. Apakah itu disengaja tidak dinyatakan master: `MASTER_LIVE_POLICY §2.2` hanya menuntut otorisasi Place, `MASTER_LIVE_TECH §4.2` tidak mencantumkan prasyarat email untuk producer → **tidak diputuskan**, jangan dipilih sendiri.
- Perbaikan (setelah keputusan): tambahkan pemeriksaan `email_confirmed_at is not null` pada start/invite-accept, atau nyatakan eksplisit bahwa producer tidak menuntut verifikasi email.
- Tes pembuktian: belum ada.

### A-07 — Dua endpoint start/end yang kembar menilai otoritas operator secara berbeda · LOW · Tahap B · tanpa keputusan kebijakan

- Bukti: `web/app/api/live/start/route.ts` memakai `canOperateLiveForPlace` (owner/manager **atau** operator aktif), sedangkan `web/app/api/producer/live/sessions/route.ts` (POST) memakai `requireProducerAccess(request, placeId, ["owner","manager"])` → operator aktif ditolak 403. `DELETE` pada route yang sama sudah memakai `canOperateLiveForPlace`. `0049` secara eksplisit menyatakan tujuannya "so the two layers can never disagree".
- Dampak: perilaku tidak konsisten antar endpoint (fail-closed, jadi bukan celah keamanan). UI produser memakai `/api/live/start` sehingga operator tetap bisa memulai; route kembar tetap menjadi jebakan untuk pemakaian berikutnya.
- Perbaikan: samakan ke `canOperateLiveForPlace` di POST route itu, atau hapus route kembar bila tidak terpakai.
- Tes pembuktian: `live-operator-invitations-endpoints.test.ts` menguji route `/api/live-operator-invitations*`, bukan route kembar ini.

### A-08 — Pencabutan playback setelah Live berakhir bergantung pada sweep; token tetap valid selama TTL · LOW · Tahap D · tanpa keputusan kebijakan

- Bukti: `lib/live/stream-token.ts` (TTL 60 s, tanda tangan RS256, tidak ada jalur revokasi selain menghapus kunci); `lib/live/session-service.ts` `endLiveSession` menghapus input provider **hanya** pada jalur wrapper route; `lib/live/session-service-cap.ts` `sweepEndedLiveInputs()` (dipanggil dari `app/api/live/status/route.ts` — best-effort, tanpa scheduler). Jalur end di dalam RPC (duration cap, trigger stage unpublish, `moderate_live`) tidak menghapus input provider sendiri.
- Dampak: setelah Live dimoderasi/diakhiri lewat jalur internal, playback dapat berlanjut sampai (a) TTL token habis, dan (b) ada yang memanggil `/api/live/status` sehingga sweep berjalan; bila tidak ada yang polling, input provider bisa tetap hidup. Terbatas 60 s + latensi sweep, dan saat ini moot (tidak ada penonton yang diadmit).
- Perbaikan: hapus input provider langsung di jalur moderation/end (via wrapper service), atau tambahkan scheduler untuk sweep; dokumentasikan batas latensi pencabutan.
- Tes pembuktian: `live-cleanup-order.test.ts` menguji urutan pointer/hapus, bukan latensi pencabutan.

### A-09 — Rate limit komentar tersimpan di memori proses · LOW · Tahap C · tanpa keputusan kebijakan

- Bukti: `web/lib/live/session-service.ts` → `const commentTimestamps = new Map<string, number[]>()` + `enforceCommentRateLimit(...)`.
- Dampak: pada multi-instance/serverless, batas "≈1/5 s per penonton" (policy §12.1 item 6, TUNABLE) bisa dilewati dengan menyebar permintaan antar instance. Risiko rendah (komentar ephemeral, moderasi konten tetap jalan) dan mekanisme memang ditandai TUNABLE di `MASTER_LIVE_TECH §6/§10`.
- Perbaikan: mekanisme shared (mis. Redis/Upstash) atau pembatasan di RPC dengan penyimpanan kanonik.
- Tes pembuktian: `live-comment-rate-limit.test.ts` menguji perilaku per-proses.

### A-10 — Tidak ada mekanisme suspend/terminate akun; hanya kapabilitas Live produser · LOW · Tahap D · **POLICY DECISION NEEDED**

- Bukti: `grep -rni "suspend"` → `0008`/`0012` `moderate_live` action `'suspend'` yang hanya menjalankan `end_live_session(...,'moderation')` + `update public.live_eligibility set active=false where producer_id = ...`. Tidak ada kolom/status suspend akun di `public.users` atau tabel lain; tidak ada istilah "terminate" di migrasi mana pun.
- Dampak: kebutuhan audit butir 2/7 "akun disuspend" dan "terminate" **tidak terimplementasi**: akun yang "disuspend" masih bisa masuk, mengomentari Live Place lain (bila kelak eligible), dan mengirim Visit Intent. Policy §12.1 item 5 memang mendefinisikan suspend sebagai kapabilitas Live level-akun, jadi implementasi saat ini **sesuai** untuk Live; yang tidak terdefinisi adalah suspend akun secara platform.
- Perbaikan: butuh keputusan produk lebih dulu (apakah suspend akun platform ada). Bila ya → kolom status kanonik + pemeriksaan di guard/tiap request.
- Tes pembuktian: belum ada.

### A-11 — Tidak ada permukaan pembaca `live_audit` untuk peran selain Platform Moderator (termasuk producer atas Live-nya sendiri) · LOW · Tahap D · **POLICY DECISION NEEDED**

- Bukti: `0008` — `live_audit` tanpa policy SELECT dan tanpa grant untuk `authenticated`; satu-satunya pembaca adalah `lib/admin/queries.ts` `listAdminAudit()` di balik `requirePlatformModerator` (service role). `app/admin/moderation/page.tsx` menampilkan jejak audit.
- Dampak: producer tidak punya cara melihat audit Live miliknya (mis. mengapa sesi berakhir `source_stage_unpublished`), sedangkan policy §8 mewajibkan audit trail ada (dan itu terpenuhi — penulisannya ada) tetapi tidak menyatakan siapa yang boleh membaca. Sesuai `MASTER_LIVE_TECH §3` ("no direct SELECT for authenticated"), jadi implementasi konsisten dengan tech master; pertanyaannya produk: apakah produser perlu visibilitas audit Live-nya.
- Perbaikan: bila ya, sediakan RPC read-only ber-scope Place di balik `can_operate_live_for_place`.
- Tes pembuktian: `live-hardening.test.ts`/`live-privileges.test.ts` mengunci kondisi "audit gelap".

---

## 4. Temuan — SUSPECTED (butuh verifikasi)

| ID | Tingkat | Dugaan | Cara verifikasi | Tahap |
| --- | --- | --- | --- | --- |
| S-01 | HIGH | Pada project dengan email confirmation aktif, jalur `signUp` + trigger `handle_new_user` belum pernah diuji end-to-end: apakah kegagalan trigger (mis. RLS/permission) membatalkan `auth.users` dan apakah retry email yang sama menghasilkan satu baris `public.users`. | DEV: jalankan sign-up pada project DEV, periksa jumlah baris `auth.users` vs `public.users`, lalu ulangi email sama. | B |
| S-02 | MEDIUM | Efek nyata A-01 bergantung pada template email DEV (apakah memakai `{{ .ConfirmationURL }}` dengan `redirect_to` atau tautan kustom). | DEV: lihat template email konfirmasi di dashboard + klik tautan sungguhan. | B |
| S-03 | MEDIUM | Drift migrasi repo vs DEV (0008/0047–0050 sudah/belum diapply; definisi fungsi usang seperti `end_live_session(text,text,text)` 3-argumen). | DEV: `select to_regproc(...)`, `information_schema`, bandingkan dengan repo. | semua |
| S-04 | MEDIUM | `assert_viewer_eligible` benar-benar dijalankan untuk join Realtime dan broadcast komentar (bukan hanya diuji statis). | DEV/e2e dengan penonton sintetis; periksa penolakan join pada channel privat. | C |
| S-05 | LOW | Perilaku rate limit & delivery broadcast di bawah beban (socket turun, REST fallback timeout) belum diukur di runtime. | DEV/e2e beban. | C |

---

## 5. Matriks peran–izin (peran yang ADA di produk; tidak ada peran baru)

Peran ditemukan di produk: **anon** (tanpa akun), **Penonton terautentikasi**,
**Pengelola Tempat** (owner/manager via `producer_memberships`), **Editor**
(`producer_memberships.role='editor'`), **Operator Live** (`live_operators` aktif),
**Platform Admin/Moderator** (`users.platform_role='platform_moderator'`),
**Creator/Owner/Developer** (allowlist email `SINGGAH_CREATOR_EMAILS`), **Service role**
(infrastruktur). Aksi: tonton, komentar, laporkan, start, end, moderasi, suspend,
terminate, lihat audit log, kelola kelayakan.

Keterangan kolom: **Keputusan** = Diizinkan/Ditolak menurut kebijakan; **Sumber** =
dokumen + bagian; **Penegakan** = fungsi/RLS/route aktual; **UI** = lokasi UI;
**Status** = ADA / SEBAGIAN / TIDAK ADA; **Perbaikan** = ID temuan.

### 5.1 anon (tanpa akun)

| Aksi | Keputusan | Sumber | Penegakan | UI | Status | Perbaikan |
| --- | --- | --- | --- | --- | --- | --- |
| tonton | Ditolak | LIVE_POLICY §2.1 ("no anonymous viewing") | `assert_viewer_eligible` (auth.uid() null ⇒ deny); `live_sessions_public_read` hanya metadata | `/live/[sessionId]` menampilkan status gate | ADA | — |
| komentar/laporkan | Ditolak | §2.1 ("no anonymous commenting") | route 401 + `assert_viewer_eligible` | — | ADA | — |
| start/end/moderasi/suspend/terminate/audit/kelayakan | Ditolak | AUTHORITY §7 (User: no operational authority) | EXECUTE RPC dicabut dari `anon` | — | ADA | — |
| catatan | — | — | `grant select` ke `anon` pada `live_sessions` mengekspos kolom provider | — | — | **A-02** |

### 5.2 Penonton terautentikasi (email terverifikasi + usia terverifikasi)

| Aksi | Keputusan | Sumber | Penegakan | UI | Status | Perbaikan |
| --- | --- | --- | --- | --- | --- | --- |
| tonton | Diizinkan | §2.1 + §12.1 #3 | `assert_viewer_eligible` — **saat ini DENY untuk semua** karena mekanisme usia Phase 2.1 belum ada (§12.2 #2) | `/live/[sessionId]` + `LiveViewerClient` | SEBAGIAN (gate fail-closed, mekanisme usia belum ada) | A-05 (salinan UI) |
| komentar | Diizinkan (dengan limit) | §12.1 #6 | `post_live_comment` + rate limit proses | viewer client | SEBAGIAN | A-09 |
| laporkan | Diizinkan | §5.2 | `submit_live_report` | viewer client + `admin/moderation` | SEBAGIAN | — |
| moderasi/suspend/terminate/audit/kelayakan | Ditolak | AUTHORITY §7 | RPC butuh `platform_moderator` | — | ADA | — |

### 5.3 Pengelola Tempat (owner/manager)

| Aksi | Keputusan | Sumber | Penegakan | UI | Status | Perbaikan |
| --- | --- | --- | --- | --- | --- | --- |
| tonton/komentar/laporkan | Diizinkan hanya lewat gate penonton yang sama | §2.1 | `assert_viewer_eligible` (tidak ada pengecualian Owner) | viewer | ADA | — |
| start | Diizinkan (owner/manager + Place published + eligibility ≥1 aktif + stage published + cap) | §2.2, §2.4, §6, TECH §4.2 | `can_operate_live_for_place` + `start_live_session` | `LiveConsole` | ADA | A-07 |
| end | Diizinkan | §2.2 | `end_live_session` reason `producer_ended` (Place sesi) | `LiveConsole` | ADA | — |
| moderasi/suspend/terminate | Ditolak | §5.1, §12.2 #3 ("Producers … cannot moderate") | RPC butuh `platform_moderator` | tidak ada | ADA | — |
| lihat audit log | Tidak didefinisikan | — (TECH §3 hanya mengatur authenticated) | audit gelap untuk authenticated | tidak ada | TIDAK ADA | **A-11 → POLICY DECISION NEEDED** |
| kelola kelayakan | Ditolak (hanya produser sendiri yang bisa dibaca) | §12.2 #5 (grant hanya lewat Platform Admin/Moderator) | `grant/revoke_live_eligibility` butuh `platform_moderator` | `/admin/live` (read-only) | ADA | — |
| kelola Operator Live (di luar matriks Live inti) | Diizinkan | 0047/0048 (kebijakan produk yang sudah ada) | `grant/revoke_live_operator_access`, `invite/cancel/revoke_live_operator_invitation` | `account-live-operator-manager.tsx` | ADA | — |

### 5.4 Editor (`producer_memberships.role='editor'`)

| Aksi | Keputusan | Sumber | Penegakan | UI | Status | Perbaikan |
| --- | --- | --- | --- | --- | --- | --- |
| start/end | Ditolak | TECH §2 ("Editors cannot start/end Live") | `start/end_live_session` hanya owner/manager/operator aktif | UI produser read-only | ADA | — |
| baca sesi Live Place-nya | Diizinkan | TECH §3 (`live_sessions_producer_read` mencakup editor) | policy 0008 | `/producer/live` | ADA | — |
| tonton/komentar | Tidak didefinisikan master | — | gate penonton yang sama akan berlaku | viewer | — | **POLICY DECISION NEEDED** (bolehkan editor menonton tanpa gate penonton? Jawaban default: tidak — gate yang sama) |

### 5.5 Operator Live (delegasi aktif)

| Aksi | Keputusan | Sumber | Penegakan | UI | Status | Perbaikan |
| --- | --- | --- | --- | --- | --- | --- |
| start/end | Diizinkan untuk **satu** Place dengan assignment aktif, selama eligibility produser aktif | 0047/0048/0049 (tidak ada bagian master yang menyebut Operator; kebijakan produk = kebijakan yang sudah ditetapkan pemilik) | `can_operate_live_for_place` (route) + `start/end_live_session` (RPC) | `LiveConsole`; `account-live-access-client` | ADA | A-07; A-06 (email) |
| start via `/api/producer/live/sessions` | Ditolak (inkonsisten dengan RPC) | — | `requireProducerAccess(owner,manager)` | tidak dipakai UI | SEBAGIAN | **A-07** |
| moderasi/suspend | Ditolak | §5.1 | RPC butuh `platform_moderator` | — | ADA | — |
| email terverifikasi sebagai prasyarat | Tidak didefinisikan | — | tidak diperiksa | — | TIDAK ADA | **A-06 → POLICY DECISION NEEDED** |

### 5.6 Platform Admin / Moderator (`platform_moderator`)

| Aksi | Keputusan | Sumber | Penegakan | UI | Status | Perbaikan |
| --- | --- | --- | --- | --- | --- | --- |
| moderasi (warn/flag/block/end) | Diizinkan | §5.1, §12.1 #5, §12.2 #3 | `moderate_live` (cek role di dalam RPC) | `/admin/live`, `/admin/moderation` (read-only) | ADA | — |
| suspend | Diizinkan (kapabilitas Live produser) | §12.1 #5 ("account-level, not Place-level" untuk kapabilitas Live) | `moderate_live('suspend')` → `live_eligibility.active=false` | — (API) | ADA | A-10 (suspend akun platform tidak ada) |
| terminate | Tidak didefinisikan | — | tidak ada | tidak ada | TIDAK ADA | **A-10 → POLICY DECISION NEEDED** |
| lihat audit log | Diizinkan | §8 (audit trail wajib) | `listAdminAudit` + `requirePlatformModerator` (service role) | `/admin/moderation` | ADA | — |
| kelola kelayakan | Diizinkan | §12.2 #5, §2.4 | `grant/revoke_live_eligibility` | `/api/admin/live/eligibility` (API) | ADA (UI aksi belum ada — halaman read-only) | — |
| tonton/komentar sebagai pengguna | Gate penonton yang sama | §2.1 | `assert_viewer_eligible` (tanpa pengecualian admin) | viewer | ADA | — |

### 5.7 Creator / Owner / Developer

| Aksi | Keputusan | Sumber | Penegakan | UI | Status | Perbaikan |
| --- | --- | --- | --- | --- | --- | --- |
| moderasi Live | **Ditolak** kecuali lewat akun Platform Admin terpisah | AUTHORITY §4 ("Creator is NOT `platform_moderator`") | tidak ada jalur Creator di RPC Live | `/developer*` (gate Creator) | ADA | — |
| kelola Platform Admin | Diizinkan | AUTHORITY §2/§5 | `app/api/developer/platform-admins` + `requireCreator` | `/developer` | ADA | — |
| kelola kelayakan Live | Hanya via akun Platform Admin | §12.2 #5 | RPC butuh `platform_moderator` | — | ADA | — |
| akses kredensial stream | Diizinkan (env server) | AUTHORITY §3, TECH §5 | env server-only (`CLOUDFLARE_*`, `CLOUDFLARE_STREAM_SIGNING_KEY*`) | — | ADA | — |

### 5.8 Service role (infrastruktur)

| Aksi | Keputusan | Sumber | Penegakan | Status |
| --- | --- | --- | --- | --- |
| baca kanonik lintas-tenant (admin, archive, audit) | Diizinkan, hanya di server | AUTHORITY §2/§3 | `lib/supabase/admin.ts` (`server-only`) di balik guard per-modul | ADA |
| tulis data kanonik | Dibatasi trigger DB (mis. `guard_profile_write` menolak `phone_verified_at` di luar RPC OTP) | 0050 | trigger definer | ADA |

---

## 6. Riset provider verifikasi usia

**NOT-RUN (tanpa akses web pada tahap ini).** Tidak ada vendor yang dipilih, tidak ada
klaim integrasi. Yang ditulis hanya kerangka kriteria evaluasi agar keputusan bisa
diambil tanpa mengarang fakta vendor.

Kerangka kriteria (setiap kandidat dinilai pada semua baris, dengan sumber + tanggal akses):

1. **Metode verifikasi** — verifikasi dokumen identitas, verifikasi berbasis data
   pemerintah, verifikasi wajah/biometrik, atau verifikasi berbasis bank/telekomunikasi;
   apakah hasilnya menyatakan **usia ≥ 18** atau hanya "identitas terverifikasi".
2. **Kesesuaian dengan kebijakan yang sudah terkunci** — keluaran harus bisa
   menghasilkan satu fakta server-side "usia terverifikasi ≥ 18" yang bisa dibaca
   `assert_viewer_eligible`; self-declared DOB tidak boleh dianggap bukti
   (`MASTER_LIVE_POLICY §12.1 #3`).
3. **Ketersediaan di Indonesia** — dukungan wilayah, dokumen yang diterima (KTP/identitas
   lain), bahasa UI, dan cakupan populasi.
4. **Persyaratan integrasi** — mode (SDK/webview/redirect), webhook status, idempotency
   callback, replay/anti-replay, masa berlaku hasil, endpoint penarikan/penghapusan, dan
   kebutuhan akun bisnis + verifikasi (KYC) pada sisi vendor.
5. **Privasi dan UU PDP** — data apa yang dikirim (PII/biometrik), lokasi penyimpanan
   data, dasar pengolahan (persetujuan eksplisit?), retensi di sisi vendor, peran
   data processor, dan apakah vendor mengizinkan penyimpanan **hanya** hasil boolean
   `age_verified_at` (disarankan: jangan simpan dokumen/biometrik di DB kita).
6. **Model biaya** — harga per verifikasi/dashboard, biaya minimum, kuota, dan implikasi
   pada penonton dengan volume tinggi; catat mata uang dan apakah harga dikenakan per
   pengguna unik atau per percobaan.
7. **Keamanan & operasional** — autentikasi API, rotasi kredensial, SLA, insiden,
   dukungan bahasa, dan apakah hasil dapat disimulasikan (sandbox) untuk DEV.
8. **Risiko produk** — friksi penonton (boleh menonton tanpa verifikasi? tidak — §2.1),
   dan apa yang terjadi pada penonton yang gagal verifikasi (harus DENY, §5.3).

### Keputusan persis yang dibutuhkan dari pemilik produk (§12 policy "do not resolve by assumption")

| # | Keputusan yang dibutuhkan | Mengapa tidak bisa diputuskan oleh audit |
| --- | --- | --- |
| P1 | **Vendor/metode** verifikasi usia (atau keputusan "tetap DENY tanpa batas waktu") | `MASTER_LIVE_TECH §2.1` menyebut mekanisme **BLOCKED** dan tidak mengizinkan implementasi mengarang vendor. |
| P2 | **Data apa** yang boleh dikirim ke vendor dan **apa yang boleh disimpan** di DB (usulan minimal: `age_verified_at timestamptz` + `verification_provider text` + `verification_reference text`; tanpa dokumen/biometrik) | Kebijakan retensi/PII untuk verifikasi usia belum ada di master mana pun (§2.3). |
| P3 | **Retensi & penghapusan** catatan verifikasi usia, dan mekanisme re-verifikasi saat hasil kedaluwarsa | `MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0.md` hanya mengatur arsip klaim Place, bukan verifikasi usia. |
| P4 | Apakah **email terverifikasi** menjadi prasyarat untuk producer/operator Live (A-06) | Tidak diputuskan di `MASTER_LIVE_POLICY §2.2` / `MASTER_LIVE_TECH §4.2`. |
| P5 | Apakah **suspend/terminate akun level platform** ada sebagai konsep (A-10) | `§12.1 #5` mendefinisikan suspend sebagai kapabilitas Live level akun; suspend akun penuh tidak didefinisikan. |
| P6 | Apakah **produser** boleh membaca audit trail Live-nya sendiri (A-11) | `MASTER_LIVE_TECH §3` hanya menyatakan authenticated tidak bisa; siapa yang boleh tidak dinyatakan. |
| P7 | Apakah **editor** boleh menonton/berkomentar di Live Place-nya tanpa gate penonton | Tech master mengatur read sesi, tidak mengatur partisipasi penonton editor. |

### Kredensial/konfigurasi yang dibutuhkan dari pemilik produk (bukan rahasia di repo)

| Kode | Yang dibutuhkan | Untuk |
| --- | --- | --- |
| B1 | Keputusan vendor + kredensial verifikasi usia (P1–P3) | membuka gate `assert_viewer_eligible` (Phase 2.1) |
| B4 | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (server env) | create/delete live input, health check |
| B4b | `CLOUDFLARE_STREAM_SIGNING_KEY_ID`, `CLOUDFLARE_STREAM_SIGNING_KEY` (JWK base64, server env) | token playback bertanda tangan |
| B5 | Provider SMS/OTP (keputusan vendor) | jalur kirim kode `/api/account/phone/otp` (saat ini `phone_otp_provider_not_configured`) |
| B6 | `PHONE_OTP_HASH_SECRET` (server env) | hash kode OTP |
| B7 | `SINGGAH_CREATOR_EMAILS` (server env) | allowlist Creator |
| — | Akses DEV (CLI/DB) atau apply migrasi 0008 + 0047–0050 | menutup drift S-03 dan mengaktifkan uji DEV |

---

## 7. Catatan cakupan & hal yang sengaja tidak diubah

- Tidak ada perubahan kode aplikasi, migrasi, atau kebijakan di tahap ini. Perubahan
  hanya: dokumen ini + tes karakterisasi di `web/tests/audit/`.
- `assert_viewer_eligible` dan `admit_live_viewer` **tidak dilemahkan** — justru
  diverifikasi tetap fail-closed.
- Temuan lama di luar cakupan yang tetap dibiarkan terbuka (bukan diam-diam
  diperbaiki): teks `/help` masih memuat frasa lama "Setting → Notification Settings"
  (`docs/UI_TERMINOLOGY_STANDARD.md` §3 menetapkan "Pengaturan Notifikasi").
- Tidak ada akses produksi, tidak ada perubahan env, tidak ada data yang disentuh.

## 8. Verifikasi (label RAN-PASSED / RAN-FAILED / NOT-RUN)

Dijalankan pada `audit/live-auth-baseline` setelah dokumen + tes karakterisasi dibuat.

| Perintah | Label | Hasil |
| --- | --- | --- |
| `bunx tsx --test tests/audit/live-auth-audit-defects.test.ts` | **RAN-PASSED** | `# tests 6 # pass 6 # fail 0`, `TEST_EXIT=0` |
| `bun tsc -b --noEmit` | **RAN-PASSED** | `TSC_EXIT=0` (tanpa output) |
| `bunx eslint .` | **RAN-PASSED** | `✖ 11 problems (0 errors, 11 warnings)`, `ESLINT_EXIT=0` — 11 warning sudah ada sebelumnya (berkas generated Convex + 3 tes lama), **0 error** dan tidak ada temuan pada berkas audit baru |
| Full suite serial per chunk (`tests/**/*.test.ts`, 136 berkas, 9 chunk) | **RAN-PASSED** | Total **1424 tes, 0 fail, 0 cancelled** (lihat §9) |
| DEV: drift migrasi / state tabel / uji klik-nyata / e2e | **NOT-RUN** | tidak ada akses DEV (CLI absen + env diblokir platform) — lihat §0 |
| Riset provider verifikasi usia (web) | **NOT-RUN** | tanpa akses web pada tahap ini; hanya kerangka kriteria (§6) |
| Pengukuran viewport nyata 360/390px | **NOT-RUN** | tidak ada Playwright/Puppeteer di repo; bukan bagian cakupan tahap ini |

Tidak ada tes/build yang gagal. Tidak ada kegagalan lama yang diperbaiki di tahap ini.

## 9. Output mentah perintah (ditempel apa adanya)

```
$ bunx tsx --test tests/audit/live-auth-audit-defects.test.ts
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 301.216676
TEST_EXIT=0

$ bun tsc -b --noEmit
TSC_EXIT=0

$ bunx eslint .
✖ 11 problems (0 errors, 11 warnings)
ESLINT_EXIT=0

$ # full suite, 9 chunk (find tests -name "*.test.ts" | sort | sed -n 'A,Bp')
chunk 1-18   : # tests 196  # pass 196  # fail 0   (duration_ms 149796)
chunk 19-33  : # tests 150  # pass 150  # fail 0   (duration_ms 78373)
chunk 34-48  : # tests 203  # pass 203  # fail 0   (duration_ms 95576)
chunk 49-63  : # tests 153  # pass 153  # fail 0   (duration_ms 34891)
chunk 64-78  : # tests 124  # pass 124  # fail 0   (duration_ms 100563)
chunk 79-93  : # tests 231  # pass 231  # fail 0   (duration_ms 97679)
chunk 94-108 : # tests 141  # pass 141  # fail 0   (duration_ms 160756)
chunk 109-123: # tests 118  # pass 118  # fail 0   (duration_ms 62197)
chunk 124-136: # tests 108  # pass 108  # fail 0   (duration_ms 4375)
CHUNK_STATUS=0 pada setiap chunk

TOTAL: 1424 tes, 0 fail, 0 cancelled, 0 skipped, 0 todo (136 berkas, semua chunk tercakup)
```
