import Link from "next/link";

/**
 * KEBIJAKAN — the public policy disclosure surface (MASTER
 * MASTER_DATA_RETENTION_ARCHIVE_POLICY_v1.0 §13).
 *
 * Every statement here is a locked fact from the Master: the 30-day claim
 * archive/evidence retention for internal operational traceability, the
 * private/short-lived evidence access, the absence of permanent preservation,
 * the application-level (never legal) nature of claim approval, the
 * between-the-parties dispute boundary, and the competent-authority rule for
 * legal determinations in the Place's jurisdiction (§1–§12). Nothing is
 * invented beyond the Master.
 */
export default function PolicyPage() {
  return (
    <main className="min-h-screen bg-brand-cream px-5 py-10 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-bold text-brand-accent">
          ← Beranda
        </Link>

        <header className="mt-8 border-b border-black/10 pb-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Kebijakan</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Kebijakan Data &amp; Klaim Tempat
          </h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Ringkasan kebijakan retensi data klaim dan batas tanggung jawab platform.
          </p>
        </header>

        <div className="mt-8 grid gap-3">
          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Retensi arsip klaim: 30 hari</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Pengajuan klaim Tempat yang sudah diputuskan disimpan sebagai arsip internal
              untuk kebutuhan operasional dan audit selama <strong>30 hari</strong>, termasuk
              bukti kepemilikan yang diunggah. Setelah 30 hari, arsip dan bukti terkait
              dihapus secara permanen. Kami <strong>tidak menjamin</strong> penyimpanan bukti
              internal setelah periode retensi berakhir.
            </p>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Bukti kepemilikan bersifat privat</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Bukti kepemilikan tidak pernah menjadi data publik. Akses ke bukti hanya
              melalui tautan privat berumur pendek untuk keperluan verifikasi berwenang,
              dan tertutup sepenuhnya setelah masa retensi berakhir.
            </p>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Persetujuan klaim bukan penetapan kepemilikan hukum</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Persetujuan klaim di SINGGAH LOKAL hanya memberikan kewenangan pengelolaan
              di dalam aplikasi. Persetujuan tersebut <strong>bukan</strong> penetapan
              kepemilikan hukum atas Tempat.
            </p>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Sengketa kepemilikan</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Sengketa kepemilikan atau klaim hukum atas sebuah Tempat adalah pembuktian
              antara para pihak. Platform tidak menentukan pihak yang benar dan tidak
              menjadi pihak pembuktian. Perubahan atau pelepasan kelola Tempat karena
              sengketa hukum hanya dilakukan berdasarkan keputusan hukum yang berlaku di
              wilayah Tempat tersebut.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
