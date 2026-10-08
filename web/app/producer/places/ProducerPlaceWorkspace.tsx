"use client";

import Link from "next/link";
import { useState } from "react";
import ProducerSubNav from "@/components/producer-sub-nav";
import { publicationStatusLabel } from "@/lib/status-labels";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  StatusBadge,
  backLinkClass,
} from "@/components/ui/kit";
import PlaceForm from "./PlaceForm";
import PlaceClaimPanel from "./PlaceClaimPanel";
import PlaceWorkspace from "./[placeId]/PlaceWorkspace";
import type { Place } from "@/lib/places";

/**
 * PLACE MILIKMU (Tempat yang Kamu Kelola) — the Place working surface of the
 * Producer dashboard.
 *
 * This component ALSO owns the dashboard's page chrome: the single PageShell,
 * the single PageHeader (its title/back change per state) and the single
 * contextual back link. That is deliberate (UI/perf pass 2026-10-08): when the
 * in-place editor rendered its own shell inside a shell wrapped by the page,
 * one screen had two nested shells and two headers. Each state below now
 * returns exactly ONE shell with ONE context and ONE back.
 *
 * ONE navigation layer, ONE work area:
 * - "list": the global Producer menu (this is the Producer area root, so the
 *   Producer's own functions stay reachable) + the COMPACT roster of Places I
 *   manage;
 * - "new": the add form, always empty (PlaceForm's NEW branch);
 * - "claim": "Ajukan Pengelolaan Tempat" — asking to manage an EXISTING
 *   unowned Place (PlaceClaimPanel). It never looks like "add Place": it files
 *   a claim and grants nothing until an Admin approves it;
 * - "edit": the chosen Place, rendered by the shared PlaceWorkspace.
 *
 * The in-place editor IS the Place workspace, so the global menu is not
 * rendered there (a Place has exactly one navigation layer — its own items) and
 * the workspace's single "← Pengelola" escape returns to this roster. The
 * roster carries each Place's status exactly once. No second status block, no
 * second list page, no duplicate "Kelola Proses" button.
 */
type ProducerPlaceWorkspaceView =
  | { name: "list" }
  | { name: "new" }
  | { name: "claim" }
  | { name: "edit"; place: Place };

const STATUS_TONE: Record<Place["publicationStatus"], "positive" | "warning" | "neutral"> = {
  published: "positive",
  draft: "warning",
  paused: "warning",
  archived: "neutral",
};

export default function ProducerPlaceWorkspace({ initialPlaces, showOnboardingHint = false }: { initialPlaces: Place[]; showOnboardingHint?: boolean }) {
  const [view, setView] = useState<ProducerPlaceWorkspaceView>({ name: "list" });
  const [places, setPlaces] = useState<Place[]>(initialPlaces);

  // Save handler for BOTH modes. A successful NEW submit upserts the roster
  // and flips new → edit with the saved record — the Place ID is preserved,
  // so Media/Proses are usable immediately.
  function handleSaved(saved: Place) {
    setPlaces((current) =>
      current.some((place) => place.id === saved.id)
        ? current.map((place) => (place.id === saved.id ? saved : place))
        : [...current, saved],
    );
    setView({ name: "edit", place: saved });
  }

  if (view.name === "claim") {
    // PlaceClaimPanel is self-contained: it owns the ONE heading and the ONE
    // "Kembali ke Tempat" action of this state, so it is only wrapped in the
    // single shell — never in a second header.
    return (
      <PageShell>
        <PlaceClaimPanel onBack={() => setView({ name: "list" })} />
      </PageShell>
    );
  }

  if (view.name === "new") {
    return (
      <PageShell>
        <PageHeader
          back={
            <button type="button" onClick={() => setView({ name: "list" })} className={backLinkClass}>
              ← Kembali ke Tempat
            </button>
          }
          title="Tambah Tempat"
          description="Lengkapi informasi Tempat. Setelah disimpan, kamu dapat menambahkan foto, Kegiatan, dan mengelola Tempat."
        />

        <div className="mt-4">
          <PlaceForm onSaved={handleSaved} />
        </div>
      </PageShell>
    );
  }

  if (view.name === "edit") {
    // PlaceWorkspace brings its OWN single shell + header (the Place name as
    // the context) — so the dashboard must not wrap it in a second one.
    return (
      <PlaceWorkspace
        placeId={view.place.id}
        initialPlace={view.place}
        onPlaceSaved={handleSaved}
        onBack={() => setView({ name: "list" })}
      />
    );
  }

  return (
    <PageShell>
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            Kembali ke Beranda
          </Link>
        }
        title="Dashboard Pengelola"
        description="Kelola Tempat dan kegiatanmu, tanggapi Permintaan Kunjungan, dan kelola Live."
      />

      <div className="mt-5 grid gap-4">
        {/* The global Producer menu lives at the area root ONLY. It is never
            rendered inside a Place workspace, so no screen shows two navigation
            systems at once. */}
        <ProducerSubNav active="/producer" />

        <Section title="Tempat yang Kamu Kelola">
          {places.length === 0 && (
            <EmptyState
              title="Belum ada Tempat yang dapat dikelola"
              description={
                showOnboardingHint ? (
                  <>
                    Ikuti proses verifikasi untuk menjadi Pengelola — lihat{" "}
                    <Link href="/producer/onboarding" className="font-bold text-brand-accent underline underline-offset-2">
                      Ajukan menjadi Pengelola
                    </Link>
                    .
                  </>
                ) : undefined
              }
            />
          )}

          <div className="grid gap-2">
          {places.map((place) => (
            <button
              type="button"
              key={place.id}
              onClick={() => setView({ name: "edit", place })}
              className="flex w-full items-center gap-3 rounded-xl border border-black/10 bg-white px-3 py-2.5 text-left transition hover:bg-black/[0.02]"
            >
              {place.coverImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={place.coverImageUrl}
                  alt=""
                  width={40}
                  height={40}
                  loading="lazy"
                  decoding="async"
                  className="h-10 w-10 shrink-0 rounded-lg border border-black/10 object-cover"
                />
              ) : (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-black/10 bg-brand-cream text-sm font-bold text-brand-accent">
                  {place.name.slice(0, 1)}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-semibold">{place.name}</span>
                <span className="mt-1 block">
                  <StatusBadge tone={STATUS_TONE[place.publicationStatus]}>
                    {publicationStatusLabel(place.publicationStatus)}
                  </StatusBadge>
                </span>
              </span>
              <span aria-hidden className="text-black/30">›</span>
            </button>
          ))}

          {/* The TWO self-service entries sit BELOW the roster in one compact
              action block: "Tambahkan Tempat" creates a new Place in place, and
              "Ajukan Pengelolaan Tempat" files a claim for an EXISTING unowned
              Place — never a second way to create one. */}
          <button
            type="button"
            onClick={() => setView({ name: "new" })}
            className="mt-1 flex w-full items-center gap-3 rounded-xl border border-dashed border-black/20 bg-white px-3 py-2.5 text-left transition hover:bg-black/[0.02]"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-accent text-lg font-bold text-white" aria-hidden>
              +
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Tambahkan Tempat</span>
              <span className="mt-0.5 block text-xs text-black/55">Bagikan kegiatan dan proses yang berlangsung di Tempatmu.</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setView({ name: "claim" })}
            className="flex w-full items-center gap-3 rounded-xl border border-dashed border-black/20 bg-white px-3 py-2.5 text-left transition hover:bg-black/[0.02]"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-black/15 text-base font-bold text-black/50" aria-hidden>
              ⚑
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">Ajukan Pengelolaan Tempat</span>
              <span className="mt-0.5 block text-xs text-black/55">
                Ajukan akses untuk mengelola Tempat yang sudah ada di SINGGAH LOKAL.
              </span>
            </span>
          </button>
          </div>
        </Section>
      </div>
    </PageShell>
  );
}

