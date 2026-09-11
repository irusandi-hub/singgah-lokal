"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Experience } from "@/lib/experiences";

export default function ProducerExperiencesPage({ params }: { params: Promise<{ placeId: string }> }) {
  const [placeId, setPlaceId] = useState(""); const [experiences, setExperiences] = useState<Experience[]>([]); const [error, setError] = useState("");
  useEffect(() => { params.then(({ placeId: id }) => { setPlaceId(id); fetch(`/api/producer/places/${id}/experiences`).then(async (response) => response.ok ? setExperiences(await response.json()) : setError((await response.json()).error)); }); }, [params]);
  return <main className="min-h-screen bg-[#f7f5ef] px-5 py-8 text-[#20231f] sm:px-8"><div className="mx-auto max-w-3xl"><header className="flex items-start justify-between gap-4 border-b border-black/10 pb-5"><div><p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Producer App</p><h1 className="mt-2 text-3xl font-black">Experience</h1></div><Link className="rounded-lg bg-[#20231f] px-4 py-2 text-sm font-bold text-white" href={placeId ? `/producer/places/${placeId}/experiences/new` : "#"}>Tambah Experience</Link></header>{error ? <p className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</p> : <div className="mt-6 grid gap-3">{experiences.map((experience) => <Link className="rounded-xl border border-black/10 bg-white p-5" href={`/producer/places/${placeId}/experiences/${experience.id}`} key={experience.id}><div className="flex items-center justify-between gap-4"><h2 className="font-black">{experience.title}</h2><span className="text-xs font-bold uppercase text-[#7b5b38]">{experience.status}</span></div><p className="mt-2 text-sm text-black/60">{experience.durationMinutes} menit · {experience.schedules.length} jadwal</p></Link>)}{experiences.length === 0 && <p className="text-sm text-black/60">Belum ada Experience.</p>}</div>}</div></main>;
}