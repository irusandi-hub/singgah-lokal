import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { applyLiveDurationCap, sweepEndedLiveInputs } from "@/lib/live/session-service-cap";

export const dynamic = "force-dynamic";

// Public Live status for Map/Place discovery (tech §9). Derived data from
// canonical Supabase live_sessions of published Places — never a cache or
// search index (AGENTS.md). Sessions past the 60-minute cap are self-healed
// before being reported as live.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();

    const { data: sessions, error } = await supabase
      .from("live_sessions")
      .select("id, place_id, producer_id, stage_id, status, started_at, viewer_peak")
      .eq("status", "live")
      .order("started_at", { ascending: true });

    if (error) {
      return NextResponse.json({ error: "live_status_unavailable" }, { status: 500 });
    }

    const rows = sessions ?? [];

    // Opportunistic duration cap: apply the self-healing sweeper for any
    // session past its 60-minute cap before reporting it as live.
    const expiredIds: string[] = [];
    for (const row of rows) {
      const startedAt = new Date(row.started_at).getTime();
      if (Number.isFinite(startedAt) && Date.now() - startedAt >= 60 * 60 * 1000) {
        expiredIds.push(row.id);
      }
    }
    if (expiredIds.length > 0) {
      await Promise.all(expiredIds.map((id) => applyLiveDurationCap(id)));
    }

    // Gap fix 3: ends that happened OUTSIDE the service wrapper — duration-cap
    // heal inside RPCs, the stage-unpublished trigger, moderation end — leave
    // their provider inputs alive. Sweep the release backlog on every status
    // poll (best-effort, idempotent; covers all three paths unconditionally).

    await sweepEndedLiveInputs().catch(() => 0);

    const live = expiredIds.length
      ? rows.filter((row) => !expiredIds.includes(row.id))
      : rows;

    return NextResponse.json({
      // Locked global cap context for clients (informational only).
      globalActiveLimit: 5,
      live: live.map((row) => ({
        sessionId: row.id,
        placeId: row.place_id,
        stageId: row.stage_id,
        startedAt: row.started_at,
        viewerPeak: row.viewer_peak,
      })),
    });
  } catch {
    return NextResponse.json({ error: "live_status_unavailable" }, { status: 500 });
  }
}
