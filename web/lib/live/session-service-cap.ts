import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
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
