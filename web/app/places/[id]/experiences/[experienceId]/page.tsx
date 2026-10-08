import SiteNav from "@/components/site-nav";
import MarkVisited from "@/components/mark-visited";
import VisitedLink from "@/components/visited-link";
import { notFound } from "next/navigation";
import { PageHeader, PageShell, Panel, Section, backLinkClass, metaTextClass } from "@/components/ui/kit";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";
import VisitIntentForm from "./VisitIntentForm";

export const dynamic = "force-dynamic";

export default async function ExperienceDetailPage({
  params,
}: {
  params: Promise<{ id: string; experienceId: string }>;
}) {
  const { id, experienceId } = await params;
  const repository = await getServerPlaceExperienceRepository();
  const place = await repository.getPublishedPlaceById(id);
  const experience = await repository.getPublishedExperienceById(experienceId);

  if (
    !place ||
    !experience ||
    experience.placeId !== place.id ||
    experience.status !== "published" ||
    experience.publicationStatus !== "published"
  ) {
    notFound();
  }

  return (
    <>
      <SiteNav />
      <MarkVisited path={`/places/${place.id}/experiences/${experience.id}`} />
      <PageShell>
        <PageHeader
          back={
            <VisitedLink
              className={backLinkClass}
              visitedClassName="text-[#4a4d44] underline underline-offset-4"
              href={`/places/${place.id}`}
            >
              ← Kembali ke {place.name}
            </VisitedLink>
          }
          eyebrow={`Kegiatan di ${place.name}`}
          title={experience.title}
          description={experience.shortDescription}
        />

        <dl className={`mt-4 grid gap-3 border-b border-black/10 pb-4 sm:grid-cols-3 ${metaTextClass}`}>
          <div>
            <dt className="text-black/45">Durasi</dt>
            <dd className="mt-0.5 text-sm font-semibold text-brand-ink">{experience.durationMinutes} menit</dd>
          </div>
          <div>
            <dt className="text-black/45">Peserta</dt>
            <dd className="mt-0.5 text-sm font-semibold text-brand-ink">{experience.minPartySize}-{experience.maxPartySize} orang</dd>
          </div>
          <div>
            <dt className="text-black/45">Waktu Tempat</dt>
            <dd className="mt-0.5 text-sm font-semibold text-brand-ink">{place.timezone}</dd>
          </div>
        </dl>

        <div className="mt-5 grid gap-5">
          <Section title="Tentang Kegiatan">
            <p className={`text-black/70 ${metaTextClass}`}>{experience.description}</p>
          </Section>

          <Section title="Yang akan kamu lakukan">
            <ul className={`grid gap-1 text-black/70 ${metaTextClass}`}>
              {experience.highlights.map((highlight) => (
                <li key={highlight} className="flex gap-2">
                  <span aria-hidden="true" className="font-bold text-brand-accent">•</span>
                  <span>{highlight}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Jadwal dan titik temu">
            <Panel className="grid gap-3">
              {experience.schedules.map((schedule) => (
                <div key={`${schedule.dayOfWeek}-${schedule.startTime}`} className={metaTextClass}>
                  <p className="font-semibold text-brand-ink">{schedule.dayOfWeek}</p>
                  <p className="text-black/70">
                    {schedule.startTime}-{schedule.endTime} ({schedule.timezone})
                  </p>
                  <p className="mt-1 font-semibold text-brand-accent">Ketersediaan perlu dikonfirmasi kepada Pengelola.</p>
                </div>
              ))}
              <p className={`border-t border-black/10 pt-3 text-black/65 ${metaTextClass}`}>{experience.meetingPoint}</p>
            </Panel>
          </Section>

          <VisitIntentForm place={place} experience={experience} />
        </div>
      </PageShell>
    </>
  );
}
