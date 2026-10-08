import Link from "next/link";
import { PageHeader, PageShell, backLinkClass, metaTextClass } from "@/components/ui/kit";

/**
 * Help surface — pointer-only (2026-09-27 decision on the Account Menu audit).
 *
 * No FAQ answers, contact channel, or support policy is invented: every entry
 * explains a capability that already exists in the product and links to its
 * real surface (Live report flow, Notification Settings, bell inbox,
 * Producer onboarding). Facts come from locked sources only: MASTER_LIVE_POLICY
 * (recording OFF, real-time only), migration 0008 (verified-email admission
 * gate), the Live viewer report flow (PO item 4 review by Platform
 * Admin/Moderator), and the existing Producer application route.
 */
export default function HelpPage() {
  return (
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            ← Beranda
          </Link>
        }
        title="Pusat bantuan"
        description="Panduan singkat untuk fitur yang sudah tersedia. Setiap tautan mengarah ke area yang benar-benar ada di aplikasi."
      />

      <div className="mt-4 grid gap-4">
          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Menonton Live</h2>
            <ul className="mt-1.5 grid gap-1.5 text-sm leading-6 text-black/60">
              <li>Live disiarkan real-time — tidak ada rekaman dan tidak ada tayangan ulang.</li>
              <li>
                Akses Live dan komentar melewati admission gate server-side: akun dengan email
                terverifikasi, dengan kapasitas penonton terbatas per sesi.
              </li>
              <li>
                Jika Live menampilkan konten terlarang, gunakan tombol <b>Laporkan</b> di halaman
                Live. Laporan ditinjau oleh Platform Admin/Moderator platform.
              </li>
            </ul>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Notifikasi</h2>
            <ul className="mt-1.5 grid gap-1.5 text-sm leading-6 text-black/60">
              <li>
                Inbox notifikasi tersedia melalui ikon lonceng di header.
              </li>
              <li>
                Preferensi notifikasi diatur di{" "}
                <Link href="/account/notifications" className="font-semibold text-brand-accent">
                  Setting → Notification Settings
                </Link>
                .
              </li>
            </ul>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Menjadi Pengelola</h2>
            <ul className="mt-1.5 grid gap-1.5 text-sm leading-6 text-black/60">
              <li>
                Ingin menyiarkan Live dan mengelola Tempat milikmu? Ajukan melalui halaman{" "}
                <Link href="/producer/onboarding" className="font-semibold text-brand-accent">
                  pengajuan Pengelola
                </Link>
                . Akses Pengelola diberikan admin platform.
              </li>
            </ul>
          </section>
        </div>

      <p className={`mt-5 text-black/45 ${metaTextClass}`}>
        SINGGAH LOKAL MVP — hanya area yang tercantum di halaman ini yang tersedia saat ini.
      </p>
    </PageShell>
  );
}
