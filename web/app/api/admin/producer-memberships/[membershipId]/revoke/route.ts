import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import {
  ProducerPlaceAccessRevokeError,
  revokeProducerPlaceAccess,
  revokeProducerPlaceAccessHttpStatus,
  revokeProducerPlaceAccessStatusMessage,
} from "@/lib/admin/producer-membership-revoke";

export const dynamic = "force-dynamic";

/**
 * Admin: cabut hak kelola seorang Produser atas SATU Tempat
 * (POST /api/admin/producer-memberships/:membershipId/revoke).
 *
 * Kontrak:
 * - Otorisasi Platform Admin diperiksa server-side pada SETIAP request (guard
 *   eksplisit di route + diulang di data layer + diulang lagi DI DALAM fungsi DB).
 *   Signed-out atau non-admin => 403, tanpa menyentuh data.
 * - Klien hanya mengirim membership id (dari URL) dan ALASAN pencabutan (body).
 *   Identitas Produser dan Tempat diturunkan di database dari baris membership;
 *   tidak ada id Produser/Tempat dari klien yang dipercaya.
 * - Kebijakan pengelolaan digital (migration 0058): pencabutan TIDAK memerlukan
 *   pengelola pengganti. Tempat boleh tetap ada tanpa Pengelola aktif, dan hasil
 *   operasinya melaporkan keadaan itu (`managerless`) apa adanya — bukan sebagai
 *   kesalahan.
 * - Semua efek (pencabutan, pelepasan penanda Produser, audit trail, notifikasi
 *   ke pihak terdampak) terjadi dalam SATU transaksi RPC. Hasil operasi (termasuk
 *   penolakan alasan kosong dan pencabutan yang sudah pernah dilakukan)
 *   dikembalikan apa adanya dari server, supaya UI tidak pernah menampilkan
 *   sukses palsu.
 */
async function denyUnlessModerator(): Promise<NextResponse | null> {
  try {
    await requirePlatformModerator();
    return null;
  } catch {
    return NextResponse.json(
      { error: "Akses admin diperlukan.", code: "admin_required" },
      { status: 403 },
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  const denied = await denyUnlessModerator();
  if (denied) return denied;

  // The body carries ONLY the reason. A malformed/absent body is not an error
  // here: an empty reason is refused by the same validation the database
  // applies, so the operator still gets the server-owned message.
  let reason: unknown = null;
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") {
      reason = (parsed as Record<string, unknown>).reason;
    }
  } catch {
    reason = null;
  }

  try {
    const { membershipId } = await params;
    const result = await revokeProducerPlaceAccess(membershipId, reason);
    return NextResponse.json(result, {
      status: revokeProducerPlaceAccessHttpStatus(result.status),
    });
  } catch (error) {
    if (error instanceof ProducerPlaceAccessRevokeError) {
      return NextResponse.json(
        {
          error: revokeProducerPlaceAccessStatusMessage(error.code),
          code: error.code,
        },
        { status: revokeProducerPlaceAccessHttpStatus(error.code) },
      );
    }
    console.error("[admin/producer-memberships] revoke failed:", error);
    return NextResponse.json(
      { error: revokeProducerPlaceAccessStatusMessage("producer_access_revoke_unavailable") },
      { status: 503 },
    );
  }
}
