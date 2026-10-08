import { redirect } from "next/navigation";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import ProducerPlaceWorkspace from "@/app/producer/places/ProducerPlaceWorkspace";
import { PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";
import type { Place } from "@/lib/places";

export const dynamic = "force-dynamic";

// The Producer dashboard is ONE working page: a compact header, then the
// "Tempat yang Kamu Kelola" workspace — roster + in-page add/edit via the
// shared PlaceForm/PlaceEditor. No ProducerSubNav here (the dashboard is the
// working surface itself, not a hub of links) and NO second Place list page.
// Its single escape path is back to the public home; the dashboard never
// links to itself. Place data is loaded server-side from the authenticated
// user's owner/manager memberships via the canonical repository — no new
// auth, no new API.
export default async function ProducerDashboardPage() {
  const places: Place[] = [];

  try {
    const actor = await requireAuthenticatedActor(new Request("http://localhost/producer"));
    const supabase = await createSupabaseServerClient();
    const { data: memberships } = await supabase
      .from("producer_memberships")
      .select("place_id, role")
      .eq("user_id", actor.userId)
      .in("role", ["owner", "manager"]);
    const placeRepository = await getServerPlaceManagementRepository();
    for (const membership of memberships ?? []) {
      const place = await placeRepository.getById(String(membership.place_id));
      if (place) places.push(place);
    }
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      redirect("/auth?returnTo=%2Fproducer");
    }
    throw error;
  }

  return (
    <PageShell>
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            Kembali ke Beranda
          </Link>
        }
        title="Dashboard Pengelola"
        description="Kelola Tempat dan kegiatanmu, tanggapi Permintaan Kunjungan, dan kelola Live."
      />

      <div className="mt-5">
        <ProducerPlaceWorkspace initialPlaces={places} showOnboardingHint={places.length === 0} />
      </div>
    </PageShell>
  );
}
