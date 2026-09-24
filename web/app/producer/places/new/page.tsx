import Link from "next/link";
import PlaceForm from "../PlaceForm";

export default function NewPlacePage() {
  return <main className="min-h-screen bg-brand-cream px-5 py-8 text-brand-ink sm:px-8"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-brand-accent" href="/producer/places">← Kembali ke Place</Link><h1 className="mt-6 text-3xl font-semibold">Tambah Place</h1><p className="mt-2 text-sm text-black/60">Place baru disimpan sebagai draft sampai siap dipublikasikan.</p><section className="mt-6 rounded-xl border border-black/10 bg-white p-5"><PlaceForm /></section></div></main>;
}