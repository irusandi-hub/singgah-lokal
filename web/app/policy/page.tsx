import Link from "next/link";
import { PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";

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
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            ← Beranda
          </Link>
        }
        title="Kebijakan Data & Klaim Tempat"
        description="Ringkasan kebijakan retensi data klaim dan batas tanggung jawab platform."
      />

      <div className="mt-4 grid gap-4">
          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Retensi arsip klaim: 30 hari</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Pengajuan klaim Tempat yang sudah diputuskan disimpan sebagai arsip internal
              untuk kebutuhan operasional dan audit selama <strong>30 hari</strong>, termasuk
              bukti kepemilikan yang diunggah. Setelah 30 hari, arsip dan bukti terkait
              dihapus secara permanen. Kami <strong>tidak menjamin</strong> penyimpanan bukti
              internal setelah periode retensi berakhir.
            </p>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Bukti kepemilikan bersifat privat</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Bukti kepemilikan tidak pernah menjadi data publik. Akses ke bukti hanya
              melalui tautan privat berumur pendek untuk keperluan verifikasi berwenang,
              dan tertutup sepenuhnya setelah masa retensi berakhir.
            </p>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Persetujuan klaim bukan penetapan kepemilikan hukum</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Persetujuan klaim di SINGGAH LOKAL hanya memberikan kewenangan pengelolaan
              di dalam aplikasi. Persetujuan tersebut <strong>bukan</strong> penetapan
              kepemilikan hukum atas Tempat.
            </p>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Sengketa kepemilikan</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Sengketa kepemilikan atau klaim hukum atas sebuah Tempat adalah pembuktian
              antara para pihak. Platform tidak menentukan pihak yang benar dan tidak
              menjadi pihak pembuktian. Perubahan atau pelepasan kelola Tempat karena
              sengketa hukum hanya dilakukan berdasarkan keputusan hukum yang berlaku di
              wilayah Tempat tersebut.
            </p>
          </section>
      </div>
    </PageShell>
  );
}
