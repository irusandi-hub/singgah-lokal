import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import {
  KETENTUAN_PENGGUNAAN,
  LEGAL_DOCUMENT_IDS,
  legalDocumentById,
  type LegalDocument,
} from "@/lib/legal/documents";

/**
 * PERSETUJUAN DOKUMEN HUKUM — jalur baca & tulis.
 *
 * Kontrak:
 * - VERSI BERLAKU diambil dari register `legal_documents` (migration 0059), dan
 *   dibandingkan dengan versi yang dinyatakan kode (`lib/legal/documents.ts`).
 *   Register hanya boleh MEMPERBARUI versi, tidak menggantinya dengan dokumen
 *   lain; bila isinya tidak cocok, versi register yang dipakai untuk meminta
 *   persetujuan (server yang memutuskan, bukan klien).
 * - Register belum ada di sebuah lingkungan (migrasi 0059 belum diterapkan)
 *   bukan kegagalan halaman: `available: false` dan tidak ada permintaan
 *   persetujuan. Keadaan itu dilaporkan apa adanya, bukan disembunyikan.
 * - Penulisan persetujuan HANYA untuk akun yang sedang terautentikasi (id dari
 *   sesi server) dan hanya untuk versi yang benar-benar berlaku; RLS di database
 *   menegakkan aturan yang sama untuk jalur klien, dan tulisannya append-only.
 */

/**
 * Versi yang BERLAKU menurut register publik untuk satu dokumen, dibaca tanpa
 * memerlukan sesi (halaman dokumen bersifat publik). Bila register belum
 * tersedia, versi yang dinyatakan kode dipakai dan `available` false — halaman
 * tetap menampilkan dokumen, dan tidak ada klaim versi yang tidak diketahui.
 */
export async function readLegalDocumentRegistry(input: {
  documentId: string;
}): Promise<{ version: string; effectiveAt: string; available: boolean }> {
  const document = legalDocumentById(input.documentId) ?? KETENTUAN_PENGGUNAAN;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("legal_documents")
      .select("version, effective_at")
      .eq("id", document.id)
      .maybeSingle();
    if (error || !data) {
      return { version: document.version, effectiveAt: document.effectiveAt, available: false };
    }
    const row = data as { version?: unknown; effective_at?: unknown };
    return {
      version: typeof row.version === "string" && row.version.trim() !== "" ? row.version.trim() : document.version,
      effectiveAt:
        typeof row.effective_at === "string" && row.effective_at.trim() !== ""
          ? row.effective_at
          : document.effectiveAt,
      available: true,
    };
  } catch {
    return { version: document.version, effectiveAt: document.effectiveAt, available: false };
  }
}

export type LegalAcceptanceState = {
  document: LegalDocument;
  /** Versi yang berlaku menurut register database (fallback: versi kode). */
  version: string;
  /** False bila register dokumen belum tersedia di lingkungan ini. */
  available: boolean;
  /** True bila register menyatakan versi ini wajib disetujui. */
  required: boolean;
  /** True bila versi yang berlaku sudah disetujui akun ini. */
  accepted: boolean;
  acceptedAt: string | null;
};

type RegistryRow = { version?: unknown; requires_acceptance?: unknown };

/**
 * Keadaan persetujuan Ketentuan Penggunaan untuk pengguna yang sedang masuk.
 * Fail-open HANYA pada ketersediaan register (bukan pada kewajiban), dan selalu
 * melaporkan keadaan sebenarnya.
 */
export async function readKetentuanAcceptanceState(): Promise<LegalAcceptanceState> {
  const document = KETENTUAN_PENGGUNAAN;
  const supabase = await createSupabaseServerClient();

  let version = document.version;
  let required = document.requiresAcceptance;
  let available = true;

  try {
    const { data, error } = await supabase
      .from("legal_documents")
      .select("version, requires_acceptance")
      .eq("id", document.id)
      .maybeSingle();
    if (error || !data) {
      available = false;
    } else {
      const row = data as RegistryRow;
      if (typeof row.version === "string" && row.version.trim() !== "") {
        version = row.version.trim();
      }
      required = row.requires_acceptance !== false;
    }
  } catch {
    available = false;
  }

  if (!required) {
    return { document, version, available, required, accepted: true, acceptedAt: null };
  }

  try {
    const { data, error } = await supabase
      .from("legal_document_acceptances")
      .select("accepted_at")
      .eq("document_id", document.id)
      .eq("version", version)
      .maybeSingle();
    if (error) return { document, version, available, required, accepted: false, acceptedAt: null };
    const acceptedAt = data?.accepted_at;
    return {
      document,
      version,
      available,
      required,
      accepted: typeof acceptedAt === "string",
      acceptedAt: typeof acceptedAt === "string" ? acceptedAt : null,
    };
  } catch {
    return { document, version, available, required, accepted: false, acceptedAt: null };
  }
}

export type LegalAcceptanceErrorCode = "invalid_document" | "document_unavailable" | "accept_failed";

export class LegalAcceptanceError extends Error {
  readonly code: LegalAcceptanceErrorCode;
  constructor(code: LegalAcceptanceErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Versi + kewajiban persetujuan yang BERLAKU menurut register, untuk satu
 * dokumen yang dikenal aplikasi.
 */
async function readCurrentDocVersion(documentId: string): Promise<string> {
  const document = legalDocumentById(documentId);
  if (!document) throw new LegalAcceptanceError("invalid_document");

  const admin = createSupabaseServiceClient();
  const { data, error } = await admin
    .from("legal_documents")
    .select("version, requires_acceptance")
    .eq("id", document.id)
    .maybeSingle();
  if (error) throw new LegalAcceptanceError("document_unavailable");
  if (!data) throw new LegalAcceptanceError("document_unavailable");

  const row = data as RegistryRow;
  const currentVersion = typeof row.version === "string" ? row.version.trim() : "";
  if (currentVersion === "" || row.requires_acceptance === false) {
    throw new LegalAcceptanceError("document_unavailable");
  }
  return currentVersion;
}

/**
 * Tulis baris persetujuan (append-only). Idempoten: pengulangan tidak membuat
 * baris kedua dan tidak melempar error.
 */
async function writeAcceptance(
  userId: string,
  documentId: string,
  version: string,
): Promise<void> {
  const { error } = await createSupabaseServiceClient()
    .from("legal_document_acceptances")
    .upsert(
      { user_id: userId, document_id: documentId, version },
      { onConflict: "user_id,document_id,version", ignoreDuplicates: true },
    );
  if (error) throw new LegalAcceptanceError("accept_failed");
}

/**
 * Catat persetujuan satu akun atas VERSI YANG BERLAKU saat ini.
 *
 * Dipakai jalur yang tidak menerima versi dari klien (mis. pendaftaran akun
 * baru): server sendiri yang menentukan versinya. `userId` WAJIB berasal dari
 * sesi server atau dari respons signUp milik Supabase — tidak pernah dari input
 * klien.
 */
export async function acceptCurrentLegalDocument(input: {
  userId: string;
  documentId: string;
}): Promise<{ accepted: true; version: string }> {
  const version = await readCurrentDocVersion(input.documentId);
  await writeAcceptance(input.userId, input.documentId, version);
  return { accepted: true, version };
}

/**
 * Catat persetujuan satu akun atas satu dokumen, dengan versi yang dikirim
 * klien hanya sebagai penanda. Versi ditentukan ulang dari register, dan
 * ketidakcocokan DITOLAK — klien tidak dapat menandai persetujuan untuk versi
 * lain.
 */
export async function recordLegalAcceptance(input: {
  userId: string;
  documentId: string;
  version: string;
}): Promise<{ accepted: true; version: string }> {
  const currentVersion = await readCurrentDocVersion(input.documentId);
  if (input.version.trim() !== currentVersion) {
    throw new LegalAcceptanceError("invalid_document");
  }
  await writeAcceptance(input.userId, input.documentId, currentVersion);
  return { accepted: true, version: currentVersion };
}

/** Apakah id dokumen ini dikenal aplikasi (dipakai route sebelum menulis). */
export function isKnownLegalDocumentId(value: unknown): value is string {
  return typeof value === "string" && Object.values(LEGAL_DOCUMENT_IDS).includes(value as never);
}
