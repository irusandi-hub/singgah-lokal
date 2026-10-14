import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createLiveInput,
  deleteLiveInput,
  isLiveInputDeleteNotFound,
  type LiveInputDeleteOutcome,
} from "@/lib/live/cloudflare";
import { LIVE_COMMENT_MAX_LENGTH } from "@/lib/live/types";

export class LiveValidationError extends Error {}
export class LiveBoundaryUnavailableError extends Error {}

type SessionRow = {
  id: string;
  place_id: string;
  producer_id: string;
  stage_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  end_note: string | null;
  viewer_peak: number;
};

/**
 * A-02 (migration 0052): `live_input_id` and `idempotency_key` are no longer
 * SELECT-granted to anon/authenticated, so every caller-session read must name
 * the safe columns explicitly. Provider-sensitive reads go through the server's
 * service-role connection instead (never through the caller's RLS session).
 */
const LIVE_SESSION_SAFE_COLUMNS =
  "id, place_id, producer_id, stage_id, status, started_at, ended_at, ended_reason, end_note, viewer_peak";

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
  idempotencyKey: string;
  reason?: "producer_ended";
  note?: string;
}): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  if (!params.idempotencyKey.trim()) {
    throw new LiveValidationError("live_end_idempotency_key_required");
  }

  const { data, error } = await supabase.rpc("end_live_session", {
    p_session_id: params.sessionId,
    p_idempotency_key: params.idempotencyKey,
    p_reason: params.reason ?? "producer_ended",
    p_note: params.note ?? null,
  });

  if (error) {
    if (String(error.message).includes("producer_authorization_required")) throw new LiveValidationError("producer_authorization_required");
    throw new LiveValidationError("live_end_failed");
  }

  // Provider cleanup (gap fix 3, hardening order): the provider delete MUST
  // happen BEFORE release_live_input. The release RPC nulls the pointer, so it
  // is the last remaining retry handle for a failed cleanup — deleting the
  // input first, and only then releasing the pointer, keeps a failed provider
  // delete retryable by the ended-input sweep (PO item 10 fail-safe).
  //
  // HTTP 404 from the provider means the input is already gone — treated as
  // already-cleaned, so the pointer is released. Any other failure keeps the
  // pointer for retry/sweep. Supabase stays canonical; a cleanup miss never
  // affects the committed session state (best-effort, fail-safe).
  try {
    // Pointer probe: the release RPC itself nulls live_input_id, so reading the
    // pointer through the canonical row keeps the probe side-effect free. A-02:
    // live_input_id is server-side only (no client column grant), so the probe
    // runs on the SERVICE-ROLE connection — the same infrastructure connection
    // that later calls release_live_input. The ended-state filter is kept, so
    // the probe can never touch a session that is still live.
    const { data: rows } = await createSupabaseServiceClient()
      .from("live_sessions")
      .select("id, live_input_id")
      .eq("id", params.sessionId)
      .eq("status", "ended")
      .limit(1);

    const inputId = (rows as Array<{ live_input_id: string | null }> | null)?.[0]?.live_input_id ?? null;
    if (!inputId) {
      // Nothing releasable via the pointer (not ended, hidden, or already
      // released). Nothing to clean up here — the sweep remains the backstop.
      return Boolean(data);
    }

    // Pointer intact — provider delete FIRST.
    const outcome: LiveInputDeleteOutcome = await deleteLiveInput(inputId);
    if (outcome === "deleted" || isLiveInputDeleteNotFound(outcome)) {
      // Provider confirmed clean (deleted, or 404 = already-cleaned): NOW
      // release the pointer via the fail-closed ended-state RPC. A-03: the
      // release RPC is service-role only (server infrastructure), so this
      // call opens a service connection instead of riding the caller's
      // session — the sweep remains the backstop on any failure.
      await createSupabaseServiceClient().rpc("release_live_input", {
        p_session_id: params.sessionId,
      });
    }
    // outcome === "failed": pointer stays; the ended-input sweep retries later.
  } catch {
    // Best-effort: the sweep covers any release/cleanup miss; the pointer
    // stays in the backlog for the next sweep when a delete failed.
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

/**
 * Viewer presence heartbeat (A-04, migration 0053).
 *
 * Renews THIS caller's presence lease on the session it is already admitted to,
 * so a viewer who keeps watching keeps counting toward the 100-concurrent cap
 * and keeps receiving the private Realtime channel — instead of silently
 * dropping out of the count five minutes after admission.
 *
 * Fail-closed: the server derives the actor from the session (auth.uid()); the
 * RPC refuses an anonymous caller, a session that is no longer live, and any
 * caller with no admitted ledger row for that session. This is presence only —
 * admission still goes through admitLiveViewer's full gate.
 */
export async function touchLiveViewerPresence(params: { sessionId: string }): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("touch_live_viewer_presence", {
    p_session_id: params.sessionId,
  });

  if (error) {
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

  // A-09: the ~1/5s per-viewer window is enforced by `post_live_comment`
  // against the SHARED `live_comment_rate_limits` store (migration 0054), so it
  // is identical across every server instance — there is deliberately NO
  // process-memory limiter here, and nothing in this module keeps request
  // state between calls.
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("post_live_comment", {
    p_session_id: params.sessionId,
    p_body: params.body,
  });

  if (error) {
    if (String(error.message).includes("live_comment_rate_limited")) throw new LiveValidationError("live_comment_rate_limited");
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
  // A-02: explicit safe columns — a `select *` would (correctly) fail on the
  // non-granted provider columns for anon/authenticated callers.
  const { data } = await supabase
    .from("live_sessions")
    .select(LIVE_SESSION_SAFE_COLUMNS)
    .eq("id", sessionId)
    .maybeSingle();
  return (data as SessionRow | null) ?? null;
}

/**
 * Provider-input pointer (A-02): server-side only. Reads live_input_id on the
 * service-role connection, so playback signing and publish-URL re-issuance keep
 * working while the column stays invisible to every client role. Callers must
 * have completed their own authorization/visibility checks first — this helper
 * authorizes nothing by itself.
 */
export async function getLiveSessionInputId(sessionId: string): Promise<string | null> {
  const { data } = await createSupabaseServiceClient()
    .from("live_sessions")
    .select("id, live_input_id")
    .eq("id", sessionId)
    .maybeSingle();
  return ((data as { live_input_id: string | null } | null)?.live_input_id) ?? null;
}

export async function listLiveSessionsForPlace(placeId: string): Promise<SessionRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("live_sessions")
    .select(LIVE_SESSION_SAFE_COLUMNS)
    .eq("place_id", placeId)
    .order("started_at", { ascending: false })
    .limit(10);
  return (data as SessionRow[] | null) ?? [];
}
