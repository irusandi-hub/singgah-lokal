"use client";

import Link from "next/link";
import { useState } from "react";
import PlaceForm, { PlaceEditor } from "./PlaceForm";
import type { Place } from "@/lib/places";

/**
 * PLACE MILIKMU — the Place working surface of the Producer dashboard
 * (PO, mockup work 2026-09-26). The roster, the add form, and the editor all
 * live HERE, so the dashboard is one working page and no intermediary
 * "Place saya → Tambah Place" page exists. Reuses the existing PlaceForm /
 * PlaceEditor and the canonical Producer API — no parallel form, no new
 * backend. The view is an explicit state machine:
 * - "list": the roster (the default on every load);
 * - "new": the add form, ALWAYS empty (PlaceForm's NEW branch);
 * - "edit": the chosen Place, loaded by the existing PlaceEditor.
 * A successful NEW submit transitions new → edit/manage for the saved Place
 * (id preserved, Upload immediately usable), and the roster gains it.
 */
type ProducerPlaceWorkspaceView =
  | { name: "list" }
  | { name: "new" }
  | { name: "edit"; place: Place };

const STATUS_DOT: Record<Place["publicationStatus"], string> = {
  published: "bg-green-600",
  draft: "bg-amber-500",
  paused: "bg-amber-500",
  archived: "bg-black/30",
};

export default function ProducerPlaceWorkspace({ initialPlaces, showOnboardingHint = false }: { initialPlaces: Place[]; showOnboardingHint?: boolean }) {
  const [view, setView] = useState<ProducerPlaceWorkspaceView>({ name: "list" });
  const [places, setPlaces] = useState<Place[]>(initialPlaces);

  // Save handler for BOTH modes (existing behavior). A successful NEW submit
  // upserts the roster and flips new → edit/manage with the saved record —
  // the Place ID is preserved, so Upload is usable immediately.
  function handleSaved(saved: Place) {
    setPlaces((current) =>
      current.some((place) => place.id === saved.id)
        ? current.map((place) => (place.id === saved.id ? saved : place))
        : [...current, saved],
    );
    setView({ name: "edit", place: saved });
  }

  if (view.name === "new") {
    return (
      <section aria-label="Tambah Place" className="mt-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Tambah Place</h2>
          <button
            type="button"
            onClick={() => setView({ name: "list" })}
            className="rounded-lg border border-black/15 px-4 py-2 text-sm font-bold"
          >
            Kembali ke daftar
          </button>
        </div>
        <p className="mb-4 text-sm text-black/60">Lengkapi informasi Place. Setelah disimpan, kamu dapat menambahkan foto, Experience, dan mengelola Place.</p>
        <div className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
          <PlaceForm onSaved={handleSaved} />
        </div>
      </section>
    );
  }

  if (view.name === "edit") {
    return (
      <section aria-label="Edit Place" className="mt-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Kelola Place</h2>
            <p className="mt-1 text-xs text-black/55">ID: {view.place.id}</p>
          </div>
          <button
            type="button"
            onClick={() => setView({ name: "list" })}
            className="rounded-lg border border-black/15 px-4 py-2 text-sm font-bold"
          >
            Kembali ke daftar
          </button>
        </div>
        <div className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
          <div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-black/60">
            <span>
              Status: <strong>{view.place.publicationStatus}</strong>
            </span>
            <Link
              className="rounded-lg bg-brand-ink px-4 py-2 text-sm font-bold text-white"
              href={`/producer/places/${view.place.id}/production`}
            >
              Kelola Dari Sini
            </Link>
          </div>
          <PlaceEditor id={view.place.id} onSaved={handleSaved} />
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Place milikmu" className="mt-8">
      <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Place milikmu</h2>
      <div className="mt-3 grid gap-2">
        {places.map((place) => (
          <button
            type="button"
            key={place.id}
            onClick={() => setView({ name: "edit", place })}
            className="flex items-center gap-4 rounded-2xl border border-black/10 bg-white p-4 text-left shadow-sm transition hover:shadow-md"
          >
            {place.coverImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={place.coverImageUrl} alt="" className="h-14 w-14 shrink-0 rounded-xl border border-black/10 object-cover" />
            ) : (
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-black/10 bg-brand-cream text-lg font-bold text-brand-accent">
                {place.name.slice(0, 1)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{place.name}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-black/60">
                <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[place.publicationStatus]}`} aria-hidden />
                {place.publicationStatus}
              </span>
            </span>
            <span aria-hidden className="text-black/30">›</span>
          </button>
        ))}
        {places.length === 0 && (
          <p className="text-sm text-black/60">
            Belum ada Place yang dapat dikelola.
            {showOnboardingHint && (
              <>
                {" "}Ikuti proses verifikasi untuk menjadi Producer — lihat{" "}
                <Link href="/producer/onboarding" className="font-bold text-brand-accent underline underline-offset-2">
                  Ajukan menjadi Producer
                </Link>.
              </>
            )}
          </p>
        )}
        {/* "+ Tambahkan Place baru" sits BELOW the roster (mockup, PO) and
            opens the add form IN PLACE — no second list page, no new route. */}
        <button
          type="button"
          onClick={() => setView({ name: "new" })}
          className="flex items-center gap-4 rounded-2xl border border-dashed border-black/20 bg-white p-4 text-left transition hover:bg-black/[0.02]"
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-brand-accent text-xl font-bold text-white" aria-hidden>
            +
          </span>
          <span>
            <span className="block font-semibold">Tambahkan Place baru</span>
            <span className="mt-0.5 block text-xs text-black/55">Tampilkan proses produksi di SINGGAH LOKAL.</span>
          </span>
        </button>
      </div>
    </section>
  );
}
