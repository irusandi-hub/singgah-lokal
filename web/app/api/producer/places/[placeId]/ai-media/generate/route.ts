/**
 * AI MEDIA INITIAL GENERATION — capability check + job creation.
 *
 * Route path: /api/producer/places/[placeId]/ai-media/generate
 *
 * GET  → asks the server whether the Producer can generate for this Place now.
 * POST → creates (or replays) an idempotent initial generation job for BOTH
 *        outputs (hook + place_story). Does NOT call a provider and does NOT
 *        persist outputs — it only records the request so the worker can later
 *        produce both outputs as drafts.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  canAiMediaGenerate,
  createAiMediaInitialGeneration,
} from "@/lib/ai-media-generation-capability";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import { AiMediaError, type AiMediaErrorCode, validateAiMediaIdempotencyKey } from "@/lib/ai-media";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await params;
    await requireAuthenticatedActor(request);
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    const capability = await canAiMediaGenerate(placeId, access.producerId);
    return NextResponse.json(
      {
        available: capability.available,
        ...(capability.reason ? { reason: capability.reason } : {}),
        ...(capability.provider ? { provider: capability.provider } : {}),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, private",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    return NextResponse.json({ error: "ai_media_unavailable" }, { status: 400 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await params;
    const actor = await requireAuthenticatedActor(request);
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AiMediaError("ai_media_request_invalid");
    }

    if (typeof body !== "object" || body === null) {
      throw new AiMediaError("ai_media_request_invalid");
    }

    const bodyObj = body as Record<string, unknown>;
    const idempotencyKeyRaw = bodyObj.idempotencyKey;
    if (typeof idempotencyKeyRaw !== "string" || !idempotencyKeyRaw.trim()) {
      throw new AiMediaError("ai_media_request_invalid");
    }

    const trimmedKey = validateAiMediaIdempotencyKey(idempotencyKeyRaw);
    const capability = await canAiMediaGenerate(placeId, access.producerId);
    if (!capability.available) {
      const reason = capability.reason ?? "Penyedia AI belum tersedia atau foto sumber belum lengkap.";
      throw new AiMediaError(reason.includes("ai_media_") ? reason as AiMediaErrorCode : "ai_media_generation_locked");
    }

    const result = await createAiMediaInitialGeneration(
      actor.userId,
      placeId,
      access.producerId,
      trimmedKey,
    );

    if (result.error) {
      const message = result.error.message;
      if (typeof message === "string" && message.startsWith("ai_media_")) {
        throw new AiMediaError(message as AiMediaErrorCode);
      }
      throw new AiMediaError("ai_media_generation_failed");
    }

    return NextResponse.json(
      {
        ok: true,
        jobId: result.jobId,
        kind: "initial",
        outputs: ["hook", "place_story"],
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, private",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    if (error instanceof AiMediaError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    return NextResponse.json({ error: "ai_media_generation_failed" }, { status: 400 });
  }
}
