import Link from "next/link";
import { places } from "@/lib/places";
import { getProducerPlaces } from "@/lib/producer";

const producerSession: null = null;

export default function ProducerVisitIntentsPage() {
  const authorizedPlaces = producerSession ? getProducerPlaces(places, producerSession) : [];

  return (
    <main className="min-h-screen bg-[#20231f] px-4 py-5 text-[#f7f5ef] sm:px-6">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-white/15 pb-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#d8ad6f]">Producer App</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight">Visit Intents</h1>
            <p className="mt-2 max-w-md text-sm leading-6 text-white/65">Kelola niat berkunjung untuk Place yang berada dalam kewenangan akun Producer.</p>
          </div>
          <Link className="rounded-full border border-white/20 px-3 py-2 text-xs font-bold text-white/80" href="/">
            Lihat publik
          </Link>
        </header>

        <section className="mt-6 rounded-2xl border border-white/15 bg-white/10 p-5" aria-labelledby="inbox-heading">
          <div className="flex items-center justify-between gap-4">
            <h2 id="inbox-heading" className="text-lg font-black">Inbox operasional</h2>
            <span className="rounded-full bg-[#d8ad6f] px-3 py-1 text-xs font-black text-[#20231f]">{authorizedPlaces.length} Place</span>
          </div>
          {!producerSession ? (
            <p className="mt-5 rounded-xl bg-black/20 p-4 text-sm leading-6 text-white/70">
              Inbox memerlukan sesi Producer terautentikasi. Tidak ada Place atau Visit Intent yang ditampilkan sebelum authorization server tersedia.
            </p>
          ) : authorizedPlaces.length === 0 ? (
            <p className="mt-5 rounded-xl bg-black/20 p-4 text-sm leading-6 text-white/70">Belum ada Place yang ditautkan ke akun Producer ini.</p>
          ) : (
            <p className="mt-5 text-sm leading-6 text-white/70">Belum ada Visit Intent untuk Place yang dapat kamu kelola.</p>
          )}
        </section>

        <p className="mt-6 text-xs leading-5 text-white/45">Visit Intent adalah niat berkunjung, bukan pembayaran atau konfirmasi reservasi.</p>
      </div>
    </main>
  );
}