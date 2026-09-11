"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CanonicalProducerVisitIntent } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

const responseStatuses: Extract<VisitIntentStatus, "accepted" | "declined" | "requires_confirmation">[] = ["accepted", "declined", "requires_confirmation"];

export default function VisitIntentDetail({ id }: { id: string }) {
  const [record, setRecord] = useState<CanonicalProducerVisitIntent | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("Memuat detail...");

  useEffect(() => {
    fetch(`/api/producer/visit-intents/${id}`).then(async (response) => {
      const data = await response.json();
      if (response.ok) { setRecord(data); setNote(data.intent.producerResponseNote ?? ""); setMessage(""); }
      else setMessage(data.error ?? "Visit Intent tidak dapat dimuat");
    });
  }, [id]);

  async function respond(status: Extract<VisitIntentStatus, "accepted" | "declined" | "requires_confirmation">) {
    setMessage("Menyimpan respons...");
    const response = await fetch(`/api/producer/visit-intents/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, producerResponseNote: note }) });
    const data = await response.json();
    if (response.ok) { setRecord(data); setMessage("Respons tersimpan"); }
    else setMessage(data.error ?? "Respons tidak dapat disimpan");
  }

  if (!record) return <main className="min-h-screen bg-[#20231f] px-5 py-8 text-[#f7f5ef]"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-[#d8ad6f]" href="/producer/visit-intents">← Kembali ke inbox</Link><p className="mt-8 rounded-xl bg-white/10 p-4 text-sm text-white/70">{message}</p></div></main>;
  const { intent, place, experience } = record;
  const canRespond = intent.status === "pending" || intent.status === "requires_confirmation";
  return <main className="min-h-screen bg-[#20231f] px-5 py-8 text-[#f7f5ef]"><div className="mx-auto max-w-2xl"><Link className="text-sm font-bold text-[#d8ad6f]" href="/producer/visit-intents">← Kembali ke inbox</Link><header className="mt-6 border-b border-white/15 pb-5"><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#d8ad6f]">{place.name}</p><h1 className="mt-2 text-3xl font-black">{experience.title}</h1><span className="mt-3 inline-block rounded-full bg-[#d8ad6f] px-3 py-1 text-xs font-black text-[#20231f]">{intent.status}</span></header><dl className="mt-6 grid gap-4 rounded-2xl border border-white/15 bg-white/10 p-5 text-sm sm:grid-cols-2"><div><dt className="text-white/45">Tanggal</dt><dd className="mt-1 font-bold">{intent.requestedDate}</dd></div><div><dt className="text-white/45">Waktu</dt><dd className="mt-1 font-bold">{intent.requestedStartTime}-{intent.requestedEndTime}</dd></div><div><dt className="text-white/45">Party size</dt><dd className="mt-1 font-bold">{intent.partySize} peserta</dd></div><div><dt className="text-white/45">Timezone</dt><dd className="mt-1 font-bold">{intent.timezone}</dd></div></dl>{intent.optionalNote && <section className="mt-4 rounded-2xl border border-white/15 bg-white/10 p-5"><h2 className="font-black">Catatan User</h2><p className="mt-2 text-sm leading-6 text-white/70">{intent.optionalNote}</p></section>}<section className="mt-4 rounded-2xl border border-white/15 bg-white/10 p-5"><label className="grid gap-2 text-sm font-semibold">Catatan Producer<textarea maxLength={1000} rows={4} value={note} onChange={(event) => setNote(event.target.value)} /></label>{canRespond && <div className="mt-4 flex flex-wrap gap-2">{responseStatuses.map((status) => <button className="rounded-lg bg-[#d8ad6f] px-3 py-2 text-sm font-black text-[#20231f]" type="button" key={status} onClick={() => respond(status)}>{status === "requires_confirmation" ? "Minta konfirmasi" : status === "accepted" ? "Terima" : "Tolak"}</button>)}</div>}<p className="mt-3 text-sm text-white/60" role="status">{message}</p></section></div></main>;
}
