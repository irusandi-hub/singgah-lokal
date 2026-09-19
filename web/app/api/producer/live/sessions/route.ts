import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { endLiveSession, LiveValidationError, startLiveSession } from "@/lib/live/session-service";

type StartLiveBody = {
  placeId?: unknown;
  stageId?: unknown;
  idempotencyKey?: unknown;
};

type EndLiveBody = {
  sessionId?: unknown;
  note?: unknown;
};

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationRequiredError) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }
  if (error instanceof ProducerAuthorizationRequiredError) {
    return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
  }
  if (error instanceof LiveValidationError) {
    const status = error.message === "producer_authorization_required" ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ error: "live_unavailable" }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as StartLiveBody;
    const placeId = typeof body.placeId === "string" ? body.placeId : "";
    const stageId = typeof body.stageId === "string" ? body.stageId : "";
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";

    if (!placeId || !stageId || !idempotencyKey) {
      return NextResponse.json({ error: "placeId_stage_idempotency_required" }, { status: 400 });
    }

    // Producer must be authorized for the Place (owner/manager).
    await requireProducerAccess(request, placeId, ["owner", "manager"]);

    // Process is the subject: stage must exist, belong to the Place, and be published.
    const stage = await (await getServerProductionStoryRepository()).getById(placeId, stageId);
    if (!stage || stage.status !== "published") {
      return NextResponse.json({ error: "live_stage_not_published" }, { status: 400 });
    }

    const result = await startLiveSession({
      placeId,
      stageId,
      idempotencyKey,
      actorKey: placeId,
    });

    // webRtcPublishUrl is secret-bearing (provider stream key). It is issued
    // ONLY here, to the authorized Producer, over this authenticated response
    // — never persisted, never logged, never exposed to viewers.
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as EndLiveBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) {
      return NextResponse.json({ error: "session_id_required" }, { status: 400 });
    }

    await endLiveSession({
      sessionId,
      actorKey: "route",
      reason: "producer_ended",
      note: typeof body.note === "string" ? body.note : undefined,
    });

    return NextResponse.json({ ended: true });
  } catch (error) {
    return errorResponse(error);
  }
}
