import Link from "next/link";
import { notFound } from "next/navigation";
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
    <main className="min-h-screen bg-[#f7f5ef] px-5 py-6 text-[#20231f] sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-bold text-[#7b5b38]" href={`/places/${place.id}`}>
          ← Kembali ke {place.name}
        </Link>

        <article className="mt-8 overflow-hidden rounded-[28px] border border-black/10 bg-white shadow-sm">
          <div className="bg-[#d9dfd2] px-6 py-10 sm:px-10">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Experience di {place.name}</p>
            <h1 className="mt-3 text-4xl font-black tracking-tight">{experience.title}</h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-black/70">{experience.shortDescription}</p>
          </div>

          <div className="p-6 sm:p-10">
            <dl className="grid gap-4 border-b border-black/10 pb-6 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Durasi</dt>
                <dd className="mt-1 text-sm font-semibold">{experience.durationMinutes} menit</dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Peserta</dt>
                <dd className="mt-1 text-sm font-semibold">{experience.minPartySize}-{experience.maxPartySize} orang</dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Waktu Place</dt>
                <dd className="mt-1 text-sm font-semibold">{place.timezone}</dd>
              </div>
            </dl>

            <section className="mt-8">
              <h2 className="text-xl font-black">Tentang Experience</h2>
              <p className="mt-3 text-sm leading-7 text-black/70">{experience.description}</p>
            </section>

            <section className="mt-8">
              <h2 className="text-xl font-black">Yang akan kamu lakukan</h2>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-black/70">
                {experience.highlights.map((highlight) => (
                  <li key={highlight} className="flex gap-2">
                    <span aria-hidden="true" className="font-bold text-[#7b5b38]">•</span>
                    <span>{highlight}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-8 rounded-2xl bg-[#f7f5ef] p-5">
              <h2 className="text-xl font-black">Jadwal dan titik temu</h2>
              {experience.schedules.map((schedule) => (
                <div key={`${schedule.dayOfWeek}-${schedule.startTime}`} className="mt-3 text-sm leading-6 text-black/70">
                  <p>{schedule.dayOfWeek}</p>
                  <p>
                    {schedule.startTime}-{schedule.endTime} ({schedule.timezone})
                  </p>
                  <p className="mt-2 font-semibold text-[#7b5b38]">Ketersediaan perlu dikonfirmasi kepada Producer.</p>
                </div>
              ))}
              <p className="mt-4 border-t border-black/10 pt-4 text-sm leading-6 text-black/65">{experience.meetingPoint}</p>
            </section>

            <VisitIntentForm place={place} experience={experience} />
          </div>
        </article>
      </div>
    </main>
  );
}