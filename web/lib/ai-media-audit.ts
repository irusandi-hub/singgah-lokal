import "server-only";

import { type AiMediaAuditAction, type AiMediaAuditTargetType } from "@/lib/ai-media";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * AI MEDIA AUDIT WRITER — the single server-side path that records an AI media
 * action into the append-only `ai_media_audit` trail (migration 0043).
 *
 * The table itself is write-once (a trigger refuses UPDATE/DELETE for every
 * writer) and client-inaccessible (RLS on, zero policies, privileges revoked);
 * the only write path is the server-only `record_ai_media_audit` RPC, called
 * here with the SESSION-derived actor id — never a client-supplied identity.
 *
 * FAILURE ISOLATION: an audit write is never allowed to roll back a valid AI
 * media action (a stored source, a completed approval), but it is never silent
 * either — a failure is logged. The caller receives `recorded: false` so a
 * route can decide whether to surface it.
 */

export type AiMediaAuditInput = {
  placeId: string;
  actorId: string;
  action: AiMediaAuditAction;
  producerId?: string | null;
  targetType?: AiMediaAuditTargetType | null;
  targetKey?: string | null;
  jobId?: string | null;
  detail?: Record<string, unknown>;
};

export type AiMediaAuditResult = { recorded: boolean };

export async function recordAiMediaAudit(input: AiMediaAuditInput): Promise<AiMediaAuditResult> {
  if (!input.placeId || !input.actorId || !input.action) {
    // An unattributable action is never recorded anonymously.
    console.error("ai_media_audit_actor_required");
    return { recorded: false };
  }

  try {
    const { error } = await createSupabaseServiceClient().rpc("record_ai_media_audit", {
      p_place_id: input.placeId,
      p_actor_id: input.actorId,
      p_action: input.action,
      p_producer_id: input.producerId ?? null,
      p_target_type: input.targetType ?? null,
      p_target_key: input.targetKey ? String(input.targetKey).slice(0, 200) : null,
      p_job_id: input.jobId ?? null,
      p_detail: input.detail ?? {},
    });
    if (error) {
      console.error("ai_media_audit_unavailable", String(error.message));
      return { recorded: false };
    }
    return { recorded: true };
  } catch (error) {
    console.error("ai_media_audit_unavailable", error instanceof Error ? error.message : String(error));
    return { recorded: false };
  }
}
