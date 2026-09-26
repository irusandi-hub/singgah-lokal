"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Experience } from "@/lib/experiences";

/**
 * Experience management for ONE Place — extracted from the standalone
 * experiences page (PO, mockup work 2026-09-26) so the Place editor's
 * "Experience" tab reuses the EXACT same surface instead of a parallel list.
 * Data still comes from the canonical Producer experiences API; nothing
 * about the backend changes.
 */
export default function ExperiencesPanel({ placeId }: { placeId: string }) {
  const [experiences, setExperiences] = useState<Experience[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/producer/places/${placeId}/experiences`)
      .then(async (response) => {
        if (cancelled) return;
        if (response.ok) { setExperiences(await response.json()); return; }
        setError((await response.json().catch(() => ({}))).error ?? "Experience tidak dapat dimuat");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [placeId]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-black/60">Experience yang dapat dikelola untuk Place ini.</p>
        <Link
          className="rounded-lg bg-brand-ink px-4 py-2 text-sm font-bold text-white"
          href={`/producer/places/${placeId}/experiences/new`}
        >
          Tambah Experience
        </Link>
      </div>
      {error ? (
        <p className="rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</p>
      ) : (
        <div className="grid gap-3">
          {experiences.map((experience) => (
            <Link
              className="rounded-xl border border-black/10 bg-white p-5"
              href={`/producer/places/${placeId}/experiences/${experience.id}`}
              key={experience.id}
            >
              <div className="flex items-center justify-between gap-4">
                <h3 className="font-semibold">{experience.title}</h3>
                <span className="text-xs font-bold uppercase text-brand-accent">{experience.status}</span>
              </div>
              <p className="mt-2 text-sm text-black/60">{experience.durationMinutes} menit · {experience.schedules.length} jadwal</p>
            </Link>
          ))}
          {experiences.length === 0 && <p className="text-sm text-black/60">Belum ada Experience.</p>}
        </div>
      )}
    </div>
  );
}
