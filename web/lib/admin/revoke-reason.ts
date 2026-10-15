/**
 * Kebijakan pencabutan kewenangan pengelolaan digital — bagian MURNI.
 *
 * Dipisah dari `lib/admin/producer-membership-revoke.ts` (yang `server-only`)
 * karena form Admin (komponen klien) memakai aturan dan pilihan alasan yang
 * SAMA. Satu sumber untuk batas panjang dan daftar alasan; otoritas akhir
 * tetap RPC di database, yang menerapkan ulang aturan ini.
 */

/** Batas alasan yang diterima klien DAN diterapkan ulang di dalam RPC. */
export const REVOKE_REASON_MIN_LENGTH = 3;
export const REVOKE_REASON_MAX_LENGTH = 500;

/**
 * Alasan pencabutan yang disediakan UI. Daftarnya mengikuti alasan yang sah
 * menurut kebijakan platform; teks bebas tetap diterima dan divalidasi
 * server-side dengan aturan panjang yang sama.
 */
export const REVOKE_REASON_OPTIONS: readonly string[] = [
  "Akun tidak lagi memiliki kewenangan mengelola Tempat ini.",
  "Ada sengketa atau laporan yang memerlukan peninjauan admin.",
  "Akun menyalahgunakan izin pengelolaan.",
  "Akun melanggar ketentuan platform.",
  "Intervensi administratif untuk melindungi pengguna atau integritas platform.",
];

/**
 * Alasan pencabutan yang sah: teks setelah trim, 3–500 karakter. Fungsi murni
 * supaya form (klien) dan route (server) memakai aturan yang sama.
 */
export function normalizeRevokeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (reason.length < REVOKE_REASON_MIN_LENGTH || reason.length > REVOKE_REASON_MAX_LENGTH) {
    return null;
  }
  return reason;
}

/**
 * Status hasil operasi pencabutan. `managerless: true` berarti Tempat itu kini
 * TIDAK punya Pengelola digital aktif — keadaan yang SAH menurut kebijakan
 * permanen, bukan kesalahan.
 */
export type ProducerPlaceAccessRevokeStatus =
  | "revoked"
  | "already_revoked"
  | "invalid_target"
  | "invalid_reason";

/** Operator-facing Indonesian label per status (UI_TERMINOLOGY_STANDARD). */
export function revokeProducerPlaceAccessStatusMessage(status: string): string {
  switch (status) {
    case "already_revoked":
      return "Hak akses Pengelola sudah dicabut sebelumnya.";
    case "invalid_target":
      return "Data akses Pengelola tidak ditemukan.";
    case "invalid_reason":
      return `Alasan pencabutan wajib diisi (${REVOKE_REASON_MIN_LENGTH}–${REVOKE_REASON_MAX_LENGTH} karakter).`;
    default:
      return "Hak akses Pengelola gagal dicabut.";
  }
}

/** HTTP status per outcome. "revoked" is the only success. */
export function revokeProducerPlaceAccessHttpStatus(status: string): number {
  switch (status) {
    case "revoked":
      return 200;
    case "invalid_target":
      return 404;
    case "invalid_reason":
      return 400;
    case "already_revoked":
      return 409;
    default:
      return 503;
  }
}
