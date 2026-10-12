import { NextResponse } from "next/server";
import { startLiveSession } from "@/lib/live/session-service";
import {
  liveStartAuthorityErrorResponse,
  requireLiveStartAuthority,
} from "@/lib/live/operator-authorization";

type StartBody = {
  placeId?: unknown;
  stageId?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  try {
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

    // THE shared start-Live authority gate (audit A-07): identical to the
    // Producer console endpoint by construction, because both call this one
    // function instead of each keeping its own rule.
    await requireLiveStartAuthority(request, placeId);

    const result = await startLiveSession({
      placeId,
      stageId,
      idempotencyKey,
      actorKey: placeId,
    });

    return NextResponse.json(result);
  } catch (error) {
    const authorityResponse = liveStartAuthorityErrorResponse(error);
    if (authorityResponse) {
      return NextResponse.json(authorityResponse.body, {
        status: authorityResponse.status,
      });
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
