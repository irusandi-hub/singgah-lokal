import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  deleteLiveInput,
  isLiveInputDeleteNotFound,
  listAppLiveInputs,
  type LiveInputDeleteOutcome,
} from "@/lib/live/cloudflare";
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
 * Ended-input sweep (gap fix 3 + hardening order): ends that happened OUTSIDE
 * the service wrapper — duration-cap heal inside RPCs, the stage-unpublished
 * trigger, moderate_live — leave their provider inputs alive because only
 * Supabase state changed.
 *
 * Ordering contract (same as endLiveSession): provider delete FIRST, pointer
 * release ONLY on provider-confirmed cleanup ("deleted" or HTTP 404 =
 * already-cleaned). A failed delete keeps live_input_id set, so the session
 * stays in the list_ended_live_inputs backlog and the next sweep retries —
 * no orphan inputs. Supabase remains canonical: the RPC verifies each session
 * is actually `ended`, and re-running is idempotent (released pointers vanish
 * from the backlog).
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
      // Provider delete FIRST — the pointer must stay untouched until the
      // provider confirms the input is gone (or 404s: already-cleaned).
      const outcome: LiveInputDeleteOutcome = await deleteLiveInput(entry.liveInputId);
      if (outcome !== "deleted" && !isLiveInputDeleteNotFound(outcome)) {
        // Failed delete: keep the pointer for retry on the next sweep.
        continue;
      }
      // Provider-confirmed clean: NOW release the pointer (fail-closed RPC).
      const { error: releaseError } = await supabase.rpc("release_live_input", {
        p_session_id: entry.sessionId,
      });
      if (releaseError) {
        // Provider input is gone but the pointer release failed: the entry
        // stays in the backlog; the next sweep's delete will 404 and release.
        continue;
      }
      deleted += 1;
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

  return Boolean(data);
}
