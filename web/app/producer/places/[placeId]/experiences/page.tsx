"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import ExperiencesPanel from "./ExperiencesPanel";

export default function ProducerExperiencesPage({ params }: { params: Promise<{ placeId: string }> }) {
  const [placeId, setPlaceId] = useState("");
  useEffect(() => { params.then(({ placeId: id }) => setPlaceId(id)); }, [params]);
  return (
    <main className="min-h-screen bg-brand-cream px-5 py-8 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-3xl">
        <header className="flex items-start justify-between gap-4 border-b border-black/10 pb-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Producer App</p>
            <h1 className="mt-2 text-3xl font-semibold">Experience</h1>
          </div>
          <Link className="rounded-lg bg-brand-ink px-4 py-2 text-sm font-bold text-white" href={placeId ? `/producer/places/${placeId}/experiences/new` : "#"}>Tambah Experience</Link>
        </header>
        <div className="mt-6">
          {placeId ? <ExperiencesPanel placeId={placeId} /> : <p className="text-sm text-black/60">Memuat...</p>}
        </div>
      </div>
    </main>
  );
}
