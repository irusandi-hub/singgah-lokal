import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createLiveInput, deleteLiveInput } from "@/lib/live/cloudflare";
import {
  LIVE_COMMENT_MAX_LENGTH,
  LIVE_COMMENT_MIN_INTERVAL_MS,
} from "@/lib/live/types";

export class LiveValidationError extends Error {}
export class LiveBoundaryUnavailableError extends Error {}

type SessionRow = {
  id: string;
  place_id: string;
  producer_id: string;
  stage_id: string;
  status: string;
  live_input_id: string | null;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  end_note: string | null;
  viewer_peak: number;
};

/**
 * Per-viewer comment rate limiting (tech §6, TUNABLE ~1/5s).
 * Server process memory is acceptable for Phase 2 single-runtime deployments;
 * a shared store (e.g. Upstash) is the TUNABLE upgrade path for multi-instance.
 */
const commentTimestamps = new Map<string, number[]>();

function enforceCommentRateLimit(viewerKey: string): void {
  const now = Date.now();
  const timestamps = (commentTimestamps.get(viewerKey) ?? []).filter(
    (timestamp) => now - timestamp < LIVE_COMMENT_MIN_INTERVAL_MS,
  );

  if (timestamps.length >= 1) {
    throw new LiveValidationError("live_comment_rate_limited");
  }

  timestamps.push(now);
  commentTimestamps.set(viewerKey, timestamps);

  if (commentTimestamps.size > 10_000) {
    for (const [key, stamps] of commentTimestamps) {
      if (stamps.every((timestamp) => now - timestamp >= LIVE_COMMENT_MIN_INTERVAL_MS)) {
        commentTimestamps.delete(key);
      }
    }
  }
}

export type StartLiveSessionResult = {
  sessionId: string;
  replayed: boolean;
  /** Secret-bearing WHIP publish URL — Producer-only start response. */
  webRtcPublishUrl: string | null;
};

/**
 * Start a Live session (tech §4.2, amended §5 for WebRTC/WHIP): fail-closed
 * order is membership -> eligibility -> published stage -> caps -> provider
 * input -> single-transaction RPC commit. Provider failure persists nothing.
 * The WHIP publish URL is issued ONLY in the Producer's own start response —
 * never persisted, never logged (secret-bearing per provider docs).
 */
export async function startLiveSession(params: {
  placeId: string;
  stageId: string;
  idempotencyKey: string;
  actorKey: string;
}): Promise<StartLiveSessionResult> {
  const supabase = await createSupabaseServerClient();

  const liveInput = await createLiveInput();
  if (!liveInput) {
    // Fail closed: without a provider input (incl. missing credentials) no
    // session is persisted. B4 blocker: requires CLOUDFLARE_* env vars.
    throw new LiveBoundaryUnavailableError("live_boundary_unavailable");
  }

  const { data, error } = await supabase.rpc("start_live_session", {
    p_place_id: params.placeId,
    p_stage_id: params.stageId,
    p_idempotency_key: params.idempotencyKey,
    p_live_input_id: liveInput.liveInputId,
  });

  if (error) {
    // Orphan handling (PO item 10): the provider input exists but no session
    // committed — delete it so no orphaned inputs accumulate.
    await deleteLiveInput(liveInput.liveInputId);
    if (String(error.message).includes("live_cap_denied")) throw new LiveValidationError("live_cap_denied");
    if (String(error.message).includes("live_place_busy")) throw new LiveValidationError("live_place_busy");
    if (String(error.message).includes("live_not_eligible")) throw new LiveValidationError("live_not_eligible");
    if (String(error.message).includes("live_stage_not_published")) throw new LiveValidationError("live_stage_not_published");
    if (String(error.message).includes("producer_authorization_required")) throw new LiveValidationError("producer_authorization_required");
    if (String(error.message).includes("live_start_busy")) throw new LiveValidationError("live_start_busy");
    throw new LiveValidationError("live_start_failed");
  }

  const result = data as { sessionId?: string; replayed?: boolean };
  if (!result?.sessionId) {
    await deleteLiveInput(liveInput.liveInputId);
    throw new LiveValidationError("live_start_failed");
  }

  // Orphan handling on replay (gap fix 2): a replayed/concurrent replay of the
  // same idempotency key keeps the ORIGINAL session's input — the input minted
  // for this call would otherwise leak. Delete it; never overwrite the original
  // session's pointer.
  if (result.replayed) {
    await deleteLiveInput(liveInput.liveInputId);
  }

  return {
    sessionId: result.sessionId,
    replayed: Boolean(result.replayed),
    // Secret-bearing WHIP URL: Producer-only, this response only. A replay
    // intentionally returns null — re-issue via the publish-url route.
    webRtcPublishUrl: result.replayed ? null : liveInput.webRtcPublishUrl,
  };
}

export async function endLiveSession(params: {
  sessionId: string;
  actorKey: string;
  reason?: "producer_ended";
  note?: string;
}): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("end_live_session", {
    p_session_id: params.sessionId,
    p_reason: params.reason ?? "producer_ended",
    p_note: params.note ?? null,
  });

  if (error) {
    if (String(error.message).includes("producer_authorization_required")) throw new LiveValidationError("producer_authorization_required");
    throw new LiveValidationError("live_end_failed");
  }

  // Provider cleanup (gap fix 3): delete the live input after the end commit.
  // release_live_input verifies the session is ended (fail closed), nulls the
  // pointer, and hands back the input id — Supabase stays canonical; provider
  // deletion is best-effort and retried by the ended-input sweep on failure.
  try {
    const { data: inputId, error: releaseError } = await supabase.rpc("release_live_input", {
      p_session_id: params.sessionId,
    });
    if (!releaseError && typeof inputId === "string" && inputId.length > 0) {
      await deleteLiveInput(inputId);
    }
  } catch {
    // Best-effort: the sweep covers any release/cleanup miss.
  }

  return Boolean(data);
}

export async function admitLiveViewer(params: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  // Aligned with the migration (gap fix 1): the RPC takes only the session id.
  // Idempotency is preserved inside the RPC (upsert on (live_session_id,
  // user_id) refreshes the presence window without duplicating ledger rows).
  const { error } = await supabase.rpc("admit_live_viewer", {
    p_session_id: params.sessionId,
  });

  if (error) {
    if (String(error.message).includes("live_capacity_full")) throw new LiveValidationError("live_capacity_full");
    if (String(error.message).includes("live_session_not_live")) throw new LiveValidationError("live_session_not_live");
    throw new LiveValidationError("live_viewer_denied");
  }

  return true;
}

export async function postLiveComment(params: {
  sessionId: string;
  userId: string;
  body: string;
}): Promise<void> {
  if (params.body.length > LIVE_COMMENT_MAX_LENGTH) {
    throw new LiveValidationError("live_comment_too_long");
  }

  enforceCommentRateLimit(`${params.sessionId}:${params.userId}`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("post_live_comment", {
    p_session_id: params.sessionId,
    p_body: params.body,
  });

  if (error) {
    if (String(error.message).includes("live_session_not_live")) throw new LiveValidationError("live_session_not_live");
    throw new LiveValidationError("live_viewer_denied");
  }
}

export async function submitLiveReport(params: {
  sessionId: string;
  reporterId: string;
  category: string;
  note?: string;
  commentRef?: string;
}): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("submit_live_report", {
    p_session_id: params.sessionId,
    p_category: params.category,
    p_note: params.note ?? null,
    p_comment_ref: params.commentRef ?? null,
  });

  if (error) {
    throw new LiveValidationError("live_report_failed");
  }

  return (data as string | null) ?? null;
}

export async function getLiveSession(sessionId: string): Promise<SessionRow | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("live_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

export async function listLiveSessionsForPlace(placeId: string): Promise<SessionRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("live_sessions")
    .select("*")
    .eq("place_id", placeId)
    .order("started_at", { ascending: false })
    .limit(10);
  return (data as SessionRow[] | null) ?? [];
}
