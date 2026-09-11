import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerVisitIntentRepository } from "@/lib/visit-intent-repository";

export async function GET(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const supabase = await createSupabaseServerClient();
    const { data: memberships, error: membershipError } = await supabase
      .from("producer_memberships")
      .select("place_id")
      .eq("user_id", actor.userId)
      .in("role", ["owner", "manager"]);
    if (membershipError) throw membershipError;

    if (!memberships?.length) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }

    const repository = await getServerVisitIntentRepository();
    const placeIds = [...new Set(memberships.map(({ place_id }) => String(place_id)))];
    const intents = (await Promise.all(placeIds.map(async (placeId) => {
      const placeIntents = await repository.listForPlace(placeId);
      const validIntents = await Promise.all(placeIntents.map(async (intent) => {
        const experience = await repository.getExperienceById(intent.experienceId);
        return experience?.placeId === intent.placeId ? intent : null;
      }));
      return validIntents.filter((intent): intent is NonNullable<typeof intent> => intent !== null);
    }))).flat();
    return NextResponse.json(intents);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Visit Intents could not be loaded" }, { status: 400 });
  }
}