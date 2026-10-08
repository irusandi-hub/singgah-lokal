"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CanonicalProducerVisitIntent } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";
import { visitIntentStatusLabel } from "@/lib/status-labels";
import { formatPlaceDate, timezoneLabel } from "@/lib/display-format";
import {
  PageHeader,
  PageShell,
  Panel,
  Section,
  StatusBadge,
  StatusMessage,
  backLinkClass,
  btn,
  metaTextClass,
} from "@/components/ui/kit";

const responseStatuses: Extract<VisitIntentStatus, "accepted" | "declined" | "requires_confirmation">[] = ["accepted", "declined", "requires_confirmation"];

export default function VisitIntentDetail({ id }: { id: string }) {
  const [record, setRecord] = useState<CanonicalProducerVisitIntent | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("Memuat detail...");

  useEffect(() => {
    fetch(`/api/producer/visit-intents/${id}`).then(async (response) => {
      const data = await response.json();
      if (response.ok) { setRecord(data); setNote(data.intent.producerResponseNote ?? ""); setMessage(""); }
      else setMessage(data.error ?? "Kunjungan tidak dapat dimuat");
    });
  }, [id]);

  async function respond(status: Extract<VisitIntentStatus, "accepted" | "declined" | "requires_confirmation">) {
    setMessage("Menyimpan respons...");
    const response = await fetch(`/api/producer/visit-intents/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, producerResponseNote: note }) });
    const data = await response.json();
    if (response.ok) { setRecord(data); setMessage("Respons tersimpan"); }
    else setMessage(data.error ?? "Respons tidak dapat disimpan");
  }

  // One shell, one contextual way back, for BOTH the loading and the loaded
  // state — the page never grows a second back link.
  const back = (
    <Link className={backLinkClass} href="/producer/visit-intents">
      ← Kembali ke Permintaan Kunjungan
    </Link>
  );

  if (!record) {
    return (
      <PageShell width="narrow">
        <PageHeader back={back} title="Permintaan Kunjungan" />
        <p className={`mt-4 text-black/70 ${metaTextClass}`} role="status">{message}</p>
      </PageShell>
    );
  }

  const intent = record.intent;
  const place = record.place;
  const experience = record.experience;
  const canRespond = intent.status === "pending" || intent.status === "requires_confirmation";

  return (
    <PageShell width="narrow">
      <PageHeader
        back={back}
        eyebrow={place.name}
        title={experience.title}
        actions={<StatusBadge tone={intent.status === "accepted" ? "positive" : intent.status === "declined" ? "negative" : "accent"}>{visitIntentStatusLabel(intent.status)}</StatusBadge>}
      />

      <div className="mt-4 grid gap-4">
        <Panel>
          <dl className={`grid gap-3 sm:grid-cols-2 ${metaTextClass}`}>
            <div>
              <dt className="text-black/45">Tanggal</dt>
              <dd className="mt-0.5 text-sm font-bold text-brand-ink">{formatPlaceDate(intent.requestedDate)}</dd>
            </div>
            <div>
              <dt className="text-black/45">Waktu</dt>
              <dd className="mt-0.5 text-sm font-bold text-brand-ink">{intent.requestedStartTime}–{intent.requestedEndTime}</dd>
            </div>
            <div>
              <dt className="text-black/45">Jumlah peserta</dt>
              <dd className="mt-0.5 text-sm font-bold text-brand-ink">{intent.partySize} peserta</dd>
            </div>
            <div>
              <dt className="text-black/45">Timezone</dt>
              <dd className="mt-0.5 text-sm font-bold text-brand-ink">Waktu di {timezoneLabel(intent.timezone)}</dd>
            </div>
          </dl>
        </Panel>

        {intent.optionalNote ? (
          <Panel>
            <p className="text-sm font-semibold">Catatan Pengunjung</p>
            <p className={`mt-1 text-black/70 ${metaTextClass}`}>{intent.optionalNote}</p>
          </Panel>
        ) : null}

        <Section title="Catatan Pengelola">
          <Panel className="grid gap-3">
            <label className={`grid gap-1 font-semibold ${metaTextClass}`}>
              Catatan
              <textarea maxLength={1000} rows={4} value={note} onChange={(event) => setNote(event.target.value)} />
            </label>
            {canRespond ? (
              <div className="flex flex-wrap gap-2">
                {responseStatuses.map((status) => (
                  <button
                    className={status === "accepted" ? btn.primary : btn.compact}
                    type="button"
                    key={status}
                    onClick={() => respond(status)}
                  >
                    {status === "requires_confirmation" ? "Minta konfirmasi" : status === "accepted" ? "Terima" : "Tolak"}
                  </button>
                ))}
              </div>
            ) : null}
            {message ? <StatusMessage message={message} /> : null}
          </Panel>
        </Section>
      </div>
    </PageShell>
  );
}
