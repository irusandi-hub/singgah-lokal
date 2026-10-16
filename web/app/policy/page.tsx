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
 *
 * The digital-management / revocation policy (permanent product policy,
 * migration 0058) is DISCLOSED here as well, because it is the policy surface
 * users already reach, and it links to the versioned Ketentuan Penggunaan
 * (/ketentuan) where that policy is stated in full. The two surfaces never
 * contradict each other: the same principles are repeated verbatim, and neither
 * claims that the wording has been legally reviewed.
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
            <h2 className="text-[15px] font-semibold">
              Kewenangan pengelolaan digital dan pencabutannya
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60" data-testid="policy-digital-management">
              Akses pengelolaan atas halaman Tempat adalah <strong>kewenangan digital</strong> sesuai
              peran dan izin di platform, bukan pengakuan, penetapan, atau jaminan kepemilikan hukum
              atas Tempat. Kepemilikan nyata tetap mengikuti bukti dan ketentuan hukum yang berlaku.
              Singgah Lokal dapat meninjau, membatasi, menangguhkan, atau mencabut kewenangan
              pengelolaan digital berdasarkan kebutuhan administratif, keamanan, kepatuhan, atau
              laporan yang diterima — tanpa wajib menunjuk pengelola pengganti. Setelah pencabutan,
              halaman dan data Tempat dapat tetap tersimpan tanpa pengelola digital aktif atau
              diarsipkan; data dan riwayat administrasi yang perlu dipertahankan tidak ikut terhapus,
              dan kepemilikan nyata tidak berubah dengan sendirinya. Pihak yang aksesnya dicabut dapat
              mengajukan peninjauan lewat mekanisme yang disediakan Singgah Lokal. Ketentuan lengkapnya
              ada di{" "}
              <Link href="/ketentuan" className="font-bold text-brand-primary underline underline-offset-2">
                Ketentuan Penggunaan
              </Link>
              .
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
