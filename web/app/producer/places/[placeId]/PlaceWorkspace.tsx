"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Place } from "@/lib/places";
import { publicationStatusLabel } from "@/lib/status-labels";
import {
  ErrorState,
  PageHeader,
  PageShell,
  StatusBadge,
  backLinkClass,
  btn,
  metaTextClass,
  tabActiveClass,
  tabIdleClass,
  tabItemClass,
  tabListClass,
} from "@/components/ui/kit";
import PlaceForm, { PlaceMediaPanel } from "../PlaceForm";
import ExperiencesPanel from "./experiences/ExperiencesPanel";
import ProductionStoryPanel from "./production/ProductionStoryPanel";

/**
 * PLACE WORKSPACE — ONE page, ONE context, ONE navigation layer, ONE work area.
 *
 * The Place name is the context (it is the page title). The only ways out are
 * the ONE contextual back link ("← Pengelola" → the Producer dashboard) and the
 * FOUR workspace items of THIS Place:
 *
 *   Informasi | Kegiatan | Media | Kelola Proses
 *
 * The Producer global menu is deliberately NOT rendered here: inside a Place the
 * Producer works on that Place, so a second navigation system (Dashboard /
 * Tempat / Permintaan Kunjungan / Live) must not share the viewport with the
 * Place items. The global functions stay reachable from the Producer area root.
 *
 * "Kelola Proses" (the Producer name for the "Dari Sini" production story) is
 * the fourth workspace item, not a large call-to-action above the navigation,
 * and it carries no navigation layer of its own — it is one workspace state of
 * this Place, exactly like Informasi, Kegiatan and Media.
 *
 * Publication status appears exactly ONCE, as a compact status/action row
 * directly under the Place name. Every behaviour behind these controls (status
 * transitions, uploads, generation, review, publish) is the existing server API.
 */
export type PlaceWorkspaceTab = "detail" | "experience" | "media" | "production";

const PLACE_TABS: { key: PlaceWorkspaceTab; label: string }[] = [
  { key: "detail", label: "Informasi" },
  { key: "experience", label: "Kegiatan" },
  { key: "media", label: "Media" },
  { key: "production", label: "Kelola Proses" },
];

const STATUS_TONE: Record<Place["publicationStatus"], "positive" | "warning" | "neutral"> = {
  published: "positive",
  draft: "warning",
  paused: "warning",
  archived: "neutral",
};

export default function PlaceWorkspace({
  placeId,
  initialPlace = null,
  initialTab = "detail",
  onPlaceSaved,
  onBack,
}: {
  placeId: string;
  initialPlace?: Place | null;
  initialTab?: PlaceWorkspaceTab;
  onPlaceSaved?: (place: Place) => void;
  /** The dashboard's in-place editor hands back to its own roster instead of a route. */
  onBack?: () => void;
}) {
  const [place, setPlace] = useState<Place | null>(initialPlace);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<PlaceWorkspaceTab>(initialTab);

  useEffect(() => {
    if (initialPlace) return;
    let cancelled = false;
    fetch(`/api/producer/places/${placeId}`)
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) return;
        if (response.ok) setPlace(data);
        else setError(data.error ?? "Tempat tidak dapat dimuat");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [placeId, initialPlace]);

  function applyPlace(saved: Place) {
    setPlace(saved);
    onPlaceSaved?.(saved);
  }

  async function changeStatus(publicationStatus: Place["publicationStatus"]) {
    const response = await fetch(`/api/producer/places/${placeId}/publication`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicationStatus }),
    });
    const data = await response.json();
    if (response.ok) applyPlace(data);
    else setError(data.error ?? "Status tidak dapat diubah");
  }

  const back = onBack ? (
    <button type="button" onClick={onBack} className={backLinkClass}>
      ← Pengelola
    </button>
  ) : (
    <Link className={backLinkClass} href="/producer">
      ← Pengelola
    </Link>
  );

  return (
    <PageShell>
      <PageHeader back={back} title={place?.name ?? "Tempat"} />

      {error ? (
        <div className="mt-4">
          <ErrorState message={error} />
        </div>
      ) : null}

      {place ? (
        <>
          {/* ONE compact status/action row — the Place's publication status
              appears here and nowhere else in the workspace. */}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-black/10 pb-3">
            <StatusBadge tone={STATUS_TONE[place.publicationStatus]}>{publicationStatusLabel(place.publicationStatus)}</StatusBadge>
            <button
              className={`ml-auto ${btn.compact}`}
              type="button"
              onClick={() => changeStatus(place.publicationStatus === "published" ? "paused" : "published")}
            >
              {place.publicationStatus === "published" ? "Jeda" : "Tayangkan"}
            </button>
            <button className={btn.compact} type="button" onClick={() => changeStatus("archived")}>
              Arsipkan
            </button>
          </div>

          {/* ONE navigation layer: the four workspace items of this Place. */}
          <div className={`mt-3 ${tabListClass}`} role="tablist" aria-label="Bagian Tempat">
            {PLACE_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`${tabItemClass} ${tab === key ? tabActiveClass : tabIdleClass}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4 grid min-w-0 gap-4">
            {tab === "detail" && <PlaceForm place={place} onSaved={applyPlace} />}
            {tab === "experience" && <ExperiencesPanel placeId={place.id} />}
            {tab === "media" && <PlaceMediaPanel place={place} />}
            {tab === "production" && <ProductionStoryPanel placeId={place.id} />}
          </div>
        </>
      ) : !error ? (
        <p className={`mt-4 text-black/60 ${metaTextClass}`} role="status">Memuat Tempat...</p>
      ) : null}
    </PageShell>
  );
}
