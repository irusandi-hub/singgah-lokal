import Link from "next/link";
import PlaceForm from "../PlaceForm";

export default function NewPlacePage() {
  return <main className="min-h-screen bg-[#f7f5ef] px-5 py-8 text-[#20231f] sm:px-8"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-[#7b5b38]" href="/producer/places">← Kembali ke Place</Link><h1 className="mt-6 text-3xl font-black">Tambah Place</h1><p className="mt-2 text-sm text-black/60">Place baru disimpan sebagai draft sampai siap dipublikasikan.</p><section className="mt-6 rounded-xl border border-black/10 bg-white p-5"><PlaceForm /></section></div></main>;
}