import "server-only";

import { requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import {
  REVOKE_REASON_MAX_LENGTH,
  REVOKE_REASON_MIN_LENGTH,
  REVOKE_REASON_OPTIONS,
  normalizeRevokeReason,
  revokeProducerPlaceAccessHttpStatus,
  revokeProducerPlaceAccessStatusMessage,
  type ProducerPlaceAccessRevokeStatus,
} from "@/lib/admin/revoke-reason";

// Re-exported so every caller of the ONE revocation module sees the same pure
// policy helpers that the Admin form (a client component) uses.
export {
  REVOKE_REASON_MAX_LENGTH,
  REVOKE_REASON_MIN_LENGTH,
  REVOKE_REASON_OPTIONS,
  normalizeRevokeReason,
  revokeProducerPlaceAccessHttpStatus,
  revokeProducerPlaceAccessStatusMessage,
};

/**
 * ADMIN — mencabut kewenangan pengelolaan digital seorang Produser atas SATU
 * Tempat (kebijakan permanen, migration 0058).
 *
 * Kebijakan yang ditegakkan modul ini:
 * - Peran di aplikasi = kewenangan DIGITAL, bukan kepemilikan hukum (aturan A).
 * - Platform Admin dapat mencabut TANPA menunjuk pengelola pengganti (aturan B).
 * - Tempat tanpa Pengelola aktif adalah keadaan yang SAH (aturan C). Hasilnya
 *   melaporkan `managerless` supaya UI dapat menampilkannya apa adanya.
 * - Pencabutan berlaku pada semua jalur otorisasi karena satu-satunya sumber
 *   kewenangan (`producer_memberships`) hilang di database (aturan D); modul ini
 *   tidak pernah "menyembunyikan tombol" sebagai pengganti otorisasi.
 * - ALASAN PENCABUTAN WAJIB dan dicatat di trail audit.
 *
 * Modul ini adalah SATU-SATUNYA jalur penulisan untuk fitur ini, dan sengaja
 * terpisah dari `lib/admin/queries.ts`: modul itu dikunci oleh
 * `tests/admin-canonical-reads.test.ts` agar membangun service client TEPAT
 * SEKALI (di dalam `canonicalAdminClient`). Menambah penulisan di sana akan
 * memecah kontrak "satu konstruksi client" itu, jadi penulisan hidup di sini.
 *
 * Aturan lain:
 * - Otorisasi selalu `requirePlatformModerator()` (sesi, server-side). Actor yang
 *   diteruskan ke RPC adalah id admin hasil guard — BUKAN input klien.
 * - Klien hanya menyumbang DUA nilai: membership id dan alasan. Produser dan
 *   Tempat diturunkan di dalam database dari baris membership (AGENTS.md: id dari
 *   klien tidak dipercaya).
 * - Seluruh efek (pencabutan, pelepasan penanda Produser, audit, notifikasi)
 *   dikerjakan oleh satu RPC transaksional; modul ini hanya memetakan hasilnya ke
 *   kode/HTTP Indonesia.
 */

/**
 * Hasil operasi. `managerless` true berarti Tempat itu sekarang TIDAK punya
 * Pengelola digital aktif — keadaan sah, bukan kesalahan.
 */
export type ProducerPlaceAccessRevokeResult = {
  status: ProducerPlaceAccessRevokeStatus;
  /** Pesan Indonesia siap tampil (server yang menentukannya). */
  message: string;
  placeName: string | null;
  producerName: string | null;
  /** Role yang dicabut (owner/manager/editor), bukan label tampilan. */
  role: string | null;
  reason: string | null;
  /** True hanya bila pencabutan benar-benar terjadi DAN notifikasi terkirim. */
  notified: boolean;
  /** Jumlah Pengelola digital yang tersisa pada Tempat itu setelah operasi. */
  managerCount: number | null;
  /** True bila Tempat itu kini tanpa Pengelola digital aktif. */
  managerless: boolean | null;
  /** Status publikasi Tempat ('draft' | 'published' | 'paused' | 'archived'). */
  placePublicationStatus: string | null;
};

export class ProducerPlaceAccessRevokeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMembershipId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

type RawRpcResult = {
  ok?: unknown;
  status?: unknown;
  message?: unknown;
  placeName?: unknown;
  producerName?: unknown;
  role?: unknown;
  reason?: unknown;
  notified?: unknown;
  managerCount?: unknown;
  managerless?: unknown;
  placePublicationStatus?: unknown;
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Cabut kewenangan pengelolaan digital seorang Produser atas SATU Tempat.
 *
 * Returns a result object for every EXPECTED outcome (including refusals —
 * invalid target, missing reason, already revoked) so the route can answer with
 * the server's own message instead of inventing one. Throws only for a
 * configuration/transport failure that is not an outcome of the operation.
 */
export async function revokeProducerPlaceAccess(
  membershipId: unknown,
  reasonInput: unknown,
): Promise<ProducerPlaceAccessRevokeResult> {
  const actor = await requirePlatformModerator();

  const refusal = (
    status: Extract<ProducerPlaceAccessRevokeStatus, "invalid_target" | "invalid_reason">,
  ): ProducerPlaceAccessRevokeResult => ({
    status,
    message: revokeProducerPlaceAccessStatusMessage(status),
    placeName: null,
    producerName: null,
    role: null,
    reason: null,
    notified: false,
    managerCount: null,
    managerless: null,
    placePublicationStatus: null,
  });

  // Fail closed BEFORE the RPC: a malformed id or a missing/too-short reason
  // never reaches the database, so the refusal is the same shape as any other
  // refused outcome and no Postgres cast error can appear.
  if (!isMembershipId(membershipId)) return refusal("invalid_target");
  const reason = normalizeRevokeReason(reasonInput);
  if (reason === null) return refusal("invalid_reason");

  const { data, error } = await createSupabaseServiceClient().rpc(
    "revoke_producer_place_access",
    {
      p_actor_id: actor.userId,
      p_membership_id: membershipId.trim(),
      p_reason: reason,
    },
  );
  if (error) throw new ProducerPlaceAccessRevokeError("producer_access_revoke_unavailable");

  const payload = (data ?? {}) as RawRpcResult;
  const status = asText(payload.status);
  if (
    status !== "revoked" &&
    status !== "already_revoked" &&
    status !== "invalid_target" &&
    status !== "invalid_reason"
  ) {
    throw new ProducerPlaceAccessRevokeError("producer_access_revoke_unavailable");
  }

  return {
    status,
    // The database owns the wording; this only fills a gap if a future RPC
    // returns a bare status (never fabricates a success message).
    message: asText(payload.message) ?? revokeProducerPlaceAccessStatusMessage(status),
    placeName: asText(payload.placeName),
    producerName: asText(payload.producerName),
    role: asText(payload.role),
    reason: asText(payload.reason),
    notified: payload.notified === true,
    managerCount: asCount(payload.managerCount),
    managerless: typeof payload.managerless === "boolean" ? payload.managerless : null,
    placePublicationStatus: asText(payload.placePublicationStatus),
  };
}
