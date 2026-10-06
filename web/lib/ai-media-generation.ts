import "server-only";

import {
  validateAiMediaPromptKey,
  validateAiMediaPromptVersion,
  type AiMediaOutputKey,
} from "@/lib/ai-media";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA GENERATION METADATA — the server-only worker path that attaches
 * prompt/version tracking and request metadata to a generation job and/or a
 * saved output (migration 0044).
 *
 * This is the provider-neutral half of a generation run: it records WHICH prompt
 * revision was used and the request context, so an output is reproducible and
 * explainable. It performs NO generation and invokes NO provider — a real
 * provider worker calls this AFTER it has produced real files (and after
 * `save_ai_media_output` persisted them as a draft).
 *
 * The write goes through the server-only `record_ai_media_generation_metadata`
 * RPC; no client role can execute it.
 */

export type AiMediaGenerationMetadataInput = {
  /** The generation job to annotate (optional when an output is annotated). */
  jobId?: string | null;
  /** Required when annotating a saved output. */
  placeId?: string | null;
  producerId?: string | null;
  outputKey?: AiMediaOutputKey | null;
  promptKey?: string | null;
  promptVersion?: number | null;
  requestMetadata?: Record<string, unknown>;
};

export type AiMediaGenerationMetadataResult = { recorded: boolean };

export async function recordAiMediaGenerationMetadata(
  input: AiMediaGenerationMetadataInput,
): Promise<AiMediaGenerationMetadataResult> {
  if (!input.jobId && !input.outputKey) return { recorded: false };
  if (input.promptKey != null && !validateAiMediaPromptKey(input.promptKey)) return { recorded: false };
  if (input.promptVersion != null && !validateAiMediaPromptVersion(input.promptVersion)) return { recorded: false };
  if (input.outputKey && (!input.placeId || !input.producerId)) return { recorded: false };

  try {
    const { error } = await createSupabaseServiceClient().rpc("record_ai_media_generation_metadata", {
      p_job_id: input.jobId ?? null,
      p_place_id: input.placeId ?? null,
      p_producer_id: input.producerId ?? null,
      p_output_key: input.outputKey ?? null,
      p_prompt_key: input.promptKey ?? null,
      p_prompt_version: input.promptVersion ?? null,
      p_request_metadata: input.requestMetadata ?? {},
    });
    if (error) {
      console.error("ai_media_generation_metadata_unavailable", String(error.message));
      return { recorded: false };
    }
    return { recorded: true };
  } catch (error) {
    console.error("ai_media_generation_metadata_unavailable", error instanceof Error ? error.message : String(error));
    return { recorded: false };
  }
}
