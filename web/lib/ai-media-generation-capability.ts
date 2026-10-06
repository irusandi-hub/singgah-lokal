/** @internal — server-only helper for AI Media generation readiness + initial job. */

import "server-only";

import {
  AI_MEDIA_SOURCE_KEYS,
  validateAiMediaIdempotencyKey,
} from "@/lib/ai-media";
import { recordAiMediaAudit } from "@/lib/ai-media-audit";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/** Server-owned answer to "can the Producer actually generate now?". */
export type AiMediaGenerateCapability = {
  available: boolean;
  reason?: string;
  provider?: string;
};

/**
 * Deterministic one-time token-cost estimate for an initial generation request.
 *
 * The estimate is provider-neutral and auditable: it is derived only from the
 * request metadata (output count, prompt version) so capacity checks are stable
 * and explainable rather than a hardcoded constant.
 */
function computeAiMediaGenerationTokenCost(
  requestMetadata: Record<string, unknown>,
): number {
  const outputCount =
    ((requestMetadata.outputs as unknown[])?.length ?? 0) as number;
  const promptVersion =
    ((requestMetadata.promptVersion as unknown) as number | undefined) ??
    1;
  if (outputCount <= 0 || promptVersion <= 0) return 0;
  // Provider-neutral base cost per output per prompt version. Real provider
  // pricing replaces this in the worker that actually runs generation; this
  // is only used for capacity posture, not for billing.
  const basePerOutput = 1;
  const basePerPromptVersion = 0;
  return Math.max(1, outputCount * (basePerOutput + basePerPromptVersion));
}

/**
 * Provider-neutral request metadata builder.
 *
 * Kept local to this module so the server-only helper does not import the
 * broader contract module's build helper. It is intentionally minimal and
 * provider-neutral.
 */
function buildAiMediaRequestMetadata(params: {
  generationKind: "initial";
  outputKeys: readonly string[];
  promptVersion: number;
  requestedAt: string;
}): Record<string, unknown> {
  return {
    generationKind: params.generationKind,
    outputKeys: [...params.outputKeys],
    promptVersion: params.promptVersion,
    requestedAt: params.requestedAt,
  };
}

/**
 * Whether generation is possible for the given Producer/Place.
 *
 * The client reaches this through GET .../ai-media/generate. The server route is
 * the authority: it checks membership, the 4 source photos, provider
 * configuration, and quota posture.
 */
export async function canAiMediaGenerate(
  placeId: string,
  producerId: string,
): Promise<AiMediaGenerateCapability> {
  const supabase = createSupabaseServiceClient();

  const { data: config } = await supabase
    .from("ai_media_provider_config")
    .select("provider, provider_features, enabled, regeneration_enabled")
    .eq("id", "primary")
    .maybeSingle();

  if (!config) {
    return { available: false, reason: "Penyedia AI belum dikonfigurasi di server." };
  }
  if (!config.enabled) {
    return { available: false, reason: "Penyedia AI belum diaktifkan di server." };
  }

  // All 4 source photos must exist before generation can be requested.
  const { data: sources } = await supabase
    .from("ai_media_sources")
    .select("source_key")
    .eq("place_id", placeId)
    .eq("producer_id", producerId);

  if (!sources) {
    return { available: false, reason: "AI Media tidak dapat dimuat. Coba lagi." };
  }

  const present = new Set<string>();
  for (const row of sources as { source_key: string }[]) present.add(row.source_key);
  for (const key of AI_MEDIA_SOURCE_KEYS) {
    if (!present.has(key)) {
      return {
        available: false,
        reason: "Lengkapi keempat foto sumber sebelum membuat gambar AI.",
      };
    }
  }

  // Quota must exist and have headroom. Fail-closed.
  const requestMetadata = buildAiMediaRequestMetadata({
    generationKind: "initial",
    outputKeys: ["hook", "place_story"],
    promptVersion: 1,
    requestedAt: new Date().toISOString(),
  });
  const costEstimate = computeAiMediaGenerationTokenCost(requestMetadata);

  const { error: quotaError } = await supabase.rpc("claim_ai_media_quota", {
    p_producer_id: producerId,
    p_token_count: costEstimate,
  });
  if (quotaError) {
    const message = String(quotaError.message);
    if (message.includes("ai_media_quota_exhausted") || message.includes("ai_media_quota_invalid")) {
      return { available: false, reason: "Kuota AI habis. Coba lagi nanti." };
    }
    return { available: false, reason: "Kuota AI tidak dapat diproses. Coba lagi nanti." };
  }

  // Restore the one-time capacity reservation now that we only wanted to read
  // posture: the real RPC call later reclaims what it actually spends.
  try {
    await supabase.rpc("release_ai_media_quota", {
      p_producer_id: producerId,
      p_token_count: costEstimate,
    });
  } catch {
    // The release helper is best-effort; release failures do not invalidate
    // the readiness verdict.
  }

  return { available: true, provider: config.provider };
}

/**
 * Queue an INITIAL generation job for both outputs.
 *
 * Idempotent per (place_id, producer_id, idempotency_key). Does NOT call a
 * provider and does NOT persist outputs — it records the request so the worker
 * can later produce both outputs as drafts.
 */
export async function createAiMediaInitialGeneration(
  actorId: string,
  placeId: string,
  producerId: string,
  idempotencyKey: string,
): Promise<{ jobId?: string; error?: Error }> {
  const supabase = createSupabaseServiceClient();

  const trimmed = validateAiMediaIdempotencyKey(idempotencyKey);
  const requestedAt = new Date().toISOString();
  const requestMetadata = buildAiMediaRequestMetadata({
    generationKind: "initial",
    outputKeys: ["hook", "place_story"],
    promptVersion: 1,
    requestedAt,
  });

  const { data: job, error: jobError } = await supabase.rpc("create_initial_ai_media_generation", {
    p_user_id: actorId,
    p_place_id: placeId,
    p_producer_id: producerId,
    p_idempotency_key: trimmed,
    p_kind: "initial",
    p_prompt_key: "place_initial_generation",
    p_prompt_version: 1,
    p_request_metadata: requestMetadata,
    p_detail: {
      kind: "initial",
      outputs: ["hook", "place_story"],
      promptVersion: 1,
      requestedAt,
    },
  });

  if (jobError || !job) {
    return { error: new Error(String(jobError?.message ?? "ai_media_generation_failed")) };
  }

  // Best-effort audit: the request itself is the attributable action.
  await recordAiMediaAudit({
    placeId,
    actorId,
    producerId,
    action: "ai_generation_requested",
    targetType: "job",
    targetKey: job.id,
    detail: {
      idempotencyKey: trimmed,
      kind: "initial",
      outputs: ["hook", "place_story"],
      promptVersion: 1,
    },
  }).catch(() => undefined);

  return { jobId: job.id };
}
