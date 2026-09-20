import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { LiveSessionEndReason, LiveSessionStatus } from "@/lib/live/types";

/**
 * Live status over Realtime (tech §6): status/presence/comments — never video.
 * Broadcast on the session's channel so connected viewers learn of an ended
 * Live without polling. Status stays canonical in Supabase; this event is a
 * display signal only (tech §6: Realtime is never the source of truth).
 */
export async function broadcastLiveStatus(params: {
  sessionId: string;
  status: LiveSessionStatus;
  endedReason: LiveSessionEndReason | null;
}): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    const channel = supabase.channel(`live_session:${params.sessionId}`, { config: { private: true } });
    await channel.send({
      type: "broadcast",
      event: "status",
      payload: {
        event: "status",
        sessionId: params.sessionId,
        status: params.status,
        endedReason: params.endedReason,
      },
    });
    await channel.unsubscribe();
  } catch {
    // Display signal only: a broadcast failure never affects canonical state
    // (which is already committed in Supabase) and never fails the end flow.
  }
}
