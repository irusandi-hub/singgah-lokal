import Link from "next/link";
import { notFound } from "next/navigation";
import SiteNav from "@/components/site-nav";
import MarkVisited from "@/components/mark-visited";
import VisitedLink from "@/components/visited-link";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { buildDirectionsUrl } from "@/lib/live/ui";
import { PlaceLiveStatus } from "./PlaceLiveStatus";

export const dynamic = "force-dynamic";

export default async function PlaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repository = await getServerPlaceExperienceRepository();
  const place = await repository.getPublishedPlaceById(id);

  if (!place) {
    notFound();
  }

  const placeExperiences = await repository.listPublishedExperiencesForPlace(place.id);
  const productionStages = await (await getServerProductionStoryRepository()).listForPlace(place.id, true);

  return (
    <>
      <SiteNav />
      <MarkVisited path={`/places/${place.id}`} />
      <main className="min-h-screen bg-brand-cream px-5 py-6 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-bold text-brand-accent" href="/">
          ← Kembali ke peta
        </Link>

        <article className="mt-8 rounded-[28px] border border-black/10 bg-white p-6 shadow-sm sm:p-10">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">
            {place.category} • {place.type === "production" ? "Produksi" : "Experience"}
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">{place.name}</h1>
          <p className="mt-2 text-sm text-black/55">{place.area}</p>

          {/* Cover image hero — canonical Place data (cover_image_url,
              migration 0018). Without a saved cover URL nothing is invented:
              the hero simply does not render and the page keeps its current
              identity header. */}
          {place.coverImageUrl ? (
            <div className="mt-6 overflow-hidden rounded-[24px] border border-black/10 bg-brand-cream shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element -- external
                  producer-supplied image URL; next/image would require host
                  allowlisting that producers cannot configure. */}
              <img
                src={place.coverImageUrl}
                alt={`Gambar sampul ${place.name}`}
                className="h-56 w-full object-cover sm:h-72"
                loading="lazy"
              />
            </div>
          ) : null}

          <p className="mt-6 text-base leading-7 text-black/70">{place.shortDescription}</p>

          {/* Direction — a permanent Place attribute (PO 2026-09-26). The
              navigation target comes ONLY from the canonical Place
              coordinates through the shared buildDirectionsUrl helper; with
              no coordinates the attribute stays visible but disabled and no
              URL is ever invented. No operating-hours status renders: the
              canonical Place model has no operating-hours field (DATA GAP). */}
          <section className="mt-6" aria-label="Aksi Place">
            {buildDirectionsUrl(place) ? (
              <a
                className="inline-flex items-center gap-1.5 rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white"
                href={buildDirectionsUrl(place) as string}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Petunjuk arah ke ${place.name} di aplikasi peta`}
              >
                <span aria-hidden>➤</span> Direction
              </a>
            ) : (
              <span
                aria-disabled="true"
                title="Koordinat Place belum tersedia"
                className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-black/10 bg-white px-5 py-2.5 text-sm font-bold text-black/35"
              >
                <span aria-hidden>➤</span> Direction
              </span>
            )}
          </section>

          {/* Live status — a PERMANENT Place attribute (policy §9, PO
              2026-09-26): visible in both states; the not-live state expands
              to the honest "Place ini sedang tidak Live." status. */}
          <PlaceLiveStatus placeId={place.id} />

          <section className="mt-10 border-t border-black/10 pt-8" aria-labelledby="experiences-heading">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Experience di Place ini</p>
            <h2 id="experiences-heading" className="mt-2 text-2xl font-semibold tracking-tight">
              Kalau datang, kamu akan melakukan apa?
            </h2>
            <div className="mt-5 grid gap-4">
              {placeExperiences.length > 0 ? (
                placeExperiences.map((experience) => (
                  <article key={experience.id} className="rounded-2xl border border-black/10 bg-brand-cream p-5">
                    <h3 className="text-lg font-semibold">{experience.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-black/65">{experience.shortDescription}</p>
                    <VisitedLink
                      className="mt-4 inline-flex rounded-full bg-brand-ink px-4 py-2 text-sm font-bold text-white"
                      visitedClassName="bg-[#4a4d44]"
                      href={`/places/${place.id}/experiences/${experience.id}`}
                    >
                      Lihat Experience
                    </VisitedLink>
                  </article>
                ))
              ) : (
                <p className="text-sm text-black/60">Experience di Place ini belum tersedia.</p>
              )}
            </div>
          </section>

          <section className="mt-10 border-t border-black/10 pt-8" aria-labelledby="story-heading">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Dari Sini</p>
            <h2 id="story-heading" className="mt-2 text-2xl font-semibold tracking-tight">Dari sumber sampai menjadi pengalaman</h2>
            <div className="mt-5 grid gap-4">
              {productionStages.length > 0 ? productionStages.map((stage) => (
                <article key={stage.id} className="rounded-2xl border border-black/10 bg-brand-cream p-5">
                  <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-accent">Tahap {stage.sortOrder + 1}</p>
                  <h3 className="mt-1 text-lg font-semibold">{stage.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-black/65">{stage.description}</p>
                </article>
              )) : <p className="text-sm text-black/60">Cerita produksi Place ini belum tersedia.</p>}
            </div>
          </section>
        </article>
      </div>
    </main>
    </>
  );
}