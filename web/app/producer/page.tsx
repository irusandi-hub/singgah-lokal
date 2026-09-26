import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import ProducerSubNav from "@/components/producer-sub-nav";

export const dynamic = "force-dynamic";

// Entry point to the existing Producer area. Everything shown is derived
// server-side from the authenticated user's owner/manager memberships —
// no new auth or role system.
export default async function ProducerDashboardPage() {
  const places: Array<{ id: string; name: string }> = [];

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
      if (place) places.push({ id: place.id, name: place.name });
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
        <ProducerSubNav active="/producer" />
        <header className="mt-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Producer App</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Dashboard Producer</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-black/60">
            Kelola Place, Experience, Visit Intent, dan Live untuk Place yang berada dalam kewenanganmu.
          </p>
        </header>

        <section aria-label="Area Producer" className="mt-8 grid gap-3 sm:grid-cols-2">
          <Link href="/producer/places" className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm transition hover:shadow-md">
            <h2 className="text-lg font-semibold">Places</h2>
            <p className="mt-1 text-sm text-black/60">Daftar Place, pengelolaan Place dan Experience.</p>
          </Link>
          <Link href="/producer/visit-intents" className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm transition hover:shadow-md">
            <h2 className="text-lg font-semibold">Visit Intent Inbox</h2>
            <p className="mt-1 text-sm text-black/60">Niat berkunjung masuk dan respons Producer.</p>
          </Link>
          <Link href="/producer/live" className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm transition hover:shadow-md">
            <h2 className="text-lg font-semibold">Live</h2>
            <p className="mt-1 text-sm text-black/60">Tayangkan proses produksi secara real-time.</p>
          </Link>
        </section>

        {places.length === 0 && (
          <p className="mt-8 rounded-2xl border border-black/10 bg-white p-5 text-sm text-black/65">
            Belum ada Place dalam kewenanganmu. Ikuti proses verifikasi untuk menjadi Producer —
            lihat <Link href="/producer/onboarding" className="font-bold text-brand-accent underline underline-offset-2">Ajukan menjadi Producer</Link>.
          </p>
        )}

        {places.length > 0 && (
          <section aria-label="Place dalam kewenangan" className="mt-8">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Place milikmu</h2>
            <div className="mt-3 grid gap-2">
              {/* Producer Place management is canonical at /producer/places
                  (PO 2026-09-26): every Place opens there for edit/manage —
                  no per-Place page as the management entry point. */}
              <Link
                href="/producer/places"
                className="rounded-xl border border-black/10 bg-white px-4 py-3 text-sm font-bold hover:bg-black/[0.03]"
              >
                {places.length === 1 ? "Kelola 1 Place — Place saya" : `Kelola ${places.length} Place — Place saya`}
              </Link>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
