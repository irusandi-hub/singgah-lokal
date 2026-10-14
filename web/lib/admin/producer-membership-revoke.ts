import "server-only";

import { requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * ADMIN — mencabut hak kelola seorang Produser atas SATU Tempat.
 *
 * Modul ini adalah SATU-SATUNYA jalur penulisan untuk fitur ini, dan sengaja
 * terpisah dari `lib/admin/queries.ts`: modul itu dikunci oleh
 * `tests/admin-canonical-reads.test.ts` agar membangun service client TEPAT
 * SEKALI (di dalam `canonicalAdminClient`). Menambah penulisan di sana akan
 * memecah kontrak "satu konstruksi client" itu, jadi penulisan hidup di sini.
 *
 * Aturan:
 * - Otorisasi selalu `requirePlatformModerator()` (sesi, server-side). Actor yang
 *   diteruskan ke RPC adalah id admin hasil guard — BUKAN input klien.
 * - Klien hanya menyumbang SATU nilai: membership id. Produser dan Tempat
 *   diturunkan di dalam database dari baris membership (AGENTS.md: id dari klien
 *   tidak dipercaya). UUID divalidasi di server sebelum menyentuh RPC sehingga
 *   input rusak tidak pernah menjadi error cast Postgres.
 * - Seluruh efek (pencabutan, audit, notifikasi) dikerjakan oleh satu RPC
 *   transaksional; modul ini hanya memetakan hasilnya ke kode/HTTP Indonesia.
 */

/** Bentuk hasil yang stabil untuk klien Admin. */
export type ProducerPlaceAccessRevokeResult = {
  status: "revoked" | "already_revoked" | "invalid_target" | "last_owner";
  /** Pesan Indonesia siap tampil (server yang menentukannya). */
  message: string;
  placeName: string | null;
  producerName: string | null;
  /** Role yang dicabut (owner/manager/editor), bukan label tampilan. */
  role: string | null;
  /** True hanya bila pencabutan benar-benar terjadi DAN notifikasi terkirim. */
  notified: boolean;
};

export class ProducerPlaceAccessRevokeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Operator-facing Indonesian label per status (UI_TERMINOLOGY_STANDARD). */
export function revokeProducerPlaceAccessStatusMessage(status: string): string {
  switch (status) {
    case "already_revoked":
      return "Hak akses Pengelola sudah dicabut sebelumnya.";
    case "invalid_target":
      return "Data akses Pengelola tidak ditemukan.";
    case "last_owner":
      return "Tidak dapat dicabut: Tempat ini akan tanpa Pemilik.";
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
    case "already_revoked":
    case "last_owner":
      return 409;
    default:
      return 503;
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
  notified?: unknown;
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Cabut hak kelola Produser atas SATU Tempat.
 *
 * Returns a result object for every EXPECTED outcome (including refusals —
 * last owner, unknown id, already revoked) so the route can answer with the
 * server's own message instead of inventing one. Throws only for a
 * configuration/transport failure that is not an outcome of the operation.
 */
export async function revokeProducerPlaceAccess(
  membershipId: unknown,
): Promise<ProducerPlaceAccessRevokeResult> {
  const actor = await requirePlatformModerator();

  // Fail closed on a malformed id BEFORE the RPC: the client never gets to see
  // a Postgres cast error, and the refusal is the same shape as an unknown id.
  if (!isMembershipId(membershipId)) {
    const status = "invalid_target";
    return {
      status,
      message: revokeProducerPlaceAccessStatusMessage(status),
      placeName: null,
      producerName: null,
      role: null,
      notified: false,
    };
  }

  const { data, error } = await createSupabaseServiceClient().rpc(
    "revoke_producer_place_access",
    { p_actor_id: actor.userId, p_membership_id: membershipId.trim() },
  );
  if (error) throw new ProducerPlaceAccessRevokeError("producer_access_revoke_unavailable");

  const payload = (data ?? {}) as RawRpcResult;
  const status = asText(payload.status);
  if (status !== "revoked" && status !== "already_revoked" && status !== "invalid_target" && status !== "last_owner") {
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
    notified: payload.notified === true,
  };
}
