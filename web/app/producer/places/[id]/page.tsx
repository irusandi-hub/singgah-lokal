import Link from "next/link";
import { PlaceEditor } from "../PlaceForm";

export default async function EditPlacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <main className="min-h-screen bg-[#f7f5ef] px-5 py-8 text-[#20231f] sm:px-8"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-[#7b5b38]" href="/producer/places">← Kembali ke Place</Link><h1 className="mt-6 text-3xl font-black">Edit Place</h1><div className="mt-5 flex gap-3"><Link className="rounded-lg bg-[#20231f] px-4 py-2 text-sm font-bold text-white" href={`/producer/places/${id}/production`}>Kelola Dari Sini</Link><Link className="rounded-lg border border-black/15 px-4 py-2 text-sm font-bold" href={`/producer/places/${id}/experiences`}>Kelola Experience</Link></div><section className="mt-6 rounded-xl border border-black/10 bg-white p-5"><PlaceEditor id={id} /></section></div></main>;
}