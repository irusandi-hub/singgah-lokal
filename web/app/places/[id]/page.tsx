import Link from "next/link";
import { notFound } from "next/navigation";
import SiteNav from "@/components/site-nav";
import MarkVisited from "@/components/mark-visited";
import VisitedLink from "@/components/visited-link";
import { PageHeader, PageShell, backLinkClass, btn, metaTextClass } from "@/components/ui/kit";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { buildDirectionsUrl } from "@/lib/live/ui";
import { PlaceLiveStatus } from "./PlaceLiveStatus";

export const dynamic = "force-dynamic";

/**
 * Place detail — the Place's public surface.
 *
 * Structure: header (one way back to the map, identity, cover hero, the two
 * permanent Place attributes: Direction and LIVE) → then the two content
 * sections, each a compact list instead of a stack of cards. Same canonical
 * data, same attributes, same deep links.
 */
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
      <PageShell>
        <PageHeader
          back={
            <Link className={backLinkClass} href="/">
              ← Kembali ke peta
            </Link>
          }
          eyebrow={`${place.category} • ${place.type === "production" ? "Produksi" : "Kegiatan"}`}
          title={place.name}
          description={place.shortDescription}
          actions={
            <>
              {/* Direction — a permanent Place attribute. The navigation
                  target comes ONLY from canonical Place coordinates through
                  the shared buildDirectionsUrl helper; with no coordinates the
                  attribute stays visible but disabled and no URL is invented. */}
              {buildDirectionsUrl(place) ? (
                <a
                  className={btn.primary}
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
                  title="Koordinat Tempat belum tersedia"
                  className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-bold text-black/35"
                >
                  <span aria-hidden>➤</span> Direction
                </span>
              )}
            </>
          }
        />

        <p className={`mt-2 text-black/55 ${metaTextClass}`}>{place.area}</p>

        {/* Cover image hero — canonical Place data (cover_image_url). Without a
            saved cover URL nothing is invented: the hero simply does not
            render. */}
        {place.coverImageUrl ? (
          <div className="mt-3 overflow-hidden rounded-2xl border border-black/10 bg-brand-cream">
            {/* eslint-disable-next-line @next/next/no-img-element -- external
                producer-supplied image URL; next/image would require host
                allowlisting that producers cannot configure. */}
            <img
              src={place.coverImageUrl}
              alt={`Gambar sampul ${place.name}`}
              className="h-48 w-full object-cover sm:h-64"
              loading="lazy"
            />
          </div>
        ) : null}

        {/* Live status — a PERMANENT Place attribute: visible in both states. */}
        <div className="mt-3">
          <PlaceLiveStatus placeId={place.id} />
        </div>

        <div className="mt-6 grid gap-6">
          <section aria-labelledby="experiences-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/10 pb-2">
              <h2 id="experiences-heading" className="text-[17px] font-semibold leading-snug tracking-tight">
                Kegiatan di Tempat ini
              </h2>
              <p className={`text-black/55 ${metaTextClass}`}>Kalau datang, kamu akan melakukan apa?</p>
            </div>
            <div className="mt-2 grid gap-2">
              {placeExperiences.length > 0 ? (
                placeExperiences.map((experience) => (
                  <article key={experience.id} className="rounded-xl border border-black/10 bg-white px-3 py-2.5">
                    <h3 className="break-words text-sm font-semibold">{experience.title}</h3>
                    <p className={`mt-1 text-black/65 ${metaTextClass}`}>{experience.shortDescription}</p>
                    <VisitedLink
                      className={`mt-2 ${btn.compact}`}
                      visitedClassName="border-brand-accent/35 bg-[#faf6ee]"
                      href={`/places/${place.id}/experiences/${experience.id}`}
                    >
                      Lihat Kegiatan
                    </VisitedLink>
                  </article>
                ))
              ) : (
                <p className={`text-black/60 ${metaTextClass}`}>Kegiatan di Tempat ini belum tersedia.</p>
              )}
            </div>
          </section>

          <section aria-labelledby="story-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-black/10 pb-2">
              <h2 id="story-heading" className="text-[17px] font-semibold leading-snug tracking-tight">
                Dari Sini
              </h2>
              <p className={`text-black/55 ${metaTextClass}`}>Dari sumber sampai menjadi pengalaman</p>
            </div>
            <div className="mt-2 grid gap-2">
              {productionStages.length > 0 ? productionStages.map((stage) => (
                <article key={stage.id} className="rounded-xl border border-black/10 bg-white px-3 py-2.5">
                  <p className={`text-brand-accent ${metaTextClass}`}>Tahap {stage.sortOrder + 1}</p>
                  <h3 className="mt-0.5 break-words text-sm font-semibold">{stage.title}</h3>
                  <p className={`mt-1 text-black/65 ${metaTextClass}`}>{stage.description}</p>
                </article>
              )) : <p className={`text-black/60 ${metaTextClass}`}>Cerita produksi Tempat ini belum tersedia.</p>}
            </div>
          </section>
        </div>
      </PageShell>
    </>
  );
}
