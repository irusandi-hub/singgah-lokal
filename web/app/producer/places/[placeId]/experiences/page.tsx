"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";
import ExperiencesPanel from "./ExperiencesPanel";

/**
 * Kegiatan for ONE Place. The list itself is the shared ExperiencesPanel (the
 * same surface the Place editor's Kegiatan tab uses), so this page adds no
 * second list and no second "Tambah Kegiatan" action — the panel owns it.
 */
export default function ProducerExperiencesPage({ params }: { params: Promise<{ placeId: string }> }) {
  const [placeId, setPlaceId] = useState("");
  useEffect(() => { params.then(({ placeId: id }) => setPlaceId(id)); }, [params]);
  return (
    <PageShell>
      <PageHeader
        back={
          <Link className={backLinkClass} href={`/producer/places/${placeId}`}>
            ← Kembali ke Tempat
          </Link>
        }
        title="Kegiatan"
      />
      <div className="mt-4">
        {placeId ? <ExperiencesPanel placeId={placeId} /> : <p className="text-sm text-black/60">Memuat...</p>}
      </div>
    </PageShell>
  );
}
