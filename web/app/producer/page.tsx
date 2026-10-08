import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import ProducerPlaceWorkspace from "@/app/producer/places/ProducerPlaceWorkspace";
import type { Place } from "@/lib/places";

export const dynamic = "force-dynamic";

// The Producer dashboard owns NO page chrome of its own: the single shell, the
// single header (title per state) and the ONE contextual back link belong to
// ProducerPlaceWorkspace, which decides them per view. That is what keeps every
// state (roster / add / claim / edit) at exactly ONE shell, ONE context, ONE
// back and ONE navigation layer instead of nesting a second shell inside the
// dashboard's own.
//
// Place data is loaded server-side from the authenticated user's owner/manager
// memberships via the canonical repository — no new auth, no new API.
export default async function ProducerDashboardPage() {
  let places: Place[] = [];

  try {
    const actor = await requireAuthenticatedActor(new Request("http://localhost/producer"));
    const supabase = await createSupabaseServerClient();
    const { data: memberships } = await supabase
      .from("producer_memberships")
      .select("place_id, role")
      .eq("user_id", actor.userId)
      .in("role", ["owner", "manager"]);
    const placeRepository = await getServerPlaceManagementRepository();
    // PERFORMANCE (2026-10-08): the per-membership lookups are independent, so
    // they run as ONE parallel batch instead of a sequential `await` loop.
    // `Promise.all` preserves the memberships order and the same falsy
    // filtering, so the roster content AND its order are identical to the
    // sequential version. The authorization predicate (owner/manager
    // memberships), the repository behaviour and the schema are unchanged.
    const resolved = await Promise.all(
      (memberships ?? []).map((membership) => placeRepository.getById(String(membership.place_id))),
    );
    places = resolved.filter((place): place is Place => Boolean(place));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      redirect("/auth?returnTo=%2Fproducer");
    }
    throw error;
  }

  return <ProducerPlaceWorkspace initialPlaces={places} showOnboardingHint={places.length === 0} />;
}
