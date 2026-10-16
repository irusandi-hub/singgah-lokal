/**
 * DOKUMEN HUKUM — identitas, versi, dan isi prosa. MURNI (tanpa server-only),
 * supaya halaman publik, form persetujuan, dan test memakai satu sumber yang
 * sama.
 *
 * ATURAN SUMBER KEBENARAN
 * - Prosa dokumen hidup DI SINI, satu salinan. Tabel `legal_documents`
 *   (migration 0059) hanya memegang identitas + VERSI BERLAKU + tanggal
 *   berlaku + kewajiban persetujuan; `tests/legal-documents.test.ts` gagal bila
 *   versi di sini berbeda dengan versi yang berlaku di database.
 * - Setiap kalimat adalah pernyataan yang sudah terkunci di Master atau di
 *   instruksi produk. Tidak ada kanal kontak, badan hukum, yurisdiksi,
 *   kompensasi, atau janji yang dikarang.
 * - Dokumen ini BELUM ditinjau hukum. Penandanya wajib terlihat di UI; tidak ada
 *   tempat mana pun yang boleh menyatakan dokumen ini sudah final secara hukum.
 */

/** Dokumen hukum yang terdaftar. Id-nya sama dengan primary key di database. */
export const LEGAL_DOCUMENT_IDS = {
  ketentuanPenggunaan: "ketentuan-penggunaan",
} as const;

export type LegalDocumentId = (typeof LEGAL_DOCUMENT_IDS)[keyof typeof LEGAL_DOCUMENT_IDS];

export type LegalDocumentSection = {
  heading: string;
  paragraphs: readonly string[];
  bullets?: readonly string[];
};

export type LegalDocument = {
  id: LegalDocumentId;
  /** Nama tampilan dokumen. */
  title: string;
  /** Versi yang berlaku; WAJIB sama dengan baris `legal_documents` (0059). */
  version: string;
  /** Tanggal berlaku (ISO, UTC). */
  effectiveAt: string;
  /** Halaman publik tempat dokumen ini dibaca pengguna. */
  href: string;
  /** Apakah akun wajib menyatakan persetujuan atas versi ini. */
  requiresAcceptance: boolean;
  /** Ringkas satu baris untuk daftar/rujukan. */
  summary: string;
  sections: readonly LegalDocumentSection[];
};

/**
 * Penanda peninjauan hukum. Ditampilkan di halaman dokumen dan di kartu
 * persetujuan; tidak boleh dihapus selama peninjauan belum selesai.
 */
export const LEGAL_REVIEW_NOTICE =
  "Dokumen ini menunggu peninjauan hukum dan belum dinyatakan final secara hukum.";

export const KETENTUAN_PENGGUNAAN: LegalDocument = {
  id: LEGAL_DOCUMENT_IDS.ketentuanPenggunaan,
  title: "Ketentuan Penggunaan",
  version: "1.1",
  effectiveAt: "2026-10-15T00:00:00Z",
  href: "/ketentuan",
  requiresAcceptance: true,
  summary:
    "Ketentuan penggunaan platform, termasuk kewenangan pengelolaan digital atas Tempat dan pencabutannya.",
  sections: [
    {
      heading: "Ruang lingkup",
      paragraphs: [
        "Singgah Lokal merupakan platform digital yang menyediakan sarana untuk menampilkan, mempromosikan, dan mengelola informasi tempat secara online.",
        "SINGGAH adalah pernyataan niat berkunjung (visit intent), bukan pemesanan, checkout, atau pembayaran. Harga dan tiket yang tampil bersifat informasional dari Pengelola.",
        "Ketentuan ini berlaku untuk penggunaan platform, termasuk akun pengguna, akun Pengelola, dan pengelolaan halaman Tempat.",
      ],
    },
    {
      heading: "Kewenangan Pengelolaan Digital dan Pencabutan Akses",
      paragraphs: [
        "Pemberian akses pengelolaan terhadap suatu halaman tempat hanya memberikan kewenangan digital sesuai dengan peran dan izin yang diberikan dalam platform. Pemberian akses tersebut tidak dengan sendirinya merupakan pengakuan, penetapan, atau jaminan atas kepemilikan hukum terhadap tempat yang bersangkutan.",
        "Kepemilikan nyata atas tempat tetap mengikuti bukti dan ketentuan hukum yang berlaku di dunia nyata.",
        "Singgah Lokal berhak meninjau, membatasi, menangguhkan, atau mencabut kewenangan pengelolaan digital atas suatu tempat berdasarkan kebutuhan administratif, keamanan, kepatuhan terhadap ketentuan platform, laporan yang diterima, atau alasan lain yang sah sesuai dengan Ketentuan Penggunaan dan hukum yang berlaku.",
        "Alasan pencabutan antara lain: akun tidak lagi memiliki kewenangan mengelola tempat; ada sengketa atau laporan yang memerlukan peninjauan administratif; akun menyalahgunakan izin pengelolaan; akun melanggar ketentuan platform; atau intervensi administratif diperlukan untuk melindungi pengguna atau integritas platform.",
        "Setelah hak pengelolaan dicabut, Singgah Lokal dapat mempertahankan halaman dan data tempat sebagai arsip atau membiarkan tempat tersebut tetap tersimpan tanpa pengelola digital aktif. Keadaan tersebut tidak mengharuskan Singgah Lokal menunjuk pengelola pengganti dan tidak dengan sendirinya mengubah kepemilikan nyata atas tempat.",
        "Pencabutan hak pengelolaan digital tidak dengan sendirinya menghapus data tempat atau riwayat administrasi yang perlu dipertahankan secara sah. Penyimpanan, pembatasan akses, dan penghapusan data tetap tunduk pada kebijakan privasi serta hukum yang berlaku.",
        "Pencabutan kewenangan pengelolaan digital berlaku pada seluruh jalur kewenangan di platform, termasuk tampilan aplikasi, pemrosesan di server, fungsi basis data, dan kebijakan akses data. Hanya penyembunyian tampilan bukan pencabutan.",
        "Pencabutan kewenangan pengelolaan atas satu tempat tidak mengubah kewenangan atas tempat lain yang dikelola akun yang sama, tidak mengubah data tempat yang tidak terkait, dan tidak menghapus riwayat administrasi yang perlu dipertahankan. Pemberian kewenangan pengelolaan berikutnya hanya melalui proses penugasan atau persetujuan resmi yang disediakan platform.",
        "Pihak yang aksesnya dicabut dapat mengajukan peninjauan atau keberatan melalui mekanisme yang disediakan Singgah Lokal, sesuai dengan kebijakan platform.",
      ],
    },
    {
      heading: "Data, arsip, dan sengketa",
      paragraphs: [
        "Ketentuan retensi arsip klaim Tempat, sifat privat bukti kepemilikan, dan batas tanggung jawab platform terhadap sengketa kepemilikan dirangkum pada halaman Kebijakan Data & Klaim Tempat.",
        "Persetujuan klaim di platform adalah keadaan di dalam aplikasi, bukan penetapan kepemilikan hukum. Sengketa kepemilikan adalah pembuktian antara para pihak, dan tindakan yang memerlukan penetapan hukum mengikuti otoritas yang berwenang di wilayah Tempat.",
      ],
    },
    {
      heading: "Versi dan persetujuan",
      paragraphs: [
        "Dokumen ini memiliki versi. Versi yang berlaku, tanggal berlakunya, dan kewajiban persetujuannya dicatat pada register dokumen di platform; catatan persetujuan akun bersifat menetap (append-only) dan tidak dapat diubah atau dihapus.",
        "Perubahan material pada dokumen ini diterbitkan sebagai versi baru. Akun dapat diminta menyatakan persetujuan atas versi yang berlaku, dan permintaan itu ditampilkan di dalam aplikasi.",
        "Dokumen ini menunggu peninjauan hukum dan belum dinyatakan final secara hukum.",
      ],
    },
  ],
};

/** Semua dokumen hukum yang dikenal aplikasi. */
export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [KETENTUAN_PENGGUNAAN];

export function legalDocumentById(id: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((document) => document.id === id);
}
