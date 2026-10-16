import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

/**
 * ADMIN-REVOKE — kontrak route + UI (statis) dan render tipe notifikasi baru.
 *
 * Perilaku otorisasi/DB sudah dibuktikan pada Postgres nyata di
 * tests/admin-revoke-place-access.test.ts. Di sini yang dikunci adalah
 * kontrak yang TIDAK bisa dijalankan di sandbox ini (Next route handler +
 * render React server component tetap butuh server/browser — lihat laporan:
 * uji browser = NOT RUN):
 * - route admin: guard Platform Admin per request, hanya membership id dari
 *   klien, pesan dari server, tidak pernah 200 palsu;
 * - aksi + dialog konfirmasi di tabel Data Pengelola (konfirmasi wajib, tombol
 *   terkunci, keadaan sukses/error/peringatan notifikasi, aksi merujuk
 *   Produser + Tempat, tanpa overflow mobile);
 * - tabel tetap satu pencarian + satu tabel dengan urutan kanonik;
 * - halaman/menu notifikasi yang ada merender tipe baru tanpa navigasi duplikat.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

const route = read("../app/api/admin/producer-memberships/[membershipId]/revoke/route.ts");
const service = read("../lib/admin/producer-membership-revoke.ts");
const reasonPolicy = read("../lib/admin/revoke-reason.ts");
const table = read("../app/admin/producer-membership/AdminPengelolaTable.tsx");
// ADMIN-PLACE-REVOKE (2026-10-14): the dialog + request were EXTRACTED from the
// table into ONE shared component, reused by the Place-detail "Pengelola"
// section. Markup/structure assertions point at the shared component; the
// table keeps its surface-only assertions (label literal, column order, banner).
const revokeDialog = read("../components/admin/producer-access-revoke-dialog.tsx");
const page = read("../app/admin/producer-membership/page.tsx");
const queries = read("../lib/admin/queries.ts");
const auditFormat = read("../lib/place-audit-format.ts");
const producer = read("../lib/producer.ts");
const inboxItem = read("../components/notification-inbox-item.tsx");
const notificationsPage = read("../app/notifications/page.tsx");
const model = read("../lib/notifications-model.ts");

// ---------------------------------------------------------------------------
// 1. Route
// ---------------------------------------------------------------------------

test("route admin ada, dinamis, dan menjaga otorisasi di server", () => {
  assert.ok(
    existsSync(new URL("../app/api/admin/producer-memberships/[membershipId]/revoke/route.ts", import.meta.url)),
  );
  assert.match(route, /export const dynamic = "force-dynamic"/);
  // Guard pertama sebelum apa pun.
  assert.match(route, /requirePlatformModerator\(\)/);
  assert.match(route, /status: 403/);
  assert.match(route, /code: "admin_required"/);
  assert.match(route, /export async function POST/);
  // Hanya membership id yang diambil dari klien (URL params).
  assert.match(route, /params: Promise<\{ membershipId: string \}>/);
  const code = stripComments(route);
  assert.doesNotMatch(code, /userId/, "route tidak boleh menerima userId dari klien");
  assert.doesNotMatch(code, /placeId/, "route tidak boleh menerima placeId dari klien");
  // Body klien dibaca HANYA untuk alasan pencabutan (kebijakan 0058). Tidak ada
  // identitas, peran, atau id lain yang diambil dari klien.
  assert.match(code, /await request\.json\(\)/);
  assert.match(code, /reason = \(parsed as Record<string, unknown>\)\.reason;/);
  assert.equal(
    (code.match(/parsed as Record<string, unknown>/g) ?? []).length,
    1,
    "route hanya boleh mengambil SATU nilai dari body klien (reason)",
  );
  // Pesan selalu dari server; tidak ada sukses yang dikarang.
  assert.match(route, /revokeProducerPlaceAccess\(membershipId, reason\)/);
  assert.match(route, /revokeProducerPlaceAccessHttpStatus\(result\.status\)/);
});

test("route memetakan hasil server apa adanya (sukses hanya untuk status revoked)", () => {
  // Status → pesan → HTTP hidup di modul kebijakan MURNI (dipakai form klien dan
  // route server), lalu di-ekspor ulang oleh modul server-only.
  const code = stripComments(reasonPolicy);
  assert.match(code, /case "revoked":\s*\n\s*return 200;/);
  assert.match(code, /case "invalid_target":\s*\n\s*return 404;/);
  assert.match(code, /case "invalid_reason":\s*\n\s*return 400;/);
  assert.match(code, /case "already_revoked":\s*\n\s*return 409;/);
  // "owner terakhir" BUKAN lagi keadaan yang bisa dikembalikan: kebijakan
  // pengelolaan digital hanya memakai empat status ini.
  assert.doesNotMatch(code, /last_owner/);
  assert.doesNotMatch(stripComments(service), /last_owner/);
  // Pesan penolakan Indonesia milik server.
  for (const message of [
    "Hak akses Pengelola sudah dicabut sebelumnya.",
    "Data akses Pengelola tidak ditemukan.",
  ]) {
    assert.ok(reasonPolicy.includes(message), `server message missing: ${message}`);
  }
  assert.match(reasonPolicy, /export function revokeProducerPlaceAccessStatusMessage/);
  // Alasan wajib divalidasi di server SEBELUM RPC, dan RPC menerima alasannya.
  assert.match(stripComments(service), /if \(reason === null\) return refusal\("invalid_reason"\);/);
  assert.match(stripComments(service), /if \(!isMembershipId\(membershipId\)\) return refusal\("invalid_target"\);/);
  assert.match(stripComments(service), /p_reason: reason,/);
  // Modul server-only tetap mere-ekspor kebijakan murni supaya hanya ada satu
  // sumber aturan.
  assert.match(service, /from "@\/lib\/admin\/revoke-reason"/);
});

test("service layer: otorisasi dulu, id divalidasi, actor dari guard (bukan klien)", () => {
  const code = stripComments(service);
  // requirePlatformModerator dipanggil sebelum RPC.
  const guardIndex = code.indexOf("await requirePlatformModerator()");
  const rpcIndex = code.indexOf('.rpc(');
  assert.ok(guardIndex > -1 && rpcIndex > -1 && guardIndex < rpcIndex, "guard harus mendahului RPC");
  // Actor = id admin hasil guard.
  assert.match(code, /p_actor_id: actor\.userId/);
  assert.match(code, /p_membership_id: membershipId\.trim\(\)/);
  // UUID divalidasi server-side sebelum menyentuh DB.
  assert.match(code, /const UUID_PATTERN/);
  assert.match(code, /if \(!isMembershipId\(membershipId\)\)/);
  // Modul ini server-only dan tidak menyentuh tabel langsung.
  assert.match(service, /^import "server-only";/);
  assert.doesNotMatch(code, /from\("producer_memberships"\)/, "revocation lewat RPC, bukan DML klien");
  // Ia juga tidak boleh mengimpor/menyalin jalur baca admin (yang dikunci
  // supaya membuat service client tepat sekali).
  assert.doesNotMatch(code, /from "@\/lib\/admin\/queries"/);
});

// ---------------------------------------------------------------------------
// 2. Tabel Data Pengelola: aksi per baris + dialog konfirmasi
// ---------------------------------------------------------------------------

test("setiap baris punya aksi Cabut Hak Akses yang merujuk Produser + Tempat", () => {
  const code = stripComments(table);
  assert.match(code, /Cabut Hak Akses/);
  assert.match(
    code,
    /aria-label=\{`Cabut hak akses \$\{row\.producerName\} atas \$\{row\.placeName \?\? row\.producerId\}`\}/,
  );
  assert.match(code, /setRevokeTarget\(row\)/);
  // Kolom aksi ditambahkan SETELAH kolom yang ada (tata letak/kolom lama utuh).
  const columns = ["producer", "email", "place", "country", "region", "category", "role", "created", "action"];
  const positions = columns.map((key) => code.indexOf(`key: "${key}"`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `column ${columns[i]} must come after ${columns[i - 1]}`);
  }
});

test("konfirmasi wajib: dialog menyebut Produser, email, Tempat, dan dampaknya", () => {
  const code = stripComments(table);
  const dialog = stripComments(revokeDialog);
  // Markup berada di komponen bersama (satu implementasi pencabutan).
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby="revoke-producer-access-title"/);
  assert.match(dialog, /aria-describedby="revoke-producer-access-warning"/);
  assert.match(dialog, /revoke-dialog-producer/);
  assert.match(dialog, /revoke-dialog-email/);
  assert.match(dialog, /revoke-dialog-place/);
  assert.match(dialog, /revokeTarget\.producerName/);
  assert.match(dialog, /revokeTarget\.email/);
  assert.match(dialog, /revokeTarget\.placeName/);
  // Tombol Batal; TIDAK ada confirm() native.
  assert.match(dialog, /Batal/);
  assert.doesNotMatch(dialog, /window\.confirm|\bconfirm\(/);
  // Copy milik surface: judul + peringatan menyebut kehilangan akses kelola.
  assert.match(code, /Cabut Hak Akses\?/);
  assert.match(code, /kehilangan akses mengelola Tempat tersebut/);
  assert.match(code, /akan diberi tahu lewat notifikasi/);
  // Tempat boleh tetap ada tanpa pengelola: disebut di peringatan surface.
  assert.match(code, /Pengelola pengganti tidak wajib ditunjuk/);
  // KEBIJAKAN (aturan A) selalu dinyatakan dialog, di KEDUA surface: tindakan
  // ini hanya kewenangan digital dan tidak menentukan kepemilikan hukum.
  assert.match(dialog, /revoke-dialog-scope/);
  assert.match(dialog, /hanya mencabut kewenangan pengelolaan digital/);
  assert.match(dialog, /tidak menetapkan, menjamin, atau memindahkan kepemilikan hukum/);
  assert.match(dialog, /tidak menghapus data Tempat atau riwayat administrasinya/);
  // ALASAN wajib: pilihan alasan + teks bebas + tombol nonaktif tanpa alasan sah.
  assert.match(dialog, /revoke-dialog-reason/);
  assert.match(dialog, /Alasan pencabutan \(wajib\)/);
  assert.match(dialog, /REVOKE_REASON_OPTIONS\.map/);
  assert.match(dialog, /revoke-dialog-reason-detail/);
  assert.match(dialog, /const reasonValid =/);
  assert.match(dialog, /disabled=\{working \|\| !reasonValid\}/);
  assert.match(dialog, /body: JSON\.stringify\(\{ reason \}\)/);
  // Tidak ada pemanggilan API sebelum konfirmasi eksplisit: fetch hanya satu,
  // di komponen dialog; tabel tidak memanggil API sendiri.
  const fetchCalls = dialog.match(/await fetch\(/g) ?? [];
  assert.equal(fetchCalls.length, 1, "exactly one fetch, inside the confirmation handler");
  assert.equal((code.match(/await fetch\(/g) ?? []).length, 0, "tabel tidak memanggil API sendiri");
});

test("tombol terkunci saat proses; sukses/error/peringatan memakai pesan server", () => {
  const code = stripComments(table);
  const dialog = stripComments(revokeDialog);
  assert.match(dialog, /disabled=\{working\}/);
  assert.match(dialog, /Mencabut…/);
  // Hanya status 2xx yang dianggap sukses, dan hanya saat server mengonfirmasi.
  assert.match(dialog, /if \(response\.ok\) \{/);
  // Peringatan bila notifikasi gagal (jalur in-transaction yang dikurung).
  assert.match(dialog, /Hak akses dicabut, tetapi notifikasi gagal dikirim\./);
  // Hasil operasi dari server dipakai apa adanya, termasuk keadaan managerless.
  assert.match(dialog, /managerless/);
  assert.match(dialog, /Hak akses dicabut\. Notifikasi sudah dikirim\./);
  // Penolakan: pesan server apa adanya, bukan sukses.
  assert.match(dialog, /payload\.message \?\? payload\.error \?\? "Hak akses gagal dicabut\."/);
  // Banner umpan balik milik surface.
  assert.match(code, /role=\{feedback\.kind === "error" \? "alert" : "status"\}/);
  // Data direfresh dari server (tidak ada state klien sebagai sumber kebenaran).
  assert.match(dialog, /useRouter\(\)/);
  assert.match(dialog, /router\.refresh\(\)/);
  assert.match(revokeDialog, /from "next\/navigation"/);
});

test("endpoint & metode yang dipanggil benar, dan pengenceran URL aman", () => {
  assert.match(
    revokeDialog,
    /`\/api\/admin\/producer-memberships\/\$\{encodeURIComponent\(target\.membershipId\)\}\/revoke`/,
  );
  assert.match(revokeDialog, /method: "POST"/);
});

test("pencarian, kolom, urutan, dan responsivitas tabel tetap", () => {
  const code = stripComments(table);
  assert.match(code, /AdminSearchBox/);
  assert.match(code, /AdminDataTable/);
  assert.match(code, /rowMatches\(query, \[row\.producerName, row\.email, row\.placeName\]\)/);
  assert.match(code, /localeCompare\(b\.countryCode/);
  assert.match(code, /localeCompare\(b\.regionName/);
  assert.match(code, /localeCompare\(b\.placeName/);
  assert.match(code, /emptyMessage="Tidak ada relasi Pengelola yang cocok\."/);
  // Halaman tetap server component tipis yang meneruskan relasi kanonik.
  assert.match(page, /<AdminPengelolaTable relations=\{relations\} \/>/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
});

test("dialog dan aksi aman di 360/390px (tanpa overflow horizontal)", () => {
  const code = stripComments(table);
  const dialog = stripComments(revokeDialog);
  // Overlay penuh + kartu terbatas lebar + padding, boleh di-scroll vertikal.
  assert.match(dialog, /fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black\/40 p-4/);
  assert.match(dialog, /className="w-full max-w-sm rounded-2xl border border-black\/10 bg-white p-4"/);
  // Tombol aksi di sel tabel boleh membungkus dan tidak mendorong lebar kolom.
  assert.match(code, /max-w-full whitespace-normal/);
  // Tidak ada lebar piksel kaku melebihi lebar ponsel (tabel + dialog).
  const fixedWidths = `${code}\n${dialog}`.match(/\b(?:min-)?w-\[(\d+)px\]/g) ?? [];
  for (const width of fixedWidths) {
    const px = Number(width.replace(/\D/g, ""));
    assert.ok(px <= 360, `fixed width ${width} would overflow a 360px viewport`);
  }
  // Tombol dialog membungkus (flex-wrap), bukan memaksa satu baris.
  assert.match(dialog, /mt-3 flex flex-wrap justify-end gap-2/);
});

// ---------------------------------------------------------------------------
// 3. Data & istilah
// ---------------------------------------------------------------------------

test("baris Data Pengelola membawa membership id dan tidak membocorkan id mentah", () => {
  const code = stripComments(queries);
  assert.match(code, /membershipId: string;/);
  assert.match(code, /\.select\("id, user_id, producer_id, place_id, role, created_at"\)/);
  assert.match(code, /membershipId: String\(row\.id\)/);
  // Service client tetap dibangun TEPAT SEKALI di lib/admin/queries.ts
  // (kontrak tests/admin-canonical-reads.test.ts) — fitur ini tidak menambah.
  assert.equal((code.match(/createSupabaseServiceClient\(\)/g) ?? []).length, 1);
});

test("kosakata audit memuat dua action baru dengan label Indonesia", () => {
  assert.match(auditFormat, /producerAccessRevoked: "producer_place_access_revoked"/);
  assert.match(auditFormat, /producerAccessRevokeDenied: "producer_place_access_revoke_denied"/);
  assert.match(auditFormat, /producer_place_access_revoked: "Hak kelola Pengelola dicabut"/);
  assert.match(auditFormat, /producer_place_access_revoke_denied: "Pencabutan hak kelola ditolak"/);
});

test("label role memakai istilah terkunci Pemilik/Pengelola/Editor", () => {
  assert.match(producer, /owner: "Pemilik"/);
  assert.match(producer, /manager: "Pengelola"/);
  assert.match(producer, /editor: "Editor"/);
  assert.match(producer, /export function producerRoleLabel/);
});

// ---------------------------------------------------------------------------
// 4. Render tipe notifikasi baru (tanpa permukaan baru)
// ---------------------------------------------------------------------------

test("inbox notifikasi merender generik — tipe baru tidak butuh switch baru", () => {
  // Tidak ada percabangan per event_type di item inbox; judul + isi + tautan
  // opsional sudah cukup untuk kedua event baru.
  assert.doesNotMatch(inboxItem, /event_type/);
  assert.doesNotMatch(inboxItem, /eventType/);
  assert.match(inboxItem, /resolveNotificationHref\(notification\)/);
  // Halaman notifikasi memetakan daftar dari server apa adanya.
  assert.match(notificationsPage, /listUserNotifications\(actor\.userId\)/);
  assert.match(notificationsPage, /notifications\.map\(/);
  // Tidak ada navigasi/menu duplikat yang ditambahkan.
  assert.match(notificationsPage, /href="\/account\/notifications"/);
});

test("tautan notifikasi hanya untuk target yang valid bagi penerima", () => {
  assert.match(model, /return placeId \? `\/places\/\$\{placeId\}` : null;/);
  // Penerima yang dicabut dikirim tanpa place_id (tanpa tautan ke Tempat itu);
  // pengelola lain memakai tautan Place yang sudah ada.
  const migration = read("../supabase/migrations/0058_place_management_policy_managerless.sql");
  const revokedCall = migration.slice(
    migration.indexOf("'producer_place_access_revoked',"),
    migration.indexOf("'producer_place_management_changed',"),
  );
  assert.match(revokedCall, /^\s*null,\s*$/m, "revoked producer notification passes NULL place_id");
  assert.match(migration, /'producer_place_management_changed',[\s\S]*?v_place_id,/);
});
