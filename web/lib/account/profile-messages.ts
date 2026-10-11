import type { ProfileErrorCode } from "@/lib/account/profile";
import type { PhoneOtpResultCode } from "@/lib/account/phone-otp-result";

/**
 * Indonesian messages for the profile + phone OTP surface.
 *
 * Follows docs/UI_TERMINOLOGY_STANDARD.md: natural, concise Bahasa Indonesia,
 * factual status messages (never claiming success when an operation fails), and
 * the locked product terms. The username wording is verbatim the existing
 * Account Center copy so one condition never gets two different sentences.
 * Locked by web/tests/account-profile-messages.test.ts.
 */

export const PROFILE_ERROR_MESSAGES: Readonly<Record<ProfileErrorCode, string>> = {
  profile_update_empty: "Tidak ada perubahan profil untuk disimpan.",
  profile_field_read_only: "Data tersebut tidak dapat diubah dari halaman profil.",
  full_name_required: "Nama lengkap wajib diisi.",
  full_name_invalid: "Nama lengkap harus antara 2 hingga 120 karakter.",
  username_required: "Username wajib diisi.",
  username_invalid:
    "Username hanya boleh huruf, angka, dan tanda hubung, dan harus antara 3 hingga 30 karakter.",
  username_taken: "Username sudah digunakan akun lain.",
  date_of_birth_invalid: "Tanggal lahir tidak valid.",
  date_of_birth_future: "Tanggal lahir tidak boleh di masa depan.",
  date_of_birth_too_old: "Tanggal lahir tidak wajar.",
  phone_required: "Nomor telepon wajib diisi.",
  phone_invalid:
    "Nomor telepon tidak valid. Gunakan format internasional, misalnya +628123456789.",
  profile_update_unavailable:
    "Tidak dapat menyimpan profil saat ini. Coba lagi sebentar lagi.",
};

export const PHONE_OTP_MESSAGES: Readonly<Record<PhoneOtpResultCode, string>> = {
  phone_otp_sent: "Kode verifikasi dikirim ke nomor tersebut.",
  phone_otp_verified: "Nomor telepon berhasil diverifikasi.",
  phone_otp_invalid: "Kode verifikasi salah.",
  phone_otp_expired: "Kode verifikasi sudah kedaluwarsa. Minta kode baru.",
  phone_otp_too_many_attempts: "Terlalu banyak percobaan. Minta kode baru.",
  phone_otp_rate_limited: "Terlalu banyak permintaan kode. Coba lagi nanti.",
  phone_otp_provider_not_configured: "Verifikasi nomor belum tersedia saat ini.",
  phone_otp_unavailable:
    "Verifikasi nomor belum dapat diproses saat ini. Coba lagi sebentar lagi.",
  authentication_required: "Silakan masuk terlebih dahulu untuk memverifikasi nomor.",
};

export type AvatarMessageCode =
  | "avatar_user_invalid"
  | "avatar_empty"
  | "avatar_type_invalid"
  | "avatar_too_large"
  | "avatar_storage_missing"
  | "avatar_upload_failed";

export const AVATAR_MESSAGES: Readonly<Record<AvatarMessageCode, string>> = {
  avatar_empty: "Pilih foto profil terlebih dahulu.",
  avatar_user_invalid: "Foto profil tidak dapat disimpan. Coba lagi sebentar lagi.",
  avatar_type_invalid: "Foto profil harus berformat JPEG, PNG, atau WebP.",
  avatar_too_large: "Ukuran foto profil maksimal 2 MB.",
  avatar_storage_missing: "Penyimpanan foto profil belum tersedia saat ini.",
  avatar_upload_failed: "Foto profil gagal disimpan. Coba lagi sebentar lagi.",
};

export function avatarMessage(code: unknown): string {
  if (typeof code === "string" && code in AVATAR_MESSAGES) {
    return AVATAR_MESSAGES[code as AvatarMessageCode];
  }
  return AVATAR_MESSAGES.avatar_upload_failed;
}

export function profileErrorMessage(code: unknown): string {
  if (typeof code === "string" && code in PROFILE_ERROR_MESSAGES) {
    return PROFILE_ERROR_MESSAGES[code as ProfileErrorCode];
  }
  return PROFILE_ERROR_MESSAGES.profile_update_unavailable;
}

export function phoneOtpMessage(code: unknown): string {
  if (typeof code === "string" && code in PHONE_OTP_MESSAGES) {
    return PHONE_OTP_MESSAGES[code as PhoneOtpResultCode];
  }
  return PHONE_OTP_MESSAGES.phone_otp_unavailable;
}
