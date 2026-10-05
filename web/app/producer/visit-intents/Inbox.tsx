"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ProducerSubNav from "@/components/producer-sub-nav";
import { visitIntentStatusLabel } from "@/lib/status-labels";
import { formatPlaceDate, timezoneLabel } from "@/lib/display-format";
import type { Place } from "@/lib/places";
import type { CanonicalProducerVisitIntent } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

const statuses: VisitIntentStatus[] = ["pending", "accepted", "declined", "requires_confirmation", "cancelled", "expired"];

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

  return <main className="min-h-screen bg-brand-cream px-4 py-5 text-brand-ink sm:px-6"><div className="mx-auto max-w-4xl"><header className="flex flex-wrap items-start justify-between gap-4 border-b border-black/10 pb-5"><div><p className="text-[11px] font-bold uppercase tracking-[0.2em] text-brand-accent">Pengelola App</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Permintaan Kunjungan</h1><p className="mt-2 max-w-md text-sm leading-6 text-black/60">Lihat permintaan kunjungan dan berikan tanggapan.</p></div><Link className="rounded-full border border-black/15 bg-white px-3 py-2 text-xs font-bold text-black/70" href="/producer">← Dashboard Pengelola</Link></header><div className="mt-5"><ProducerSubNav active="/producer/visit-intents" /></div><section className="mt-6 grid gap-3 rounded-2xl border border-black/10 bg-white p-5 shadow-sm sm:grid-cols-2" aria-label="Filter Permintaan Kunjungan"><label className="grid gap-1 text-sm font-semibold">Tempat<select className="w-full" value={placeId} onChange={(event) => setPlaceId(event.target.value)}><option value="">Semua Tempat</option>{places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label><label className="grid gap-1 text-sm font-semibold">Status<select className="w-full" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Semua status</option>{statuses.map((item) => <option key={item} value={item}>{visitIntentStatusLabel(item)}</option>)}</select></label></section>{error ? <p className="mt-5 rounded-xl bg-red-50 p-4 text-sm text-red-800">{error}</p> : loading ? <p className="mt-6 text-sm text-black/60">Memuat permintaan...</p> : <section className="mt-6 grid gap-3" aria-label="Daftar Kunjungan">{records.map(({ intent, place, experience }) => <Link className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm transition hover:shadow-md" href={`/producer/visit-intents/${intent.id}`} key={intent.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-accent">{place.name}</p><h2 className="mt-1 text-lg font-semibold">{experience.title}</h2></div><span className="rounded-full bg-brand-accent px-3 py-1 text-xs font-semibold text-white">{visitIntentStatusLabel(intent.status)}</span></div><div className="mt-4 grid gap-2 text-sm text-black/60 sm:grid-cols-2"><p>{formatPlaceDate(intent.requestedDate)} · {intent.requestedStartTime}–{intent.requestedEndTime}</p><p>{intent.partySize} peserta · Waktu di {timezoneLabel(intent.timezone)}</p></div>{intent.optionalNote && <p className="mt-3 border-t border-black/10 pt-3 text-sm text-black/60">Catatan: {intent.optionalNote}</p>}</Link>)}{records.length === 0 && <p className="rounded-xl border border-black/10 bg-white p-4 text-sm text-black/65">Tidak ada Kunjungan untuk filter ini.</p>}</section>}</div></main>;
}
