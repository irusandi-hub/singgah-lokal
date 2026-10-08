"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, PageShell, Panel, backLinkClass } from "@/components/ui/kit";
import ExperienceForm from "../ExperienceForm";

export default function NewExperiencePage({ params }: { params: Promise<{ placeId: string }> }) {
  const [placeId, setPlaceId] = useState("");
  const [timezone, setTimezone] = useState("");
  useEffect(() => {
    params.then(({ placeId: id }) => {
      setPlaceId(id);
      fetch(`/api/producer/places/${id}`).then((response) => response.json()).then((place) => setTimezone(place.timezone));
    });
  }, [params]);
  return (
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href={`/producer/places/${placeId}/experiences`}>
            ← Kembali ke Kegiatan
          </Link>
        }
        title="Tambah Kegiatan"
      />
      <div className="mt-4">
        <Panel>
          <ExperienceForm placeId={placeId} placeTimezone={timezone || "Asia/Jakarta"} />
        </Panel>
      </div>
    </PageShell>
  );
}
