import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { endLiveSession } from "@/lib/live/session-service";
import { ProducerAuthorizationRequiredError } from "@/lib/auth/server";

type EndBody = {
  sessionId?: unknown;
  idempotencyKey?: unknown;
  note?: unknown;
};

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = (await request.json()) as EndBody;
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId : "";
    const idempotencyKey = typeof body.idempotencyKey === "string"
      ? body.idempotencyKey.trim()
      : "";

    if (!sessionId || !idempotencyKey) {
      return NextResponse.json(
        { error: "session_id_idempotency_required" },
        { status: 400 },
      );
    }

    const { data: session, error: sessionError } = await supabase
      .from("live_sessions")
      .select("place_id")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: "live_session_not_found" },
        { status: 404 },
      );
    }

    const isOperator = await isLiveOperatorForPlace(
      supabase,
      userData.user.id,
      session.place_id,
    );
    const isProducer = await isPlaceOwnerOrManager(
      supabase,
      userData.user.id,
      session.place_id,
    );

    if (!isProducer && !isOperator) {
      throw new ProducerAuthorizationRequiredError();
    }

    const result = await endLiveSession({
      sessionId,
      idempotencyKey,
      reason: "producer_ended",
      note:
        typeof body.note === "string" ? body.note : undefined,
    });

    return NextResponse.json({ ended: result });
  } catch (error) {
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }
    if (error instanceof Error) {
      const message = error.message;
      if (message.includes("live_end_idempotency_key_required")) {
        return NextResponse.json(
          { error: "live_end_idempotency_key_required" },
          { status: 400 },
        );
      }
    }
    return NextResponse.json({ error: "live_end_unavailable" }, { status: 500 });
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
