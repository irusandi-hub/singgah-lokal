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
 * - Klien hanya mengirim membership id (dari URL). Identitas Produser dan Tempat
 *   diturunkan di database dari baris membership; tidak ada id Produser/Tempat
 *   dari klien yang dipercaya.
 * - Semua efek (pencabutan, audit trail, notifikasi ke pihak terdampak) terjadi
 *   dalam SATU transaksi RPC. Hasil operasi (termasuk penolakan pengaman owner
 *   terakhir dan pencabutan yang sudah pernah dilakukan) dikembalikan apa adanya
 *   dari server, supaya UI tidak pernah menampilkan sukses palsu.
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
  _request: Request,
  { params }: { params: Promise<{ membershipId: string }> },
) {
  const denied = await denyUnlessModerator();
  if (denied) return denied;

  try {
    const { membershipId } = await params;
    const result = await revokeProducerPlaceAccess(membershipId);
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
