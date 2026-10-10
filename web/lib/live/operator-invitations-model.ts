/**
 * LIVE OPERATOR INVITATIONS — domain model (pure, client-safe).
 *
 * The Master documents (MASTER_LIVE_POLICY / MASTER_LIVE_TECH) define Live and
 * delegated Operator Live access (migration 0047) but do NOT define an
 * invitation lifecycle. This module is the single place holding the technical
 * constants and Indonesian copy for that lifecycle so the server, the database
 * migration, and any future UI read from ONE source. It introduces no new
 * business rule beyond what the task specification locked; every value that the
 * Masters leave undefined is recorded as a Policy Gap in HANDOFF_LIVE_MVP.md.
 *
 * State machine (enforced in the database AND in the server RPCs):
 *   pending  → accepted | rejected | cancelled | expired
 *   accepted → revoked
 * Terminal: rejected, cancelled, expired, revoked. A new invitation is a NEW
 * record — a terminal row is never reopened.
 */

export const LIVE_OPERATOR_INVITATION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "cancelled",
  "expired",
  "revoked",
] as const;

export type LiveOperatorInvitationStatus =
  (typeof LIVE_OPERATOR_INVITATION_STATUSES)[number];

/** Accepted but no longer in force, or never accepted and closed. */
export const LIVE_OPERATOR_INVITATION_TERMINAL_STATUSES = [
  "rejected",
  "cancelled",
  "expired",
  "revoked",
] as const;

export type LiveOperatorInvitationTerminalStatus =
  (typeof LIVE_OPERATOR_INVITATION_TERMINAL_STATUSES)[number];

/**
 * POLICY GAP: the Masters do not define an invitation expiry duration. This is
 * the single configured constant (also mirrored by the database default in
 * migration 0048). Change this value AND the migration default together.
 */
export const LIVE_OPERATOR_INVITATION_TTL_DAYS = 7;

export const LIVE_OPERATOR_INVITATION_TTL_MS =
  LIVE_OPERATOR_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Invitation request rate limit (per inviting manager).
 * POLICY GAP: the Masters do not define a rate limit; the task requires one at
 * the invitation endpoint as an anti-enumeration control. Same in-process
 * mechanism the Live comment limiter already uses; a shared store is the
 * upgrade path for multi-instance deployments.
 */
export const LIVE_OPERATOR_INVITE_MIN_INTERVAL_MS = 3000;

/** Indonesian status labels (UI_TERMINOLOGY_STANDARD: "Operator Live"). */
export const LIVE_OPERATOR_INVITATION_STATUS_LABELS: Readonly<
  Record<LiveOperatorInvitationStatus, string>
> = {
  pending: "Menunggu",
  accepted: "Diterima",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
  expired: "Kedaluwarsa",
  revoked: "Dicabut",
};

/**
 * Indonesian messages for the invitation lifecycle surfaces, keyed by the
 * stable server error code. `invalid` covers every rejected transition (the
 * server never tells a caller which state a foreign invitation is in).
 */
export const LIVE_OPERATOR_INVITATION_MESSAGES: Readonly<Record<string, string>> = {
  authentication_required: "Sesi berakhir. Masuk kembali untuk melanjutkan.",
  producer_authorization_required:
    "Kamu tidak mengelola Tempat ini, jadi tidak dapat mengubah akses Live-nya.",
  placeId_required: "Pilih Tempat terlebih dahulu.",
  email_required: "Masukkan email akun yang ingin diundang.",
  email_invalid: "Format email tidak valid.",
  invitation_id_required: "Undangan tidak dikenali.",
  live_operator_invite_self_not_allowed:
    "Kamu sudah mengelola Tempat ini; tidak perlu mengundang diri sendiri.",
  live_operator_invite_rate_limited:
    "Terlalu banyak undangan dalam waktu singkat. Coba lagi sebentar.",
  live_operator_invitation_invalid:
    "Undangan ini sudah tidak dapat diproses.",
  live_operator_invitation_forbidden:
    "Kamu tidak berwenang memproses undangan ini.",
  live_operator_invitation_not_found: "Undangan tidak ditemukan.",
  live_operator_invitation_expired: "Undangan sudah kedaluwarsa.",
  live_operator_invitation_unavailable:
    "Undangan Operator Live tidak tersedia saat ini.",
};

export function liveOperatorInvitationMessage(
  code: string | undefined,
  fallback = "Terjadi kesalahan. Coba lagi.",
): string {
  if (!code) return fallback;
  return LIVE_OPERATOR_INVITATION_MESSAGES[code] ?? fallback;
}

export function isLiveOperatorInvitationStatus(
  value: unknown,
): value is LiveOperatorInvitationStatus {
  return (
    typeof value === "string" &&
    (LIVE_OPERATOR_INVITATION_STATUSES as readonly string[]).includes(value)
  );
}
