import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  LegalAcceptanceError,
  isKnownLegalDocumentId,
  recordLegalAcceptance,
} from "@/lib/legal/acceptance";

export const dynamic = "force-dynamic";

/**
 * Catat persetujuan dokumen hukum akun yang sedang masuk
 * (POST /api/legal/accept).
 *
 * Kontrak:
 * - Sesi server menentukan SIAPA yang menyetujui. Tidak ada user id dari klien.
 * - Klien hanya menyumbang id dokumen; VERSI yang ditulis ditentukan register
 *   database (server), bukan klien.
 * - Persetujuan bersifat append-only: pengulangan permintaan idempoten dan tidak
 *   pernah mengubah atau menghapus baris yang sudah ada.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "Masuk diperlukan.", code: "auth_required" }, { status: 401 });
  }

  const documentId = body.documentId;
  if (!isKnownLegalDocumentId(documentId)) {
    return NextResponse.json(
      { error: "Dokumen tidak dikenal.", code: "invalid_document" },
      { status: 400 },
    );
  }

  try {
    const result = await recordLegalAcceptance({
      userId: userData.user.id,
      documentId,
      version: typeof body.version === "string" ? body.version : "",
    });
    return NextResponse.json({ accepted: true, version: result.version }, { status: 200 });
  } catch (error) {
    if (error instanceof LegalAcceptanceError) {
      const status = error.code === "accept_failed" ? 503 : 400;
      return NextResponse.json(
        {
          error:
            error.code === "document_unavailable"
              ? "Dokumen ketentuan belum tersedia. Coba lagi nanti."
              : "Persetujuan gagal dicatat.",
          code: error.code,
        },
        { status },
      );
    }
    console.error("[api/legal/accept] failed:", error);
    return NextResponse.json(
      { error: "Persetujuan gagal dicatat.", code: "accept_failed" },
      { status: 503 },
    );
  }
}
