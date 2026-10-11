import assert from "node:assert/strict";
import test from "node:test";
import {
  isPhoneE164,
  maskPhoneE164,
  normalizePhoneE164,
} from "../lib/account/phone";
import {
  ACCOUNT_AGE_TIMEZONE,
  MAX_ACCOUNT_AGE_YEARS,
  calculateAge,
  parseDateOfBirth,
  validateDateOfBirth,
} from "../lib/account/age";
import {
  buildProfileUpdate,
  buildVerificationSummary,
  normalizeFullName,
  profileUpdateTouchesPhone,
} from "../lib/account/profile";
import {
  OTP_CODE_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  generateOtpCode,
  hashOtpCode,
  isOtpRequestRateLimited,
  isOtpExpired,
  otpExpiresAt,
  otpHashMatches,
} from "../lib/account/phone-otp";
import {
  getPhoneOtpProvider,
  isPhoneOtpProviderConfigured,
  setPhoneOtpProvider,
  PhoneOtpProviderNotConfiguredError,
} from "../lib/account/phone-otp-provider";
import {
  isPhoneOtpSuccess,
  mapOtpRpcResult,
  phoneOtpHttpStatus,
} from "../lib/account/phone-otp-result";
import {
  AVATAR_ALLOWED_MIME_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_OBJECT_PATH_PATTERN,
  avatarObjectPath,
  validateAvatarUpload,
} from "../lib/account/avatar";

// ---------------------------------------------------------------------------
// Phone: E.164 normalization, validation, masking
// ---------------------------------------------------------------------------

test("phone numbers are normalized to E.164 regardless of the input shape", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["+6281234567890", "+6281234567890"],
    ["+62 812-3456-7890", "+6281234567890"],
    ["0062 812 3456 7890", "+6281234567890"],
    ["081234567890", "+6281234567890"],
    ["0812-3456-7890", "+6281234567890"],
    ["81234567890", "+6281234567890"],
    ["6281234567890", "+6281234567890"],
    ["+1 (415) 555-2671", "+14155552671"],
    ["  +6281234567890  ", "+6281234567890"],
  ];
  for (const [input, expected] of cases) {
    const result = normalizePhoneE164(input);
    assert.equal(result.ok, true, `${input} must normalize`);
    if (result.ok) assert.equal(result.value, expected, `${input} → ${expected}`);
  }
});

test("invalid phone input is rejected with a specific code", () => {
  const invalid: ReadonlyArray<[unknown, string]> = [
    ["", "phone_required"],
    ["   ", "phone_required"],
    [null, "phone_required"],
    ["abc", "phone_invalid"],
    ["+62 812 abc", "phone_invalid"],
    ["+0123456789", "phone_invalid"],
    ["12345", "phone_invalid"],
    ["+999999999999999999", "phone_invalid"],
    ["0", "phone_invalid"],
  ];
  for (const [input, expected] of invalid) {
    const result = normalizePhoneE164(input);
    assert.equal(result.ok, false, `${String(input)} must be rejected`);
    if (!result.ok) assert.equal(result.error, expected, `${String(input)} → ${expected}`);
  }
});

test("the E.164 predicate accepts only real E.164 values", () => {
  assert.equal(isPhoneE164("+6281234567890"), true);
  assert.equal(isPhoneE164("081234567890"), false, "a national form is not E.164");
  assert.equal(isPhoneE164("+0123456789"), false);
  assert.equal(isPhoneE164(null), false);
});

test("phone masking keeps the prefix and last four digits only", () => {
  assert.equal(maskPhoneE164("+6281234567890"), "+6281*****7890");
  assert.equal(maskPhoneE164("081234567890"), null, "an unnormalized number is never displayed");
  const masked = maskPhoneE164("+6281234567890") ?? "";
  assert.ok(!masked.includes("234567"), "the middle digits must be hidden");
});

// ---------------------------------------------------------------------------
// Age: computed on the server, never stored
// ---------------------------------------------------------------------------

test("age is computed in the product reference timezone, not the caller's", () => {
  assert.equal(ACCOUNT_AGE_TIMEZONE, "Asia/Jakarta");

  // 2026-01-01T17:00:00Z is ALREADY 2026-01-02 in Jakarta (UTC+7).
  const at = new Date("2026-01-01T17:00:00Z");
  assert.equal(calculateAge("2008-01-02", at), 18, "Jakarta has rolled over to Jan 2");
  assert.equal(calculateAge("2008-01-02", at, "UTC"), 17, "UTC has not");
});

test("age handles exact birthdays, the day before, and leap days", () => {
  const at = new Date("2026-06-15T04:00:00Z");
  assert.equal(calculateAge("2008-06-15", at), 18, "birthday itself counts");
  assert.equal(calculateAge("2008-06-16", at), 17, "the day before does not");
  assert.equal(calculateAge("2008-06-14", at), 18);

  const beforeLeapBirthday = new Date("2026-02-28T04:00:00Z");
  const afterLeapBirthday = new Date("2026-03-01T04:00:00Z");
  assert.equal(calculateAge("2000-02-29", beforeLeapBirthday), 25, "Feb 29 → not yet in 2026");
  assert.equal(calculateAge("2000-02-29", afterLeapBirthday), 26, "Feb 29 → turned on Mar 1");
});

test("date of birth is strictly parsed and sanity-bounded", () => {
  assert.equal(parseDateOfBirth("1990-05-17").ok, true);
  assert.equal(parseDateOfBirth("2026-02-30").ok, false, "Feb 30 does not exist");
  assert.equal(parseDateOfBirth("1990-5-17").ok, false, "the format is strict");
  assert.equal(parseDateOfBirth("not-a-date").ok, false);
  assert.equal(parseDateOfBirth(19900517).ok, false);

  const at = new Date("2026-06-15T04:00:00Z");
  assert.equal(validateDateOfBirth("2008-06-15", at), null, "a normal date passes");
  assert.equal(validateDateOfBirth("2026-06-16", at), "date_of_birth_future");
  assert.equal(validateDateOfBirth("2026-02-30", at), "date_of_birth_invalid");
  assert.equal(
    validateDateOfBirth("1900-01-01", at),
    "date_of_birth_too_old",
    `more than ${MAX_ACCOUNT_AGE_YEARS} years is implausible`,
  );
  assert.equal(
    validateDateOfBirth(`${at.getUTCFullYear() - MAX_ACCOUNT_AGE_YEARS}-06-14`, at),
    null,
    "the sanity bound itself is allowed",
  );
});

// ---------------------------------------------------------------------------
// Profile update: self-owned fields only, email read-only
// ---------------------------------------------------------------------------

test("a profile update accepts only the self-owned fields", () => {
  const result = buildProfileUpdate(
    {
      full_name: "  Budi Santoso  ",
      username: "budi-santoso",
      date_of_birth: "1990-05-17",
      phone: "0812-3456-7890",
    },
    new Date("2026-06-15T04:00:00Z"),
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.update, {
      full_name: "Budi Santoso",
      username: "budi-santoso",
      date_of_birth: "1990-05-17",
      phone_e164: "+6281234567890",
    });
    assert.equal(profileUpdateTouchesPhone(result.update), true);
  }
});

test("email can never be changed through the profile API", () => {
  for (const key of ["email", "email_confirmed_at", "emailVerified"]) {
    const result = buildProfileUpdate({ [key]: "lain@example.com" });
    assert.equal(result.ok, false, `${key} must be rejected`);
    if (!result.ok) assert.equal(result.error, "profile_field_read_only");
  }

  const verification = buildProfileUpdate({ phone_verified_at: "2026-01-01T00:00:00Z" });
  assert.equal(verification.ok, false);
  if (!verification.ok) assert.equal(verification.error, "profile_field_read_only");

  const authority = buildProfileUpdate({ platform_role: "platform_moderator" });
  assert.equal(authority.ok, false);
  if (!authority.ok) assert.equal(authority.error, "profile_field_read_only");
});

test("profile validation reuses the EXISTING username rules and rejects bad input", () => {
  const short = buildProfileUpdate({ username: "ab" });
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.error, "username_invalid");

  const spaced = buildProfileUpdate({ username: "bad name" });
  assert.equal(spaced.ok, false);
  if (!spaced.ok) assert.equal(spaced.error, "username_invalid");

  const tooLong = buildProfileUpdate({ username: "a".repeat(31) });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error, "username_invalid");

  const valid = buildProfileUpdate({ username: "  budi-santoso  " });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.update.username, "budi-santoso", "the canonical form is trimmed");

  const cleared = buildProfileUpdate({ username: "   " });
  assert.equal(cleared.ok, true);
  if (cleared.ok) assert.equal(cleared.update.username, null, "an empty username clears the field");
});

test("profile date-of-birth and phone errors carry their own code", () => {
  const at = new Date("2026-06-15T04:00:00Z");
  const future = buildProfileUpdate({ date_of_birth: "2026-12-01" }, at);
  assert.equal(future.ok, false);
  if (!future.ok) assert.equal(future.error, "date_of_birth_future");

  const invalidDate = buildProfileUpdate({ date_of_birth: "2026-02-30" }, at);
  assert.equal(invalidDate.ok, false);
  if (!invalidDate.ok) assert.equal(invalidDate.error, "date_of_birth_invalid");

  const badPhone = buildProfileUpdate({ phone: "abc" });
  assert.equal(badPhone.ok, false);
  if (!badPhone.ok) assert.equal(badPhone.error, "phone_invalid");

  const clearedPhone = buildProfileUpdate({ phone: "" });
  assert.equal(clearedPhone.ok, true);
  if (clearedPhone.ok) assert.equal(clearedPhone.update.phone_e164, null);

  const nothing = buildProfileUpdate({});
  assert.equal(nothing.ok, false);
  if (!nothing.ok) assert.equal(nothing.error, "profile_update_empty");

  const notAnObject = buildProfileUpdate("full_name=Budi");
  assert.equal(notAnObject.ok, false);
});

test("full names are trimmed and bounded", () => {
  assert.deepEqual(normalizeFullName("  Budi  "), { ok: true, value: "Budi" });
  assert.deepEqual(normalizeFullName("   "), { ok: true, value: null });
  assert.deepEqual(normalizeFullName(null), { ok: true, value: null });
  assert.equal(normalizeFullName("B").ok, false, "one character is too short");
  assert.equal(normalizeFullName("B".repeat(121)).ok, false);
});

// ---------------------------------------------------------------------------
// Verification summary: two stored facts only, never a derived tier
// ---------------------------------------------------------------------------

test("the verification summary reports only the email and phone facts", () => {
  const summary = buildVerificationSummary({
    email: "budi@example.com",
    emailConfirmedAt: "2026-01-01T00:00:00Z",
    phoneE164: "+6281234567890",
    phoneVerifiedAt: null,
  });

  assert.deepEqual(Object.keys(summary).sort(), ["email", "phone"]);
  assert.equal(summary.email.verified, true, "the email fact comes from auth");
  assert.equal(summary.email.value, "budi@example.com");
  assert.equal(summary.phone.verified, false, "an unverified phone is never claimed verified");
  assert.equal(summary.phone.value, "+6281234567890");

  const unconfirmed = buildVerificationSummary({ email: "budi@example.com", emailConfirmedAt: null });
  assert.equal(unconfirmed.email.verified, false, "an unconfirmed email is not verified");

  const noData = buildVerificationSummary({});
  assert.deepEqual(noData, {
    email: { verified: false, value: null },
    phone: { verified: false, value: null },
  });
});

// ---------------------------------------------------------------------------
// OTP model: code, hash, expiry, attempts, rate limits
// ---------------------------------------------------------------------------

test("OTP codes are random decimals of the locked length and are only hashed", () => {
  assert.equal(OTP_CODE_LENGTH, 6);
  const codes = new Set<string>();
  for (let i = 0; i < 50; i += 1) {
    const code = generateOtpCode();
    assert.match(code, /^[0-9]{6}$/);
    codes.add(code);
  }
  assert.ok(codes.size > 1, "codes must vary");

  const hash = hashOtpCode("123456", "secret-a");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashOtpCode("123456", "secret-a"), "hashing is deterministic");
  assert.notEqual(hash, hashOtpCode("123456", "secret-b"), "the server secret changes the digest");
  assert.notEqual(hash, hashOtpCode("123457", "secret-a"));
  assert.notEqual(hash, "123456", "a plaintext code is never the stored value");
  assert.equal(otpHashMatches(hash, hashOtpCode("123456", "secret-a")), true);
  assert.equal(otpHashMatches(hash, hashOtpCode("000000", "secret-a")), false);
});

test("OTP expiry is short and the attempt bound is locked", () => {
  assert.equal(OTP_TTL_SECONDS, 600, "a short 10-minute expiry");
  assert.equal(OTP_MAX_ATTEMPTS, 5);

  const created = new Date("2026-06-15T04:00:00Z");
  const expires = otpExpiresAt(created);
  assert.equal(expires.getTime() - created.getTime(), OTP_TTL_SECONDS * 1000);
  assert.equal(isOtpExpired(expires, new Date("2026-06-15T04:09:59Z")), false);
  assert.equal(isOtpExpired(expires, new Date("2026-06-15T04:10:00Z")), true, "expiry is inclusive");
});

test("OTP send rate limits are enforced per account AND per number", () => {
  assert.equal(isOtpRequestRateLimited(0, 3), false);
  assert.equal(isOtpRequestRateLimited(2, 3), false);
  assert.equal(isOtpRequestRateLimited(3, 3), true);
  assert.equal(isOtpRequestRateLimited(10, 3), true);
});

test("an unexpected RPC answer never reads as success", () => {
  assert.equal(mapOtpRpcResult("ok"), "phone_otp_verified");
  assert.equal(mapOtpRpcResult("phone_otp_invalid"), "phone_otp_invalid");
  assert.equal(mapOtpRpcResult("phone_otp_expired"), "phone_otp_expired");
  assert.equal(mapOtpRpcResult("phone_otp_too_many_attempts"), "phone_otp_too_many_attempts");
  assert.equal(mapOtpRpcResult("authentication_required"), "authentication_required");
  assert.equal(mapOtpRpcResult(undefined), "phone_otp_unavailable");
  assert.equal(mapOtpRpcResult("something_new"), "phone_otp_unavailable");

  assert.equal(isPhoneOtpSuccess("phone_otp_sent"), true);
  assert.equal(isPhoneOtpSuccess("phone_otp_verified"), true);
  assert.equal(isPhoneOtpSuccess("phone_otp_invalid"), false);
  assert.equal(isPhoneOtpSuccess("phone_otp_provider_not_configured"), false);

  assert.equal(phoneOtpHttpStatus("authentication_required"), 401);
  assert.equal(phoneOtpHttpStatus("phone_otp_invalid"), 400);
  assert.equal(phoneOtpHttpStatus("phone_otp_rate_limited"), 429);
  assert.equal(phoneOtpHttpStatus("phone_otp_provider_not_configured"), 503);
});

test("the OTP provider seam fails closed until a provider is wired", () => {
  assert.equal(isPhoneOtpProviderConfigured(), false, "no provider is configured by default");
  assert.throws(() => getPhoneOtpProvider(), PhoneOtpProviderNotConfiguredError);

  const sent: string[] = [];
  setPhoneOtpProvider({
    async sendOtp(delivery) {
      sent.push(delivery.phoneE164);
    },
  });
  assert.equal(isPhoneOtpProviderConfigured(), true);
  assert.doesNotThrow(() => getPhoneOtpProvider());

  setPhoneOtpProvider(null);
  assert.equal(isPhoneOtpProviderConfigured(), false, "the seam can be reset to fail closed");
});

// ---------------------------------------------------------------------------
// Avatar validation
// ---------------------------------------------------------------------------

test("avatar uploads are limited to jpeg/png/webp under the size cap", () => {
  assert.deepEqual([...AVATAR_ALLOWED_MIME_TYPES], ["image/jpeg", "image/png", "image/webp"]);
  assert.equal(AVATAR_MAX_BYTES, 2 * 1024 * 1024);

  assert.equal(validateAvatarUpload({ type: "image/jpeg", size: 1024 }), null);
  assert.equal(validateAvatarUpload({ type: "image/png", size: AVATAR_MAX_BYTES }), null);
  assert.equal(validateAvatarUpload({ type: "image/gif", size: 1024 }), "avatar_type_invalid");
  assert.equal(validateAvatarUpload({ type: "application/pdf", size: 1024 }), "avatar_type_invalid");
  assert.equal(
    validateAvatarUpload({ type: "image/png", size: AVATAR_MAX_BYTES + 1 }),
    "avatar_too_large",
  );
  assert.equal(validateAvatarUpload({ type: "image/png", size: 0 }), "avatar_empty");
});

test("every avatar object lives under the owner's own user id", () => {
  const userId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const path = avatarObjectPath(userId, "image/png", "0123456789abcdef01234567");
  assert.equal(path, `avatars/${userId}/0123456789abcdef01234567.png`);
  assert.match(path, AVATAR_OBJECT_PATH_PATTERN);

  assert.throws(() => avatarObjectPath("not-a-uuid", "image/png", "0123456789abcdef01234567"));
  assert.throws(() => avatarObjectPath(userId, "image/png", "short"));
  assert.throws(() => avatarObjectPath(userId, "image/png", "0123456789abcdef0123456789"));
  assert.equal(avatarObjectPath(userId, "image/webp", "0123456789abcdef01234567").endsWith(".webp"), true);
  assert.equal(avatarObjectPath(userId, "image/jpeg", "0123456789abcdef01234567").endsWith(".jpg"), true);
});
