import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import ProducerSubNav from "@/components/producer-sub-nav";
import { LiveConsole } from "./LiveConsole";

export const dynamic = "force-dynamic";

export default async function ProducerLivePage() {
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    redirect("/auth?returnTo=/producer/live");
  }

  // Authorization is derived server-side from the authenticated user's
  // memberships; only owner/manager may open the Live console.
  const { data: memberships } = await supabase
    .from("producer_memberships")
    .select("place_id, role, producer_id")
    .eq("user_id", userData.user.id);

  const authorized = (memberships ?? []).filter((membership) =>
    membership.role === "owner" || membership.role === "manager",
  );

  const stageRepository = await getServerProductionStoryRepository();
  const placeRepository = await getServerPlaceManagementRepository();

  const places = [];
  for (const membership of authorized) {
    const place = await placeRepository.getById(membership.place_id);
    if (!place) continue;
    const stages = await stageRepository.listForPlace(membership.place_id, true);
    places.push({
      id: place.id,
      name: place.name,
      stages: stages
        .filter((stage) => stage.status === "published")
        .map((stage) => ({ id: stage.id, title: stage.title, sortOrder: stage.sortOrder })),
    });
  }

  return (
    <main className="min-h-screen bg-brand-cream px-5 py-6 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Link className="text-sm font-bold text-brand-accent" href="/producer">
          ← Dashboard Producer
        </Link>

        <div className="mt-4">
          <ProducerSubNav active="/producer/live" />
        </div>

        <header className="mt-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Producer Live</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Tayangkan Proses secara real-time</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-black/60">
            Live menampilkan proses produksi asli dari Place-mu. 1 kamera statis, 720p/30fps,
            maksimal 100 penonton concurrent, durasi maksimal 60 menit. Live tidak direkam dan
            tidak memuat monetisasi.
          </p>
        </header>

        <div className="mt-8">
          {places.length === 0 ? (
            <section className="rounded-2xl border border-black/10 bg-white p-6 shadow-sm">
              <p className="text-sm text-black/65">
                Kamu belum memiliki Place dengan akses owner/manager. Live hanya dapat dimulai dari
                Place yang kamu kelola.
              </p>
              <Link className="mt-4 inline-flex rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white" href="/producer/places">
                Buka daftar Place
              </Link>
            </section>
          ) : (
            <LiveConsole places={places} />
          )}
        </div>
      </div>
    </main>
  );
}
