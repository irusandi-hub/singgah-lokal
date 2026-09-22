import Link from "next/link";
import { redirect } from "next/navigation";
import SiteNav from "@/components/site-nav";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { listUserVisitIntents, type UserVisitIntentRecord } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

// Session data is read per request — never cached across users.
export const dynamic = "force-dynamic";

const statusStyles: Record<VisitIntentStatus, string> = {
  pending: "bg-[#d8ad6f]/40 text-[#5a431f]",
  accepted: "bg-green-700/15 text-green-800",
  declined: "bg-red-900/10 text-red-800",
  requires_confirmation: "bg-blue-900/10 text-blue-800",
  cancelled: "bg-black/10 text-black/60",
  expired: "bg-black/10 text-black/60",
};

function formatVisitIntentDate(date: string): string {
  // requested_date is a plain calendar date in the Place timezone; format the
  // date parts as-is (UTC) so the label never shifts to another day.
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

export default async function VisitIntentsPage() {
  let records: UserVisitIntentRecord[];

  try {
    const actor = await requireAuthenticatedActor(new Request("http://localhost/visit-intents"));
    records = await listUserVisitIntents(actor.userId);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      redirect("/auth?returnTo=%2Fvisit-intents");
    }
    throw error;
  }

  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#20231f]">
      <SiteNav />

      <section className="mx-auto max-w-4xl px-5 pb-12 pt-6">
        <h1 className="text-2xl font-black tracking-tight">Visit Intent Saya</h1>
        <p className="mt-2 text-sm text-black/55">
          Niat berkunjungmu ke Place. Status diperbarui setelah Producer merespons. Ini bukan pembayaran atau konfirmasi reservasi.
        </p>

        {records.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-black/10 bg-white p-8 text-center">
            <p className="text-sm font-bold">Belum ada Visit Intent</p>
            <p className="mt-1 text-xs text-black/55">
              Ajukan niat berkunjung dari halaman Experience pada sebuah Place.
            </p>
            <Link href="/" className="mt-4 inline-block rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white">
              Jelajahi Tempat
            </Link>
          </div>
        ) : (
          <div className="mt-6 grid gap-3">
            {records.map(({ intent, place, experience }) => (
              <article key={intent.id} className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#7b5b38]">
                      {place.name} • {place.area}
                    </p>
                    <h2 className="mt-1 text-lg font-black">{experience.title}</h2>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-black ${statusStyles[intent.status] ?? statusStyles.expired}`}>
                    {intent.status}
                  </span>
                </div>

                <dl className="mt-4 grid gap-2 text-sm text-black/70 sm:grid-cols-2">
                  <div>
                    <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Tanggal</dt>
                    <dd>{formatVisitIntentDate(intent.requestedDate)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Waktu ({intent.timezone})</dt>
                    <dd>
                      {intent.requestedStartTime}–{intent.requestedEndTime}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Jumlah orang</dt>
                    <dd>{intent.partySize} orang</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-bold uppercase tracking-wide text-black/40">Referensi</dt>
                    <dd className="font-mono text-xs">{intent.id}</dd>
                  </div>
                </dl>

                {intent.optionalNote && (
                  <p className="mt-3 border-t border-black/5 pt-3 text-sm text-black/60">Catatan: {intent.optionalNote}</p>
                )}

                {intent.producerResponseNote && (
                  <p className="mt-3 rounded-xl bg-[#fffaf0] p-3 text-sm text-black/70">
                    <span className="font-bold">Respons Producer:</span> {intent.producerResponseNote}
                  </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link
                    href={`/places/${place.id}`}
                    className="rounded-full bg-[#20231f] px-4 py-2 text-xs font-bold text-white"
                  >
                    Kembali ke Tempat
                  </Link>
                  <Link
                    href={`/places/${place.id}/experiences/${experience.id}`}
                    className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-bold text-black/70"
                  >
                    Lihat Experience
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
