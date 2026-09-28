import { redirect } from "next/navigation";
import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import ProducerPlaceWorkspace from "@/app/producer/places/ProducerPlaceWorkspace";
import type { Place } from "@/lib/places";

export const dynamic = "force-dynamic";

// The Producer dashboard is ONE working page (PO, mockup work 2026-09-26):
// header/branding, "Dashboard Producer", then the "Place milikmu" workspace —
// roster + in-page add/edit via the shared PlaceForm/PlaceEditor. No
// ProducerSubNav here (the dashboard is the working surface itself, not a hub
// of links) and NO second Place list page. The former Visit Intent Inbox and
// Live shortcut cards are GONE: those surfaces stay reachable only from the
// Place detail surfaces through the shared ProducerSubNav, so the dashboard
// never links back to itself. Place data is loaded server-side from the
// authenticated user's owner/manager memberships via the canonical
// repository — no new auth, no new API.
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
    <main className="min-h-screen bg-brand-cream px-5 py-6 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-3xl">
        {/* PO fix 2026-09-28: the working dashboard still carries the standard
            way back (same link as every other Producer page) — the sub-nav
            tabs stay off the list view because the dashboard must never list
            itself as a tab. */}
        <Link className="text-sm font-bold text-brand-accent" href="/">
          Kembali ke Beranda
        </Link>

        <header className="mt-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Pengelola App</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dashboard Pengelola</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-black/60">
            Kelola Tempat dan kegiatanmu, tanggapi Permintaan Kunjungan, dan kelola Live.
          </p>
        </header>

        <ProducerPlaceWorkspace initialPlaces={places} showOnboardingHint={places.length === 0} />
      </div>
    </main>
  );
}
