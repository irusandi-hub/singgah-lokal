import Link from "next/link";

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
    <main className="min-h-screen bg-brand-cream px-5 py-10 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-bold text-brand-accent">
          ← Beranda
        </Link>

        <header className="mt-8 border-b border-black/10 pb-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Tentang</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Tentang SINGGAH LOKAL</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Platform discovery yang berpusat pada Tempat — tempat cerita di balik produk
            dan pengalaman lokal diceritakan.
          </p>
        </header>

        <div className="mt-8 grid gap-3">
          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Alur inti</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Map/Discovery → Tempat → Story/Production → Kegiatan → SINGGAH → Kunjungan →
              Pengelola.
            </p>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">SINGGAH adalah visit intent</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              SINGGAH mengekspresikan niat berkunjung ke sebuah Tempat — bukan checkout, keranjang,
              atau pembayaran. Harga dan tiket yang tampil bersifat informasional dari Pengelola.
            </p>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Live MVP</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Live di SINGGAH LOKAL bersifat real-time: tidak direkam dan tidak memiliki tayangan
              ulang.
            </p>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Pasar &amp; bahasa</h2>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Pasar awal: Indonesia. Bahasa utama: Bahasa Indonesia.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
