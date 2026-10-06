import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
  requireProducerAccess,
} from "@/lib/auth/server";
import {
  AiMediaError,
  isAiMediaRegenerationUnlocked,
  REGENERATION_OUTPUT_KEYS,
  validateAiMediaIdempotencyKey,
} from "@/lib/ai-media";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * GENERATE ULANG — regeneration request.
 *
 * Architecture: present from the start. Behavior: LOCKED.
 *
 * Two independent server-side gates protect it, so the client cannot bypass it
 * with any parameter, header, or cookie:
 *  1. this route refuses while `isAiMediaRegenerationUnlocked()` is false;
 *  2. even if code changed, the `regenerate_ai_media` RPC checks the
 *     server-owned `ai_media_provider_config.regeneration_enabled` flag and
 *     refuses (`ai_media_regeneration_locked`) unless an admin enabled it.
 *
 * When eventually unlocked, a regeneration job generates BOTH outputs
 * (hook + place_story); a partial request is refused rather than half-stored.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ placeId: string }> },
) {
  try {
    const { placeId } = await params;
    const actor = await requireAuthenticatedActor(request);
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);

    // Gate 1 — locked-gate check FIRST, before any idempotent insert.
    if (!isAiMediaRegenerationUnlocked()) {
      return NextResponse.json({ error: "ai_media_regeneration_locked" }, { status: 403 });
    }

    const body = await request.json();
    if (!body || typeof body !== "object") throw new AiMediaError("ai_media_generation_locked");

    const idempotencyKey = validateAiMediaIdempotencyKey((body as { idempotencyKey?: unknown }).idempotencyKey);

    // Regeneration always covers BOTH outputs; a partial request is refused.
    const requestedOutputs = (body as { outputs?: unknown }).outputs;
    if (!Array.isArray(requestedOutputs)) throw new AiMediaError("ai_media_generation_locked");
    for (const key of REGENERATION_OUTPUT_KEYS) {
      if (!requestedOutputs.includes(key)) throw new AiMediaError("ai_media_generation_locked");
    }

    // Gate 2 — the server-only RPC re-checks the DB lock flag.
    const { data, error } = await createSupabaseServiceClient().rpc("regenerate_ai_media", {
      p_user_id: actor.userId,
      p_place_id: placeId,
      p_producer_id: access.producerId,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      const message = String(error.message);
      if (message.includes("ai_media_regeneration_locked")) {
        return NextResponse.json({ error: "ai_media_regeneration_locked" }, { status: 403 });
      }
      if (message.includes("producer_authorization_required")) {
        return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
      }
      throw new Error("ai_media_generation_failed");
    }

    return NextResponse.json({
      ok: true,
      jobId: data,
      outputs: [...REGENERATION_OUTPUT_KEYS],
      status: "queued",
    });
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

/** GET: describe the regeneration architecture without exposing a bypass. */
export async function GET() {
  return NextResponse.json({
    available: false,
    locked: true,
    reason: "Generate Ulang exists in the architecture but remains locked.",
    requiredOutputs: [...REGENERATION_OUTPUT_KEYS],
    unlockCondition: "server-side gate only; no client parameter/header/cookie may bypass it.",
  });
}
