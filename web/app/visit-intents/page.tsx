import Link from "next/link";
import { redirect } from "next/navigation";
import SiteNav from "@/components/site-nav";
import VisitedLink from "@/components/visited-link";
import { EmptyState, PageHeader, PageShell, StatusBadge, btn, metaTextClass } from "@/components/ui/kit";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { visitIntentStatusLabel } from "@/lib/status-labels";
import { listUserVisitIntents, type UserVisitIntentRecord } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

// Session data is read per request — never cached across users.
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<VisitIntentStatus, "warning" | "positive" | "negative" | "accent" | "neutral"> = {
  pending: "warning",
  accepted: "positive",
  declined: "negative",
  requires_confirmation: "accent",
  cancelled: "neutral",
  expired: "neutral",
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
    <>
      <SiteNav />
      <PageShell>
        <PageHeader
          title="Kunjungan Saya"
          description="Niat berkunjungmu ke Tempat. Status diperbarui setelah Pengelola merespons."
        />

        {records.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Belum ada Kunjungan"
              description="Ajukan niat berkunjung dari halaman Kegiatan pada sebuah Tempat."
              action={
                <Link href="/" className={btn.primary}>
                  Jelajahi Tempat
                </Link>
              }
            />
          </div>
        ) : (
          <div className="mt-4 grid gap-2">
            {records.map(({ intent, place, experience }) => (
              <article key={intent.id} className="grid gap-2 rounded-xl border border-black/10 bg-white px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-accent">
                      {place.name} • {place.area}
                    </p>
                    <h2 className="mt-0.5 break-words text-sm font-semibold">{experience.title}</h2>
                  </div>
                  <StatusBadge tone={STATUS_TONE[intent.status]}>
                    {visitIntentStatusLabel(intent.status)}
                  </StatusBadge>
                </div>

                <p className={metaTextClass}>
                  {formatVisitIntentDate(intent.requestedDate)} · {intent.requestedStartTime}–{intent.requestedEndTime} · {intent.partySize} orang
                </p>

                {intent.optionalNote ? (
                  <p className={`border-t border-black/5 pt-2 text-black/60 ${metaTextClass}`}>Catatan: {intent.optionalNote}</p>
                ) : null}

                {intent.producerResponseNote ? (
                  <p className={`rounded-xl bg-[#fffaf0] px-3 py-2 text-black/70 ${metaTextClass}`}>
                    <span className="font-bold">Respons Pengelola:</span> {intent.producerResponseNote}
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <VisitedLink
                    href={`/places/${place.id}`}
                    className={btn.compact}
                    visitedClassName="border-brand-accent/35 bg-[#faf6ee]"
                  >
                    Kembali ke Tempat
                  </VisitedLink>
                  <VisitedLink
                    href={`/places/${place.id}/experiences/${experience.id}`}
                    className={btn.compact}
                    visitedClassName="border-brand-accent/35 bg-[#faf6ee]"
                  >
                    Lihat Kegiatan
                  </VisitedLink>
                </div>
              </article>
            ))}
          </div>
        )}
      </PageShell>
    </>
  );
}
