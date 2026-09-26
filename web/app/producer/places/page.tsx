"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ProducerSubNav from "@/components/producer-sub-nav";
import PlaceForm, { PlaceEditor } from "./PlaceForm";
import type { Place } from "@/lib/places";

// Producer Place management is ONE canonical page (PO, 2026-09-26): the
// "Place saya" list, the "+ Tambah Place" action, and the add/edit forms all
// live here — no second dashboard route and no parallel form. The view is an
// explicit state machine:
// - "list": the Place roster (the default AND the only state a fresh load
//   shows — a refresh can never resurrect a previous new/edit session);
// - "new": the add form, which ALWAYS starts empty (PlaceForm's NEW branch);
// - "edit": the chosen Place, loaded from the canonical GET endpoint.
// Switching views replaces the whole state, so edit A can never leak into
// edit B (PlaceForm additionally remounts by key on every new/edit switch).
type ProducerPlacesView =
  | { name: "list" }
  | { name: "new" }
  | { name: "edit"; place: Place };

export default function ProducerPlacesPage() {
  const router = useRouter();
  const [view, setView] = useState<ProducerPlacesView>({ name: "list" });
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/producer/places").then(async (response) => {
      if (response.ok) { setPlaces(await response.json()); return; }
      // Unauthorized (not signed in / no Producer membership): route through
      // login instead of showing an error dead-end. The API itself remains
      // the authorization boundary — this is UX only.
      if (response.status === 401 || response.status === 403) {
        router.push("/auth?returnTo=%2Fproducer%2Fplaces");
        return;
      }
      setError((await response.json().catch(() => ({}))).error ?? "Places cannot be loaded");
    });
  }, [router]);

  // Save handler for BOTH modes. A successful NEW submit transitions
  // new → edit/manage for the saved record — the Place ID is preserved and
  // the roster gains the Place. An EDIT save keeps the editor open with the
  // fresh record and syncs the roster entry.
  function handleSaved(saved: Place) {
    setPlaces((current) =>
      current.some((place) => place.id === saved.id)
        ? current.map((place) => (place.id === saved.id ? saved : place))
        : [...current, saved],
    );
    setView({ name: "edit", place: saved });
  }

  return (
    <main className="min-h-screen bg-brand-cream px-5 py-8 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-3xl">
        <ProducerSubNav active="/producer/places" />
        <header className="mt-6 border-b border-black/10 pb-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Producer App</p>
            <h1 className="mt-2 text-3xl font-semibold">
              {view.name === "new" ? "Tambah Place" : view.name === "edit" ? "Edit Place" : "Place saya"}
            </h1>
          </div>
          {view.name !== "list" && (
            <button
              type="button"
              onClick={() => setView({ name: "list" })}
              className="mt-4 rounded-lg border border-black/15 px-4 py-2 text-sm font-bold"
            >
              Kembali ke daftar
            </button>
          )}
        </header>

        {error ? (
          <p className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</p>
        ) : view.name === "list" ? (
          <div className="mt-6 grid gap-3">
            {places.map((place) => (
              <button
                type="button"
                key={place.id}
                onClick={() => setView({ name: "edit", place })}
                className="rounded-xl border border-black/10 bg-white p-5 text-left"
              >
                <div className="flex items-center justify-between gap-4">
                  <h2 className="font-semibold">{place.name}</h2>
                  <span className="text-xs font-bold uppercase text-brand-accent">{place.publicationStatus}</span>
                </div>
                <p className="mt-2 text-sm text-black/60">{place.area} · {place.category}</p>
              </button>
            ))}
            {places.length === 0 && (
              <p className="text-sm text-black/60">Belum ada Place yang dapat dikelola.</p>
            )}
            {/* "+ Tambah Place" sits BELOW the roster/empty state as an
                in-page action (PO, 2026-09-26) — never in the header and never
                a second route; pressing it swaps this page to the add form. */}
            <button
              type="button"
              onClick={() => setView({ name: "new" })}
              className="justify-self-start rounded-lg bg-brand-ink px-4 py-2 text-sm font-bold text-white"
            >
              + Tambah Place
            </button>
          </div>
        ) : view.name === "new" ? (
          <section className="mt-6 rounded-xl border border-black/10 bg-white p-5">
            <p className="mb-4 text-sm text-black/60">Place baru disimpan sebagai draft sampai siap dipublikasikan.</p>
            <PlaceForm onSaved={handleSaved} />
          </section>
        ) : (
          <section className="mt-6 rounded-xl border border-black/10 bg-white p-5">
            <div className="mb-5 flex flex-wrap gap-3">
              <Link
                className="rounded-lg bg-brand-ink px-4 py-2 text-sm font-bold text-white"
                href={`/producer/places/${view.place.id}/production`}
              >
                Kelola Dari Sini
              </Link>
              <Link
                className="rounded-lg border border-black/15 px-4 py-2 text-sm font-bold"
                href={`/producer/places/${view.place.id}/experiences`}
              >
                Kelola Experience
              </Link>
            </div>
            <PlaceEditor id={view.place.id} onSaved={handleSaved} />
          </section>
        )}
      </div>
    </main>
  );
}
