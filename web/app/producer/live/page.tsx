import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import ProducerSubNav from "@/components/producer-sub-nav";
import { EmptyState, PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";
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
    <PageShell>
      <PageHeader
        back={
          <Link className={backLinkClass} href="/producer">
            ← Pengelola
          </Link>
        }
        eyebrow="Pengelola Live"
        title="Tampilkan Proses Secara Langsung"
        description="Tampilkan proses yang sedang berlangsung secara langsung. 1 kamera statis, 720p/30fps, maksimal 100 penonton secara bersamaan, durasi maksimal 60 menit. Live tidak direkam dan tidak memuat monetisasi."
      />

      <div className="mt-4">
        <ProducerSubNav active="/producer/live" />
      </div>

      <div className="mt-4">
        {places.length === 0 ? (
          <EmptyState
            title="Belum ada Tempat dengan hak akses Pengelola"
            description="Live hanya dapat dimulai dari Tempat yang kamu kelola."
          />
        ) : (
          <LiveConsole places={places} />
        )}
      </div>
    </PageShell>
  );
}
