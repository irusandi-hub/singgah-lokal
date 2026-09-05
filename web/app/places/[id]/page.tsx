import Link from "next/link";
import { notFound } from "next/navigation";
import { getExperiencesForPlace } from "@/lib/experiences";
import { getPlaceById, places } from "@/lib/places";

export function generateStaticParams() {
  return places.map((place) => ({ id: place.id }));
}

export default async function PlaceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const place = getPlaceById(id);

  if (!place) {
    notFound();
  }

  const placeExperiences = getExperiencesForPlace(place.id);

  return (
    <main className="min-h-screen bg-[#f7f5ef] px-5 py-6 text-[#20231f] sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-bold text-[#7b5b38]" href="/">
          ← Kembali ke peta
        </Link>

        <article className="mt-8 rounded-[28px] border border-black/10 bg-white p-6 shadow-sm sm:p-10">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">
            {place.category} • {place.type === "production" ? "Produksi" : "Experience"}
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight">{place.name}</h1>
          <p className="mt-2 text-sm text-black/55">{place.area}</p>
          <p className="mt-6 text-base leading-7 text-black/70">{place.shortDescription}</p>

          <dl className="mt-8 grid gap-4 border-t border-black/10 pt-6 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Waktu Place</dt>
              <dd className="mt-1 text-sm font-semibold">{place.timezone}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Mata uang Place</dt>
              <dd className="mt-1 text-sm font-semibold">{place.currency}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Status klaim</dt>
              <dd className="mt-1 text-sm font-semibold">{place.claimStatus}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">Producer</dt>
              <dd className="mt-1 text-sm font-semibold">{place.producer?.displayName ?? "Belum ditautkan"}</dd>
            </div>
          </dl>

          <section className="mt-10 border-t border-black/10 pt-8" aria-labelledby="experiences-heading">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Experience di Place ini</p>
            <h2 id="experiences-heading" className="mt-2 text-2xl font-black tracking-tight">
              Kalau datang, kamu akan melakukan apa?
            </h2>
            <div className="mt-5 grid gap-4">
              {placeExperiences.length > 0 ? (
                placeExperiences.map((experience) => (
                  <article key={experience.id} className="rounded-2xl border border-black/10 bg-[#f7f5ef] p-5">
                    <h3 className="text-lg font-black">{experience.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-black/65">{experience.shortDescription}</p>
                    <Link
                      className="mt-4 inline-flex rounded-full bg-[#20231f] px-4 py-2 text-sm font-bold text-white"
                      href={`/places/${place.id}/experiences/${experience.id}`}
                    >
                      Lihat Experience
                    </Link>
                  </article>
                ))
              ) : (
                <p className="text-sm text-black/60">Experience di Place ini belum tersedia.</p>
              )}
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}