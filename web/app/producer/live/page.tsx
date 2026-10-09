import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import ProducerSubNav from "@/components/producer-sub-nav";
import { EmptyState, PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";
import { LiveConsole } from "./LiveConsole";

export const dynamic = "force-dynamic";

/** The live console only needs a Place's identity and its published stages. */
type LivePlace = {
  id: string;
  name: string;
  stages: Array<{ id: string; title: string; sortOrder: number }>;
};

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

  // Delegated Operator Live scope: an ACTIVE live_operators assignment is a
  // SEPARATE grant, so it never comes from a membership and a membership never
  // comes from it. A delegated operator must still be able to open the console
  // for the EXACT Place they were assigned — and for nothing else. Only the
  // caller's own non-revoked assignments are readable.
  const { data: operatorAssignments } = await supabase
    .from("live_operators")
    .select("place_id")
    .eq("user_id", userData.user.id)
    .is("revoked_at", null);

  const seen = new Set(authorized.map((membership) => String(membership.place_id)));
  const operatorOnly = (operatorAssignments ?? [])
    .map((row) => String(row.place_id))
    .filter((placeId) => {
      if (seen.has(placeId)) return false;
      seen.add(placeId);
      return true;
    })
    .map((place_id) => ({ place_id }));

  // ONE list of operable Places: the managed roster first, then the Places
  // this account may operate only as a delegated Operator Live.
  const operable = [
    ...authorized.map((membership) => ({ place_id: String(membership.place_id) })),
    ...operatorOnly,
  ];

  const stageRepository = await getServerProductionStoryRepository();
  const placeRepository = await getServerPlaceManagementRepository();

  // PERFORMANCE (2026-10-08): each Place needs the same two independent reads
  // (the Place record and its published stages). They run as ONE parallel
  // batch per Place and all Places run concurrently, instead of two sequential
  // awaits per Place. `Promise.all` preserves the memberships order and the
  // same null filtering, so the console's Place list and stage order are
  // identical. Authorization (owner/manager memberships plus the account's own
  // active operator assignments) and both repositories are unchanged.
  const resolved = await Promise.all(
    operable.map(async (membership): Promise<LivePlace | null> => {
      const place = await placeRepository.getById(membership.place_id);
      if (!place) return null;
      const stages = await stageRepository.listForPlace(membership.place_id, true);
      return {
        id: place.id,
        name: place.name,
        stages: stages
          .filter((stage) => stage.status === "published")
          .map((stage) => ({ id: stage.id, title: stage.title, sortOrder: stage.sortOrder })),
      };
    }),
  );
  const places = resolved.filter((place): place is LivePlace => place !== null);

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
            description="Live hanya dapat dimulai dari Tempat yang kamu kelola, atau Tempat yang menjadi penugasan Operator Live-mu."
          />
        ) : (
          <LiveConsole places={places} />
        )}
      </div>
    </PageShell>
  );
}
