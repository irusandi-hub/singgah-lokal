"use client";

import { FormEvent, useState } from "react";
import { createVisitIntent, type VisitIntent } from "@/lib/visit-intents";
import type { Experience } from "@/lib/experiences";
import type { Place } from "@/lib/places";

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
  const [requestedDate, setRequestedDate] = useState(getToday(place.timezone));
  const [requestedStartTime, setRequestedStartTime] = useState("09:00");
  const [requestedEndTime, setRequestedEndTime] = useState("10:00");
  const [partySize, setPartySize] = useState(experience.minPartySize);
  const [optionalNote, setOptionalNote] = useState("");
  const [intent, setIntent] = useState<VisitIntent | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    try {
      setIntent(
        createVisitIntent(
          {
            userId: "local-demo-user",
            placeId: place.id,
            experienceId: experience.id,
            requestedDate,
            requestedStartTime,
            requestedEndTime,
            partySize,
            optionalNote,
          },
          place,
          experience,
        ),
      );
    } catch (submissionError) {
      setIntent(null);
      setError(submissionError instanceof Error ? submissionError.message : "Visit Intent belum dapat dikirim.");
    }
  }

  if (intent) {
    return (
      <div className="mt-8 rounded-2xl border border-[#7b5b38]/25 bg-[#fffaf0] p-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Visit Intent dibuat</p>
        <h2 className="mt-2 text-xl font-black">Niat berkunjung siap diteruskan ke Producer.</h2>
        <p className="mt-3 text-sm leading-6 text-black/70">
          Status: <strong>pending</strong>. Ini bukan konfirmasi reservasi. Waktu mengikuti {intent.timezone} dan masih perlu respons Producer. Pengiriman server akan tersedia saat endpoint Visit Intent ditambahkan.
        </p>
      </div>
    );
  }

  return (
    <form className="mt-8 rounded-2xl border border-[#7b5b38]/25 bg-[#fffaf0] p-5" onSubmit={handleSubmit}>
      <h2 className="text-xl font-black">SINGGAH DI SINI</h2>
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
      <button className="mt-5 w-full rounded-2xl bg-[#20231f] py-4 text-sm font-bold text-white" type="submit">Kirim Visit Intent</button>
    </form>
  );
}