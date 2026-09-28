import Link from "next/link";
import ProducerSubNav from "@/components/producer-sub-nav";
import { PlaceEditor } from "../PlaceForm";

export default async function EditPlacePage({ params }: { params: Promise<{ placeId: string }> }) {
  const { placeId: id } = await params;
  return <main className="min-h-screen bg-brand-cream px-5 py-8 text-brand-ink sm:px-8"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-brand-accent" href="/producer">← Dashboard Pengelola</Link><div className="mt-5"><ProducerSubNav active="/producer/places" /></div><h1 className="mt-6 break-words text-3xl font-semibold">Edit Tempat</h1><div className="mt-5 flex flex-wrap gap-3"><Link className="rounded-lg bg-brand-ink px-4 py-2 text-sm font-bold text-white" href={`/producer/places/${id}/production`}>Kelola Proses</Link><Link className="rounded-lg border border-black/15 px-4 py-2 text-sm font-bold" href={`/producer/places/${id}/experiences`}>Kelola Kegiatan</Link></div><section className="mt-6 rounded-xl border border-black/10 bg-white p-5"><PlaceEditor id={id} /></section></div></main>;
}
