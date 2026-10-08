"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ProducerSubNav from "@/components/producer-sub-nav";
import { visitIntentStatusLabel } from "@/lib/status-labels";
import { formatPlaceDate, timezoneLabel } from "@/lib/display-format";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageShell,
  StatusBadge,
  backLinkClass,
  eyebrowClass,
  metaTextClass,
} from "@/components/ui/kit";
import type { Place } from "@/lib/places";
import type { CanonicalProducerVisitIntent } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

const statuses: VisitIntentStatus[] = ["pending", "accepted", "declined", "requires_confirmation", "cancelled", "expired"];

const STATUS_TONE: Record<VisitIntentStatus, "warning" | "positive" | "negative" | "accent" | "neutral"> = {
  pending: "warning",
  accepted: "positive",
  declined: "negative",
  requires_confirmation: "accent",
  cancelled: "neutral",
  expired: "neutral",
};

export default function Inbox() {
  const router = useRouter();
  const [places, setPlaces] = useState<Place[]>([]);
  const [records, setRecords] = useState<CanonicalProducerVisitIntent[]>([]);
  const [placeId, setPlaceId] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/producer/places").then(async (response) => {
      if (response.ok) setPlaces(await response.json());
    });
  }, []);

  useEffect(() => {
    const query = new URLSearchParams();
    if (placeId) query.set("placeId", placeId);
    if (status) query.set("status", status);
    fetch(`/api/producer/visit-intents${query.size ? `?${query}` : ""}`).then(async (response) => {
      const data = await response.json();
      // Session expired mid-session: route through login and come back here.
      if (response.status === 401) {
        router.push("/auth?returnTo=%2Fproducer%2Fvisit-intents");
        return;
      }
      if (response.ok) { setRecords(data); setError(""); }
      else setError(data.error ?? "Kunjungan tidak dapat dimuat");
      setLoading(false);
    });
  }, [placeId, status, router]);

  return (
    <PageShell>
      <PageHeader
        back={
          <Link className={backLinkClass} href="/producer">
            ← Dashboard Pengelola
          </Link>
        }
        title="Permintaan Kunjungan"
        description="Lihat permintaan kunjungan dan berikan tanggapan."
      />

      <div className="mt-4">
        <ProducerSubNav active="/producer/visit-intents" />
      </div>

      <section className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Filter Permintaan Kunjungan">
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Tempat
          <select className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-sm text-brand-ink" value={placeId} onChange={(event) => setPlaceId(event.target.value)}>
            <option value="">Semua Tempat</option>
            {places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-black/60">
          Status
          <select className="w-full rounded-xl border border-black/12 bg-white px-3 py-2 text-sm text-brand-ink" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Semua status</option>
            {statuses.map((item) => <option key={item} value={item}>{visitIntentStatusLabel(item)}</option>)}
          </select>
        </label>
      </section>

      <div className="mt-4">
        {error ? (
          <ErrorState message={error} />
        ) : loading ? (
          <p className={`text-black/60 ${metaTextClass}`} role="status">Memuat permintaan...</p>
        ) : records.length === 0 ? (
          <EmptyState title="Tidak ada Kunjungan untuk filter ini." />
        ) : (
          <section className="grid gap-2" aria-label="Daftar Kunjungan">
            {records.map(({ intent, place, experience }) => (
              <Link
                className="grid gap-2 rounded-xl border border-black/10 bg-white px-3 py-3 transition hover:bg-black/[0.02]"
                href={`/producer/visit-intents/${intent.id}`}
                key={intent.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className={`${eyebrowClass} text-brand-accent`}>{place.name}</p>
                    <p className="mt-0.5 break-words text-sm font-semibold">{experience.title}</p>
                  </div>
                  <StatusBadge tone={STATUS_TONE[intent.status]}>{visitIntentStatusLabel(intent.status)}</StatusBadge>
                </div>
                <p className={metaTextClass}>
                  {formatPlaceDate(intent.requestedDate)} · {intent.requestedStartTime}–{intent.requestedEndTime} · {intent.partySize} peserta · Waktu di {timezoneLabel(intent.timezone)}
                </p>
                {intent.optionalNote ? (
                  <p className={`border-t border-black/5 pt-2 text-black/60 ${metaTextClass}`}>Catatan: {intent.optionalNote}</p>
                ) : null}
              </Link>
            ))}
          </section>
        )}
      </div>
    </PageShell>
  );
}
