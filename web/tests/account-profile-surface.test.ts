import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AVATAR_MESSAGES,
  PHONE_OTP_MESSAGES,
  PROFILE_ERROR_MESSAGES,
} from "../lib/account/profile-messages";

/**
 * PROFILE + PHONE OTP SURFACE — the locked wiring and safety contracts.
 *
 * The PGlite suite proves the database behaviour; this suite proves the SERVER
 * wiring around it: the subject is always the session, email is read-only, the
 * verification fact is never client-written, a phone number is never echoed or
 * logged in full, the OTP provider and hash secret fail closed, the avatar
 * bucket stays private, and the Indonesian wording is the one locked table.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** Strip SQL line comments so a guard tests EXECUTED statements, not prose. */
const withoutSqlComments = (source: string) => source.replace(/--[^\n]*/g, " ");

/** Strip JS block/line comments (same idea for TS modules). */
const withoutJsComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const profileRoute = read("../app/api/account/profile/route.ts");
const otpRoute = read("../app/api/account/phone/otp/route.ts");
const otpVerifyRoute = read("../app/api/account/phone/otp/verify/route.ts");
const avatarRoute = read("../app/api/account/profile/avatar/route.ts");
const avatarStorage = read("../lib/account/avatar-storage.ts");
const otpService = read("../lib/account/phone-otp-service.ts");
const otpProvider = read("../lib/account/phone-otp-provider.ts");
const profileLib = read("../lib/account/profile.ts");
const usernameRoute = read("../app/api/account/username/route.ts");
const profileClient = read("../components/account/account-profile-client.tsx");
const migration = read("../supabase/migrations/0050_profile_phone_verification.sql");

test("the profile endpoint is self-only: the subject is always the session", () => {
  assert.match(profileRoute, /export async function GET/);
  assert.match(profileRoute, /export async function PATCH/);
  assert.match(profileRoute, /supabase\.auth\.getUser\(\)/);
  assert.match(profileRoute, /eq\("id", userData\.user\.id\)/);
  // No client-supplied subject anywhere.
  assert.doesNotMatch(profileRoute, /body\.(userId|user_id)/);
  assert.doesNotMatch(profileRoute, /searchParams\.get\("(userId|user_id)"\)/);
  // Both handlers refuse an anonymous caller.
  assert.equal((profileRoute.match(/"authentication_required"/g) ?? []).length, 2);
});

test("email is read-only in the profile API and the age is computed server-side", () => {
  // The update payload is exactly what the pure validator produced.
  assert.match(profileRoute, /buildProfileUpdate\(body\)/);
  assert.match(profileRoute, /\.update\(update\)/);
  // ...and the validator rejects the email (and every verification field).
  assert.match(profileLib, /email: "Registered email is changed only through the existing auth security flow\."/);
  assert.match(profileLib, /phone_verified_at: "Only a completed OTP confirmation may set this\."/);
  assert.match(profileLib, /platform_role: "Platform authority is never self-assigned\."/);

  // The age is derived on the server from the stored date.
  assert.match(profileRoute, /calculateAge\(row\.date_of_birth\)/);
  assert.doesNotMatch(profileRoute, /age:\s*Number\(/, "no stored raw age is echoed");

  // The verification summary reports only the two stored facts.
  assert.match(profileRoute, /buildVerificationSummary\(/);
  assert.match(profileLib, /email:\s*\{[\s\S]*?verified: Boolean\(input\.emailConfirmedAt\)/);
  assert.match(profileLib, /phone:\s*\{[\s\S]*?verified: Boolean\(input\.phoneVerifiedAt\)/);
});

test("the profile route reuses the existing username rules instead of re-implementing them", () => {
  assert.match(profileLib, /import \{[\s\S]*validateUsername[\s\S]*\} from "@\/lib\/username"/);
  assert.match(profileLib, /validateUsername\(raw\)/);
  assert.doesNotMatch(profileLib, /MIN_USERNAME_LENGTH|MAX_USERNAME_LENGTH|usernamePattern/);
  // The pre-existing username endpoint is untouched and still the UI's path.
  assert.match(usernameRoute, /validateUsername/);
  assert.match(usernameRoute, /from\("users"\)/);
});

test("a phone number is never echoed or logged in full", () => {
  assert.match(otpRoute, /maskPhoneE164\(normalized\.value\)/);
  assert.doesNotMatch(otpRoute, /phoneMasked:\s*normalized\.value/);
  for (const [name, source] of Object.entries({ profileRoute, otpRoute, otpVerifyRoute, otpService })) {
    assert.doesNotMatch(source, /console\.(log|info|debug|error|warn)/, `${name} must not log`);
  }
  // The OTP code itself is only ever handled as a hash on the way to the DB.
  assert.match(otpService, /code_hash: hashOtpCode\(code, secret\)/);
  assert.match(otpVerifyRoute, /p_code_hash: hashOtpCode\(input\.code, secret\)|verifyPhoneOtp/);
  assert.doesNotMatch(otpVerifyRoute, /from\("users"\)/, "the verify route never writes users directly");
});

test("the OTP flow fails closed and enforces both rate limits", () => {
  assert.match(otpService, /resolveOtpHashSecret\(\)/);
  assert.match(otpService, /getPhoneOtpProvider\(\)/);
  assert.match(otpService, /countRecentBy\("user_id"/);
  assert.match(otpService, /countRecentBy\("phone_e164"/);
  assert.match(otpService, /isOtpRequestRateLimited\(perUser, OTP_MAX_REQUESTS_PER_USER\)/);
  assert.match(otpService, /isOtpRequestRateLimited\(perPhone, OTP_MAX_REQUESTS_PER_PHONE\)/);
  // A new request supersedes the previous challenge (single active challenge).
  assert.match(otpService, /\.update\(\{ consumed_at: now\.toISOString\(\) \}\)/);
  assert.match(otpService, /\.is\("consumed_at", null\)/);
  // The uniform (non-enumerating) answer for a number verified elsewhere.
  assert.match(otpService, /takenByAnotherAccount/);
  assert.match(otpService, /status: "phone_otp_sent", challengeId: data\.id/);
  // No provider is invented here.
  assert.doesNotMatch(
    withoutJsComments(otpProvider),
    /twilio|vonage|messagebird|signInWithOtp|fetch\(/i,
    "no provider is implemented — only the seam exists",
  );
  assert.match(otpProvider, /PhoneOtpProviderNotConfiguredError/);
});

test("the OTP verify endpoint validates input before touching the RPC", () => {
  assert.match(otpVerifyRoute, /OTP_CODE_LENGTH/);
  assert.match(otpVerifyRoute, /UUID_PATTERN\.test/);
  assert.match(otpVerifyRoute, /verifyPhoneOtp\(\{ challengeId, code \}\)/);
  assert.match(otpVerifyRoute, /phoneOtpHttpStatus\(status\)/);
});

test("avatars are written only to the private bucket, never through a public URL", () => {
  assert.match(avatarRoute, /validateAvatarUpload\(\{ type: file\.type, size: file\.size \}\)/);
  assert.match(avatarRoute, /uploadAccountAvatar\(\{ userId: userData\.user\.id, file \}\)/);
  assert.match(avatarRoute, /\.update\(\{ avatar_path: upload\.storagePath \}\)/);
  assert.match(avatarRoute, /\.eq\("id", userData\.user\.id\)/);
  assert.match(avatarStorage, /AVATAR_BUCKET/);
  assert.match(avatarStorage, /createSignedUrl\(storagePath, AVATAR_SIGNED_URL_TTL_SECONDS\)/);
  assert.match(avatarStorage, /removeAccountAvatar\(/);
  // Never a public URL, never a bucket listing.
  assert.doesNotMatch(avatarStorage, /getPublicUrl|\.list\(/);
  assert.doesNotMatch(avatarRoute, /getPublicUrl/);
});

test("migration 0050 is forward-only, least-privilege, and DEV-scoped", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  // Both new functions are SECURITY DEFINER with a pinned search_path.
  assert.equal(
    (migration.match(/security definer set search_path = public/g) ?? []).length,
    2,
    "every SECURITY DEFINER function must pin search_path",
  );
  assert.equal(
    (migration.match(/revoke all on function public\./g) ?? []).length,
    2,
    "PUBLIC/anon/authenticated EXECUTE is revoked on both new functions",
  );
  assert.match(
    migration,
    /revoke all on public\.phone_otp_challenges from public, anon, authenticated/,
  );
  const executable = withoutSqlComments(migration);
  assert.match(executable, /grant update \(username, full_name, date_of_birth, phone_e164, avatar_path\)/);
  assert.doesNotMatch(executable, /grant update \([^)]*phone_verified_at/);
  assert.doesNotMatch(executable, /grant [\s\S]{0,80}? to anon/i, "never a grant to anon");
  assert.doesNotMatch(executable, /disable row level security/i);
  assert.doesNotMatch(executable, /drop table|delete from/i);
  // The avatar bucket is private with the locked type/size limits.
  assert.match(migration, /'account-avatars',\s*\n\s*'account-avatars',\s*\n\s*false,/);
  assert.match(migration, /2097152/);
  // DEV scope, not a production instruction.
  assert.match(migration, /Do not apply this migration to production/);
});

test("phone verification is never coupled to manager or Place verification", () => {
  for (const [name, source] of Object.entries({ profileLib, otpService, profileRoute })) {
    assert.doesNotMatch(source, /claim_status/, `${name} must not read claim_status`);
    assert.doesNotMatch(source, /live_operators|live_operator_invitations/, `${name} must stay out of the operator tables`);
  }
  // The verification summary exposes exactly two facts, never a tier.
  assert.doesNotMatch(profileLib, /managerVerified|placeVerified|producerVerified|identityVerified/);
  assert.doesNotMatch(profileRoute, /managerVerified|placeVerified|producerVerified|identityVerified/);
});

test("the Indonesian messages are the locked table (no divergent copy)", () => {
  assert.equal(PROFILE_ERROR_MESSAGES.phone_invalid.includes("format internasional"), true);
  assert.equal(
    PROFILE_ERROR_MESSAGES.username_taken,
    "Username sudah digunakan akun lain.",
    "the existing Account Center wording is reused verbatim",
  );
  // Tahap 3: the editable profile moved to its own screen, so the locked
  // message table is what BOTH surfaces render — the read-only panel carries no
  // error copy at all, and the editing screen never reintroduces its own.
  assert.equal(
    profileClient.includes("Username sudah digunakan akun lain."),
    false,
    "the read-only panel duplicates no error copy",
  );
  const profileEditClient = read("../components/account/account-profile-edit-client.tsx");
  assert.ok(profileEditClient.includes("profileErrorMessage"), "profile failures use the locked table");
  assert.ok(profileEditClient.includes("phoneOtpMessage"), "OTP results use the locked table");
  assert.ok(profileEditClient.includes("avatarMessage"), "avatar failures use the locked table");
  assert.doesNotMatch(
    profileEditClient,
    /"Username sudah digunakan akun lain\."/,
    "the screen never re-declares a message the server owns",
  );
  assert.equal(PHONE_OTP_MESSAGES.phone_otp_invalid, "Kode verifikasi salah.");
  assert.equal(
    PHONE_OTP_MESSAGES.phone_otp_expired,
    "Kode verifikasi sudah kedaluwarsa. Minta kode baru.",
  );
  assert.equal(
    PHONE_OTP_MESSAGES.phone_otp_too_many_attempts,
    "Terlalu banyak percobaan. Minta kode baru.",
  );
  assert.equal(PHONE_OTP_MESSAGES.phone_otp_rate_limited, "Terlalu banyak permintaan kode. Coba lagi nanti.");
  assert.equal(
    PHONE_OTP_MESSAGES.phone_otp_provider_not_configured,
    "Verifikasi nomor belum tersedia saat ini.",
    "the manual OTP blocker has a factual user-facing status",
  );
  assert.equal(AVATAR_MESSAGES.avatar_too_large, "Ukuran foto profil maksimal 2 MB.");
  assert.equal(
    AVATAR_MESSAGES.avatar_type_invalid,
    "Foto profil harus berformat JPEG, PNG, atau WebP.",
  );

  // Locked product terms must survive: SINGGAH stays visit intent, and Tempat
  // stays the (never translated into a generic category) user-facing word.
  for (const message of Object.values({ ...PROFILE_ERROR_MESSAGES, ...PHONE_OTP_MESSAGES, ...AVATAR_MESSAGES })) {
    assert.doesNotMatch(message, /\bSubmit\b|\bCancel\b|\bSave\b|\bProfile\b|\bSettings\b/);
  }
});
