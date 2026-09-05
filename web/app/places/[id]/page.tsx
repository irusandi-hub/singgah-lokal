import Link from "next/link";
import { notFound } from "next/navigation";
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
        </article>
      </div>
    </main>
  );
}