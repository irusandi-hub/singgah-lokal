"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Place } from "@/lib/places";
import type { CanonicalProducerVisitIntent } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

const statuses: VisitIntentStatus[] = ["pending", "accepted", "declined", "requires_confirmation", "cancelled", "expired"];

export default function Inbox() {
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
      if (response.ok) { setRecords(data); setError(""); }
      else setError(data.error ?? "Visit Intent tidak dapat dimuat");
      setLoading(false);
    });
  }, [placeId, status]);

  return <main className="min-h-screen bg-[#20231f] px-4 py-5 text-[#f7f5ef] sm:px-6"><div className="mx-auto max-w-4xl"><header className="flex items-start justify-between gap-4 border-b border-white/15 pb-5"><div><p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#d8ad6f]">Producer App</p><h1 className="mt-2 text-3xl font-black tracking-tight">Visit Intent Inbox</h1><p className="mt-2 max-w-md text-sm leading-6 text-white/65">Niat berkunjung untuk Place yang berada dalam kewenangan Producer.</p></div><Link className="rounded-full border border-white/20 px-3 py-2 text-xs font-bold text-white/80" href="/producer/places">Places</Link></header><section className="mt-6 grid gap-3 rounded-2xl border border-white/15 bg-white/10 p-5 sm:grid-cols-2" aria-label="Filter Visit Intent"><label className="grid gap-1 text-sm font-semibold">Place<select className="text-[#20231f]" value={placeId} onChange={(event) => setPlaceId(event.target.value)}><option value="">Semua Place</option>{places.map((place) => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label><label className="grid gap-1 text-sm font-semibold">Status<select className="text-[#20231f]" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Semua status</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label></section>{error ? <p className="mt-5 rounded-xl bg-red-950/60 p-4 text-sm text-red-100">{error}</p> : loading ? <p className="mt-6 text-sm text-white/65">Memuat inbox...</p> : <section className="mt-6 grid gap-3" aria-label="Daftar Visit Intent">{records.map(({ intent, place, experience }) => <Link className="rounded-2xl border border-white/15 bg-white/10 p-5 transition hover:bg-white/15" href={`/producer/visit-intents/${intent.id}`} key={intent.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#d8ad6f]">{place.name}</p><h2 className="mt-1 text-lg font-black">{experience.title}</h2></div><span className="rounded-full bg-[#d8ad6f] px-3 py-1 text-xs font-black text-[#20231f]">{intent.status}</span></div><div className="mt-4 grid gap-2 text-sm text-white/70 sm:grid-cols-2"><p>{intent.requestedDate} · {intent.requestedStartTime}-{intent.requestedEndTime}</p><p>{intent.partySize} peserta · {intent.timezone}</p></div>{intent.optionalNote && <p className="mt-3 border-t border-white/10 pt-3 text-sm text-white/60">Catatan: {intent.optionalNote}</p>}</Link>)}{records.length === 0 && <p className="rounded-xl bg-black/20 p-4 text-sm text-white/65">Tidak ada Visit Intent untuk filter ini.</p>}</section>}<p className="mt-6 text-xs leading-5 text-white/45">Visit Intent adalah niat berkunjung, bukan pembayaran atau konfirmasi reservasi.</p></div></main>;
}
