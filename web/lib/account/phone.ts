/**
 * PHONE NUMBER — E.164 normalization and validation (pure, no framework).
 *
 * SINGGAH LOKAL stores one canonical phone form: E.164 (`+<country><national>`).
 * Normalization happens SERVER-SIDE before anything is written, compared, or
 * counted, so the same number always produces the same string (the DB also
 * enforces the E.164 shape). Nothing here proves ownership — only a completed
 * OTP confirmation does (see `public.record_phone_otp_verification`).
 *
 * No Master defines the accepted phone input shapes. The rules below are the
 * technical normalization needed to make E.164 storage possible, with Indonesia
 * (the locked initial market) as the only default dialing context. No country
 * is inferred from a number, and no number is ever invented or completed with
 * guessed digits.
 */

/** E.164: '+', a non-zero country-code digit, 7..15 digits in total. */
export const PHONE_E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;

export const DEFAULT_PHONE_COUNTRY = "ID";
export const INDONESIA_DIAL_CODE = "62";

export type PhoneNormalizationError = "phone_required" | "phone_invalid";

export type PhoneNormalizationResult =
  | { ok: true; value: string }
  | { ok: false; error: PhoneNormalizationError };

export function isPhoneE164(value: unknown): value is string {
  return typeof value === "string" && PHONE_E164_PATTERN.test(value.trim());
}

/**
 * Normalize a self-reported phone number to E.164.
 *
 * Accepted inputs (separation characters are ignored):
 *  - `+6281234567890` / `+62 812-3456-7890` — already international;
 *  - `0062...`                            — international `00` prefix;
 *  - `081234567890`                        — Indonesian trunk `0` → `+62`;
 *  - `81234567890`                         — Indonesian mobile without trunk;
 *  - `6281234567890`                       — dial code without `+`.
 *
 * Bare digits that are NOT one of the Indonesian forms above are treated as
 * already carrying their country code (no dial-code is guessed).
 */
export function normalizePhoneE164(input: unknown): PhoneNormalizationResult {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return { ok: false, error: "phone_required" };

  const compact = raw.replace(/[\s().\-/]/g, "");
  if (!/^\+?[0-9]+$/.test(compact)) return { ok: false, error: "phone_invalid" };

  let digits: string;
  if (compact.startsWith("+")) {
    // Already international: taken literally. A leading zero after '+' is NOT
    // silently repaired — no country code begins with 0, so it is invalid.
    digits = compact.slice(1);
  } else if (compact.startsWith("00")) {
    digits = compact.slice(2);
  } else if (compact.startsWith("0")) {
    // Indonesian national/trunk prefix (the ONE default dialing context).
    digits = INDONESIA_DIAL_CODE + compact.slice(1);
  } else if (compact.startsWith(INDONESIA_DIAL_CODE)) {
    digits = compact;
  } else if (compact.startsWith("8")) {
    // Indonesian mobile written without the leading 0.
    digits = INDONESIA_DIAL_CODE + compact;
  } else {
    // Bare digits with no recognizable trunk form: assumed to already carry
    // their country code. No dial-code is invented, and no digit is dropped.
    digits = compact;
  }

  if (!/^[1-9][0-9]{6,14}$/.test(digits)) {
    return { ok: false, error: "phone_invalid" };
  }

  return { ok: true, value: `+${digits}` };
}

/**
 * Display/log-safe mask that keeps the country prefix and the last four digits.
 * Use this — never the raw value — wherever a phone number must be referenced in
 * a log line, an error, or a response that is not the owner's own profile.
 */
export function maskPhoneE164(phone: unknown): string | null {
  if (!isPhoneE164(phone)) return null;
  const value = phone.trim();
  const head = value.slice(0, 5);
  const tail = value.slice(-4);
  const hidden = Math.max(2, value.length - head.length - tail.length);
  return `${head}${"*".repeat(hidden)}${tail}`;
}
