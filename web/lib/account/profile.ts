import {
  canonicalUsername,
  validateUsername,
  type UsernameValidationError,
} from "@/lib/username";
import { normalizePhoneE164 } from "@/lib/account/phone";
import { validateDateOfBirth, type DateOfBirthError } from "@/lib/account/age";

/**
 * ACCOUNT PROFILE — the pure model behind `GET/PATCH /api/account/profile`.
 *
 * Design rules (locked by this task and by AGENTS.md):
 *  - the profile row IS the existing `public.users` row: the self-read RLS
 *    policy, the self-update policy, the username rules, and the auth cascade
 *    are all reused, and no second profile table is introduced;
 *  - only the account's OWN fields are writable, and the server derives the
 *    subject from the session — a client never sends a user id;
 *  - EMAIL IS READ-ONLY. There is no free email-update field: changing the
 *    registered email stays in the existing Supabase Auth security flow, so any
 *    attempt to write it through the profile API is rejected;
 *  - `phone_verified_at` is not writable here at all (column GRANT + trigger):
 *    a filled phone field is never a verification, and the profile API can never
 *    assert one.
 */

export const PROFILE_FULL_NAME_MIN_LENGTH = 2;
export const PROFILE_FULL_NAME_MAX_LENGTH = 120;

export type ProfileErrorCode =
  | "profile_update_empty"
  | "profile_field_read_only"
  | "full_name_required"
  | "full_name_invalid"
  | "profile_update_unavailable"
  | UsernameValidationError
  | DateOfBirthError
  | "phone_required"
  | "phone_invalid";

/** Keys a client must never write through the profile API, and why. */
export const PROFILE_READ_ONLY_KEYS: Readonly<Record<string, string>> = {
  id: "The subject is always the authenticated session.",
  email: "Registered email is changed only through the existing auth security flow.",
  email_confirmed_at: "Email verification comes from Supabase Auth.",
  emailVerified: "Email verification comes from Supabase Auth.",
  phone_verified_at: "Only a completed OTP confirmation may set this.",
  phoneVerified: "Only a completed OTP confirmation may set this.",
  platform_role: "Platform authority is never self-assigned.",
  avatar_path: "Set by the avatar upload endpoint, not by a free-form value.",
};

export type ProfileUpdate = {
  full_name?: string | null;
  username?: string | null;
  date_of_birth?: string | null;
  phone_e164?: string | null;
};

export type ProfileUpdateResult =
  | { ok: true; update: ProfileUpdate }
  | { ok: false; error: ProfileErrorCode };

/** Trim a full name and drop the empty case to NULL (clearing the field). */
export function normalizeFullName(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; error: ProfileErrorCode } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "full_name_invalid" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (
    trimmed.length < PROFILE_FULL_NAME_MIN_LENGTH ||
    trimmed.length > PROFILE_FULL_NAME_MAX_LENGTH
  ) {
    return { ok: false, error: "full_name_invalid" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Validate a PATCH body into an explicit column set. Pure and total: every
 * rejected input maps to one Indonesian-message error code, and read-only keys
 * are rejected rather than silently dropped.
 */
export function buildProfileUpdate(
  input: unknown,
  at: Date = new Date(),
): ProfileUpdateResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "profile_update_empty" };
  }

  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (key in PROFILE_READ_ONLY_KEYS) {
      return { ok: false, error: "profile_field_read_only" };
    }
  }

  const update: ProfileUpdate = {};

  if ("full_name" in body) {
    const fullName = normalizeFullName(body.full_name);
    if (!fullName.ok) return { ok: false, error: fullName.error };
    update.full_name = fullName.value;
  }

  if ("username" in body) {
    const raw = body.username;
    if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) {
      update.username = null;
    } else if (typeof raw !== "string") {
      return { ok: false, error: "username_invalid" };
    } else {
      // The EXISTING username rules — never re-implemented here.
      const error = validateUsername(raw);
      if (error) return { ok: false, error };
      update.username = canonicalUsername(raw);
    }
  }

  if ("date_of_birth" in body) {
    const raw = body.date_of_birth;
    if (raw === null || raw === undefined || raw === "") {
      update.date_of_birth = null;
    } else {
      const error = validateDateOfBirth(raw, at);
      if (error) return { ok: false, error };
      update.date_of_birth = String(raw).trim();
    }
  }

  if ("phone" in body || "phone_e164" in body) {
    const raw = "phone" in body ? body.phone : body.phone_e164;
    if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) {
      // Clearing the number clears the verification too (guard_profile_write).
      update.phone_e164 = null;
    } else {
      const normalized = normalizePhoneE164(raw);
      if (!normalized.ok) return { ok: false, error: normalized.error };
      update.phone_e164 = normalized.value;
    }
  }

  if (Object.keys(update).length === 0) {
    return { ok: false, error: "profile_update_empty" };
  }

  return { ok: true, update };
}

/** True when the validated update changes the phone number (verification reset). */
export function profileUpdateTouchesPhone(update: ProfileUpdate): boolean {
  return "phone_e164" in update;
}

/**
 * The verification summary the profile API returns: the email fact from Supabase
 * Auth and the phone fact from the stored `phone_verified_at`. Nothing else is
 * reported, and no manager / Place / identity status is implied or combined —
 * those are three SEPARATE concepts (task rule) and are not part of a profile.
 */
export type AccountVerificationSummary = {
  email: { verified: boolean; value: string | null };
  phone: { verified: boolean; value: string | null };
};

export function buildVerificationSummary(input: {
  email?: string | null;
  emailConfirmedAt?: string | null;
  phoneE164?: string | null;
  phoneVerifiedAt?: string | null;
}): AccountVerificationSummary {
  return {
    email: {
      verified: Boolean(input.emailConfirmedAt),
      value: input.email?.trim() ? input.email.trim() : null,
    },
    phone: {
      verified: Boolean(input.phoneVerifiedAt),
      value: input.phoneE164?.trim() ? input.phoneE164.trim() : null,
    },
  };
}
