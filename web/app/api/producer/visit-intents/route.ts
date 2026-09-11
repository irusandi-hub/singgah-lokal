import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { listProducerVisitIntents } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

const visitIntentStatuses: VisitIntentStatus[] = ["pending", "accepted", "declined", "requires_confirmation", "cancelled", "expired"];

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

    const placeIds = [...new Set(memberships.map(({ place_id }) => String(place_id)))];
    const searchParams = new URL(request.url).searchParams;
    const placeId = searchParams.get("placeId") ?? undefined;
    const status = searchParams.get("status") ?? undefined;
    if (placeId && !placeIds.includes(placeId)) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    if (status && !visitIntentStatuses.includes(status as VisitIntentStatus)) {
      return NextResponse.json({ error: "visit_intent_status_invalid" }, { status: 400 });
    }
    return NextResponse.json(await listProducerVisitIntents(placeIds, {
      placeId,
      status: status as VisitIntentStatus | undefined,
    }));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Visit Intents could not be loaded" }, { status: 400 });
  }
}