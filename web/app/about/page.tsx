import Link from "next/link";
import { PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";

/**
 * About surface — product identity only (2026-09-27 decision on the Account
 * Menu audit). Every statement is a locked fact from the Masters:
 * Place-centered discovery + the core flow (AGENTS.md / MASTER_INDEX),
 * SINGGAH = visit intent, not checkout/payment (AGENTS.md locked rule),
 * initial market + language (MASTER 01), Live = real-time, no recording
 * (MASTER_LIVE_POLICY). No legal text, roadmap, entity, or contact is
 * invented; Terms/Privacy await their own source-of-truth and are therefore
 * not claimed here.
 */
export default function AboutPage() {
  return (
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            ← Beranda
          </Link>
        }
        title="Tentang SINGGAH LOKAL"
        description="Platform discovery yang berpusat pada Tempat — tempat cerita di balik produk dan pengalaman lokal diceritakan."
      />

      <div className="mt-4 grid gap-4">
          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Alur inti</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Map/Discovery → Tempat → Story/Production → Kegiatan → SINGGAH → Kunjungan →
              Pengelola.
            </p>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">SINGGAH adalah visit intent</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              SINGGAH mengekspresikan niat berkunjung ke sebuah Tempat. Harga dan tiket yang tampil
              bersifat informasional dari Pengelola.
            </p>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Live MVP</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Live di SINGGAH LOKAL bersifat real-time: tidak direkam dan tidak memiliki tayangan
              ulang.
            </p>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Pasar &amp; bahasa</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Pasar awal: Indonesia. Bahasa utama: Bahasa Indonesia.
            </p>
          </section>

          <section className="border-t border-black/10 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-[15px] font-semibold">Kebijakan</h2>
            <p className="mt-1.5 text-sm leading-6 text-black/60">
              Retensi arsip klaim Tempat (30 hari), sifat privat bukti kepemilikan, dan
              batas tanggung jawab platform terhadap sengketa kepemilikan dirangkum di{" "}
              <Link href="/policy" className="font-bold text-brand-primary underline underline-offset-2">
                halaman Kebijakan
              </Link>
              .
            </p>
          </section>
      </div>
    </PageShell>
  );
}
