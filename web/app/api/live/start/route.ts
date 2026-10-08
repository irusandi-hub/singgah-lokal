import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { startLiveSession } from "@/lib/live/session-service";
import { ProducerAuthorizationRequiredError } from "@/lib/auth/server";

type StartBody = {
  placeId?: unknown;
  stageId?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = (await request.json()) as StartBody;
    const placeId =
      typeof body.placeId === "string" ? body.placeId : "";
    const stageId =
      typeof body.stageId === "string" ? body.stageId : "";
    const idempotencyKey = typeof body.idempotencyKey === "string"
      ? body.idempotencyKey.trim()
      : "";

    if (!placeId || !stageId || !idempotencyKey) {
      return NextResponse.json(
        { error: "placeId_stage_idempotency_required" },
        { status: 400 },
      );
    }

    const isOperator = await isLiveOperatorForPlace(
      supabase,
      userData.user.id,
      placeId,
    );
    const isProducer = await isPlaceOwnerOrManager(
      supabase,
      userData.user.id,
      placeId,
    );

    if (!isProducer && !isOperator) {
      throw new ProducerAuthorizationRequiredError();
    }

    const result = await startLiveSession({
      placeId,
      stageId,
      idempotencyKey,
      actorKey: placeId,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }
    if (error instanceof Error) {
      const message = error.message;
      if (message.includes("live_cap_denied")) {
        return NextResponse.json({ error: "live_cap_denied" }, { status: 400 });
      }
      if (message.includes("live_place_busy")) {
        return NextResponse.json({ error: "live_place_busy" }, { status: 400 });
      }
      if (message.includes("live_not_eligible")) {
        return NextResponse.json({ error: "live_not_eligible" }, { status: 400 });
      }
      if (message.includes("live_stage_not_published")) {
        return NextResponse.json(
          { error: "live_stage_not_published" },
          { status: 400 },
        );
      }
      if (message.includes("producer_authorization_required")) {
        return NextResponse.json(
          { error: "producer_authorization_required" },
          { status: 403 },
        );
      }
      if (message.includes("live_start_busy")) {
        return NextResponse.json({ error: "live_start_busy" }, { status: 400 });
      }
      if (message.includes("live_boundary_unavailable")) {
        return NextResponse.json(
          { error: "live_boundary_unavailable" },
          { status: 503 },
        );
      }
    }
    return NextResponse.json({ error: "live_unavailable" }, { status: 500 });
  }
}

async function isLiveOperatorForPlace(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  placeId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("live_operators")
    .select("id")
    .eq("user_id", userId)
    .eq("place_id", placeId)
    .eq("revoked_at", null)
    .single();
  return Boolean(data);
}

async function isPlaceOwnerOrManager(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  placeId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("producer_memberships")
    .select("id")
    .eq("user_id", userId)
    .eq("place_id", placeId)
    .in("role", ["owner", "manager"])
    .single();
  return Boolean(data);
}
