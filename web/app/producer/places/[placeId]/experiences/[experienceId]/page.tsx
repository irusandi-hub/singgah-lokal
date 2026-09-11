import Link from "next/link";
import { ExperienceEditor } from "../ExperienceForm";

export default async function EditExperiencePage({ params }: { params: Promise<{ placeId: string; experienceId: string }> }) {
  const { placeId, experienceId } = await params;
  return <main className="min-h-screen bg-[#f7f5ef] px-5 py-8 text-[#20231f] sm:px-8"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-[#7b5b38]" href={`/producer/places/${placeId}/experiences`}>← Kembali ke Experience</Link><h1 className="mt-6 text-3xl font-black">Edit Experience</h1><section className="mt-6 rounded-xl border border-black/10 bg-white p-5"><ExperienceEditor placeId={placeId} experienceId={experienceId} /></section></div></main>;
}