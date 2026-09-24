"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { VisitIntent } from "@/lib/visit-intents";
import type { Experience } from "@/lib/experiences";
import type { Place } from "@/lib/places";
import { getVisitIntentErrorMessage } from "@/lib/visit-intent-error";

type VisitIntentFormProps = {
  place: Place;
  experience: Experience;
};

function getToday(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts();
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default function VisitIntentForm({ place, experience }: VisitIntentFormProps) {
  const router = useRouter();
  const [requestedDate, setRequestedDate] = useState(getToday(place.timezone));
  const [requestedStartTime, setRequestedStartTime] = useState("09:00");
  const [requestedEndTime, setRequestedEndTime] = useState("10:00");
  const [partySize, setPartySize] = useState(experience.minPartySize);
  const [optionalNote, setOptionalNote] = useState("");
  const [intent, setIntent] = useState<VisitIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      idempotencyKeyRef.current ??= crypto.randomUUID();
      const response = await fetch("/api/visit-intents", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKeyRef.current },
        body: JSON.stringify({ placeId: place.id, experienceId: experience.id, requestedDate, requestedStartTime, requestedEndTime, partySize, optionalNote }),
      });
      const result = await response.json();
      if (!response.ok) {
        // Unauthenticated visitor: route to the auth page and come straight
        // back to THIS Experience after signing in (existing backend auth).
        if (response.status === 401 || result?.error === "authentication_required") {
          const currentExperiencePath = `/places/${place.id}/experiences/${experience.id}`;
          router.push(`/auth?returnTo=${encodeURIComponent(currentExperiencePath)}`);
          return;
        }
        setError(getVisitIntentErrorMessage(response.status, result.error));
        return;
      }
      setIntent(result as VisitIntent);
    } catch {
      setIntent(null);
      setError("Visit Intent belum dapat dikirim. Silakan coba lagi.");
    }
  }

  if (intent) {
    return (
      <div className="mt-8 rounded-2xl border border-brand-accent/25 bg-[#fffaf0] p-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Visit Intent dibuat</p>
        <h2 className="mt-2 text-xl font-semibold">Niat berkunjung siap diteruskan ke Producer.</h2>

        {/* Real record fields from the persisted server response. */}
        <dl className="mt-4 grid gap-2 text-sm text-black/75 sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Place</dt>
            <dd>{place.name}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Experience</dt>
            <dd>{experience.title}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Tanggal ({intent.timezone})</dt>
            <dd>{intent.requestedDate}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Waktu</dt>
            <dd>
              {intent.requestedStartTime}–{intent.requestedEndTime}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Jumlah orang</dt>
            <dd>{intent.partySize} orang</dd>
          </div>
          <div>
            <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Status</dt>
            <dd className="font-bold">{intent.status}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Referensi</dt>
            <dd className="font-mono text-xs">{intent.id}</dd>
          </div>
        </dl>

        <p className="mt-3 text-xs leading-5 text-black/55">
          Ini bukan konfirmasi reservasi. Waktu mengikuti {intent.timezone} dan masih perlu respons Producer.
        </p>

        {/* Next steps: inspect the saved record, or go back to the Place. */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => router.push("/visit-intents")}
            className="w-full rounded-2xl bg-brand-primary py-3.5 text-sm font-bold text-white"
          >
            Lihat Visit Intent Saya
          </button>
          <button
            type="button"
            onClick={() => router.push(`/places/${place.id}`)}
            className="w-full rounded-2xl border border-black/10 bg-white py-3.5 text-sm font-bold text-black/70"
          >
            Kembali ke Tempat
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="mt-8 rounded-2xl border border-brand-accent/25 bg-[#fffaf0] p-5" onSubmit={handleSubmit}>
      <h2 className="text-xl font-semibold">SINGGAH DI SINI</h2>
      <p className="mt-2 text-sm leading-6 text-black/65">Ajukan niat berkunjung kepada Producer. Belum ada pembayaran atau kepastian reservasi.</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-semibold">Tanggal ({place.timezone})
          <input className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal" type="date" min={getToday(place.timezone)} value={requestedDate} onChange={(event) => setRequestedDate(event.target.value)} required />
        </label>
        <label className="text-sm font-semibold">Jumlah orang
          <input className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal" type="number" min={experience.minPartySize} max={experience.maxPartySize} value={partySize} onChange={(event) => setPartySize(Number(event.target.value))} required />
        </label>
        <label className="text-sm font-semibold">Mulai
          <input className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal" type="time" value={requestedStartTime} onChange={(event) => setRequestedStartTime(event.target.value)} required />
        </label>
        <label className="text-sm font-semibold">Selesai
          <input className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal" type="time" value={requestedEndTime} onChange={(event) => setRequestedEndTime(event.target.value)} required />
        </label>
      </div>
      <label className="mt-4 block text-sm font-semibold">Catatan opsional
        <textarea className="mt-1 min-h-24 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal" maxLength={500} value={optionalNote} onChange={(event) => setOptionalNote(event.target.value)} />
      </label>
      {error ? <p className="mt-3 text-sm font-semibold text-red-700" role="alert">{error}</p> : null}
      <button className="mt-5 w-full rounded-2xl bg-brand-primary py-4 text-sm font-bold text-white" type="submit">Kirim Visit Intent</button>
    </form>
  );
}