import type { AccountVerificationSummary } from "@/lib/account/profile";

/**
 * ACCOUNT PROFILE — presentation model (pure, CLIENT-SAFE).
 *
 * The profile UI (the read-only "Profil Saya" panel and the "Edit Profil"
 * screen) needs three things that must NOT be duplicated between the two
 * client components: the shape it renders, the initials fallback for the
 * avatar, and the Indonesian wording of a verification status.
 *
 * Nothing here decides anything. The status is derived ONLY from the two stored
 * facts the server returns (email from Supabase Auth, phone from
 * `phone_verified_at`) — this module never invents a verification level, and a
 * missing value is reported as "belum ada", never as verified.
 */

/** The profile data the UI renders. Filled by the server, never by the client. */
export type AccountProfileView = {
  fullName: string | null;
  username: string | null;
  email: string | null;
  dateOfBirth: string | null;
  age: number | null;
  phoneE164: string | null;
  avatarUrl: string | null;
  verification: AccountVerificationSummary;
  /** True only when the server can actually deliver an OTP (provider + secret). */
  phoneVerificationAvailable: boolean;
};

/**
 * The one label shown for the account. Order: full name → username → email →
 * the neutral account fallback. Never a fabricated name.
 */
export function accountProfileDisplayName(profile: {
  fullName?: string | null;
  username?: string | null;
  email?: string | null;
}): string {
  const fullName = profile.fullName?.trim();
  if (fullName) return fullName;
  const username = profile.username?.trim();
  if (username) return username;
  const email = profile.email?.trim();
  if (email) return email;
  return "Akun SINGGAH LOKAL";
}

/**
 * Initials for the circular avatar: the account's own initials when a full name
 * exists, else the username, else the email local part. No photo is invented —
 * the initials ARE the fallback avatar.
 */
export function accountProfileInitials(profile: {
  fullName?: string | null;
  username?: string | null;
  email?: string | null;
}): string {
  const source =
    profile.fullName?.trim() ||
    profile.username?.trim() ||
    (profile.email ?? "").split("@")[0] ||
    "";
  const segments = source.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (segments.length === 0) return "?";
  // Two words → one letter each ("Budi Santoso" → BS); one word → its first two
  // letters ("budi" → BU). Never more than two glyphs, so a long name cannot
  // overflow the circular avatar.
  const letters =
    segments.length >= 2
      ? segments.slice(0, 2).map((segment) => segment[0]).join("")
      : segments[0].slice(0, 2);
  return letters.toUpperCase() || "?";
}

/**
 * Indonesian status of ONE verification fact, straight from the server data.
 * `value` is the stored fact (email or E.164 number) so "belum ada" and
 * "belum terverifikasi" are never conflated.
 */
export function verificationStatusLabel(
  value: string | null | undefined,
  verified: boolean,
): string {
  if (!value?.trim()) return "Belum ada";
  return verified ? "Terverifikasi" : "Belum terverifikasi";
}

/** Tone for the badge beside a verification status. */
export function verificationStatusTone(
  value: string | null | undefined,
  verified: boolean,
): "positive" | "neutral" {
  return verified && Boolean(value?.trim()) ? "positive" : "neutral";
}
