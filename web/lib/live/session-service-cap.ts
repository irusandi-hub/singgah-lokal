import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { deleteLiveInput, listAppLiveInputs } from "@/lib/live/cloudflare";
import { broadcastLiveStatus } from "@/lib/live/realtime";
import { LIVE_DURATION_CAP_MINUTES } from "@/lib/live/types";

/**
 * True when a live session's start time is past the locked 60-minute cap
 * (tech §7). Shared by the opportunistic self-heal call sites (status route,
 * discovery route, Place Live strip) so cap math exists in exactly one place.
 */
export function isPastLiveDurationCap(startedAt: string, now: number = Date.now()): boolean {
  const startedAtMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return false;
  return now - startedAtMs >= LIVE_DURATION_CAP_MINUTES * 60 * 1000;
}

/**
 * Orphan sweep (PO item 10): provider inputs created by failed/never-committed
 * starts are deleted. An input is an orphan when it is not referenced by any
 * live/ended session and is stale (never connected within the threshold).
 * Best-effort: a sweep failure never affects canonical session state.
 */
export async function sweepOrphanLiveInputs(): Promise<number> {
  const inputs = await listAppLiveInputs();
  if (!inputs) {
    return 0; // Boundary unavailable (incl. B4): nothing to sweep.
  }

  const supabase = await createSupabaseServerClient();
  const { data: referenced } = await supabase
    .from("live_sessions")
    .select("live_input_id")
    .not("live_input_id", "is", null);
  const referencedIds = new Set((referenced ?? []).map((row) => row.live_input_id as string));

  let deleted = 0;
  for (const input of inputs) {
    // A never-connected input with no session reference is an orphan once
    // past the TUNABLE sweep threshold (stale starts, provider "null" status).
    if (!referencedIds.has(input.uid) && input.status === null) {
      if (await deleteLiveInput(input.uid)) {
        deleted += 1;
      }
    }
  }
  return deleted;
}

/**
 * Ended-input sweep (gap fix 3): ends that happened OUTSIDE the service
 * wrapper — duration-cap heal inside RPCs, the stage-unpublished trigger,
 * moderate_live — leave their provider inputs alive because only Supabase
 * state changed. This sweep releases and deletes those inputs. Supabase
 * remains canonical: the RPC verifies each session is actually `ended`, and
 * re-running is idempotent (released pointers vanish from the backlog).
 */
export async function sweepEndedLiveInputs(): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_ended_live_inputs");
  if (error || !Array.isArray(data)) {
    return 0;
  }

  let deleted = 0;
  for (const entry of data as Array<{ sessionId?: string; liveInputId?: string }>) {
    if (!entry.sessionId || !entry.liveInputId) continue;
    try {
      const { data: inputId, error: releaseError } = await supabase.rpc("release_live_input", {
        p_session_id: entry.sessionId,
      });
      if (releaseError || typeof inputId !== "string" || inputId.length === 0) continue;
      if (await deleteLiveInput(inputId)) {
        deleted += 1;
      }
    } catch {
      // Best-effort; the pointer stays in the backlog for the next sweep.
    }
  }
  return deleted;
}

/**
 * Applies the 60-minute self-healing duration cap (tech §7) by invoking the
 * security-definer RPC. Returns true when a session was ended by this call.
 */
export async function applyLiveDurationCap(sessionId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("apply_live_duration_cap", {
    p_session_id: sessionId,
  });

  if (error) {
    return false;
  }

  if (Boolean(data)) {
    // Realtime status event (tech §6): ended via the 60-minute cap.
    await broadcastLiveStatus({
      sessionId,
      status: "ended",
      endedReason: "duration_cap",
    });
  }

  return Boolean(data);
}
