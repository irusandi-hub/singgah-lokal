import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { applyLiveDurationCap, isPastLiveDurationCap } from "@/lib/live/session-service-cap";

/**
 * Place Live status (policy §9): "Live status + current Process +
 * Lihat Live Sekarang (when a Live is active)". Additive to the Place page —
 * the locked Place flow (Place → Dari Sini → Experience → SINGGAH → Visit
 * Intent) is not reordered or modified.
 */
export async function PlaceLiveStatus({ placeId }: { placeId: string }) {
  const supabase = await createSupabaseServerClient();
  const { data: session } = await supabase
    .from("live_sessions")
    .select("id, stage_id, started_at, viewer_peak")
    .eq("place_id", placeId)
    .eq("status", "live")
    .maybeSingle();

  if (!session) {
    return null; // No active Live: the Place page stays exactly as before.
  }

  // Opportunistic duration cap (tech §7): a session past the locked 60
  // minutes self-heals before being rendered as live on the Place page.
  if (isPastLiveDurationCap(session.started_at)) {
    const healed = await applyLiveDurationCap(session.id);
    if (healed) {
      return null; // Cap applied: the Place page returns to its pre-Live state.
    }
  }

  const stage = await (await getServerProductionStoryRepository()).getById(placeId, session.stage_id, true);

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-[#b3261e]/30 bg-[#b3261e]/5" aria-label="Status Live Place">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#b3261e]" />
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#b3261e]">LIVE SEKARANG</p>
          </div>
          <p className="mt-1 text-lg font-black tracking-tight">
            {stage?.title ?? "Proses produksi"}
          </p>
          <p className="text-xs text-black/55">
            {session.viewer_peak} penonton • real-time, tidak direkam
          </p>
        </div>
        <Link
          className="inline-flex shrink-0 items-center justify-center rounded-full bg-[#b3261e] px-5 py-2.5 text-sm font-bold text-white"
          href={`/live/${session.id}`}
        >
          Lihat Live Sekarang
        </Link>
      </div>
    </section>
  );
}
