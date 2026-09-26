import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { applyLiveDurationCap, isPastLiveDurationCap } from "@/lib/live/session-service-cap";

/**
 * Place Live status — a PERMANENT Place attribute (PO, 2026-09-26).
 *
 * LIVE is part of every Place's identity, in BOTH states:
 * - Active session (canonical `live_sessions`, status='live'): the indicator
 *   shows the current process and opens the existing /live/[sessionId] flow.
 * - No active session: the indicator stays visible and can be expanded to
 *   show the honest "Place ini sedang tidak Live." status. A session is
 *   never fabricated, and "has Live history" never becomes "is live" —
 *   only a current canonical live_sessions row renders the live state.
 *
 * The not-live status uses the native <details> element so it is
 * pressable/expandable without any client-side session logic. Opportunistic
 * duration-cap healing (tech §7) is unchanged.
 */
export async function PlaceLiveStatus({ placeId }: { placeId: string }) {
  const supabase = await createSupabaseServerClient();
  // Canonical source of truth: a live_sessions row with status='live'.
  // Reassignable: duration-cap healing may retire the session before render.
  let { data: session } = await supabase
    .from("live_sessions")
    .select("id, stage_id, started_at, viewer_peak")
    .eq("place_id", placeId)
    .eq("status", "live")
    .maybeSingle();

  // Opportunistic duration cap (tech §7): a session past the locked 60
  // minutes self-heals before being rendered as live on the Place page. A
  // healed session leaves the Place honestly not-live.
  if (session && isPastLiveDurationCap(session.started_at)) {
    const healed = await applyLiveDurationCap(session.id);
    if (healed) {
      session = null; // Cap applied: the Place shows its not-live state.
    }
  }

  if (session) {
    const stage = await (await getServerProductionStoryRepository()).getById(placeId, session.stage_id, true);

    return (
      <section className="mt-8 overflow-hidden rounded-2xl border border-live/30 bg-live/5" aria-label="Status Live Place">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-live" />
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-live">LIVE SEKARANG</p>
            </div>
            <p className="mt-1 text-lg font-semibold tracking-tight">
              {stage?.title ?? "Proses produksi"}
            </p>
            <p className="text-xs text-black/55">
              {session.viewer_peak} penonton • real-time, tidak direkam
            </p>
          </div>
          <Link
            className="inline-flex shrink-0 items-center justify-center rounded-full bg-live px-5 py-2.5 text-sm font-bold text-white"
            href={`/live/${session.id}`}
          >
            Lihat Live Sekarang
          </Link>
        </div>
      </section>
    );
  }

  // Not live — the indicator REMAINS visible as a permanent Place attribute
  // (no return null): expandable to the honest not-live status. No session
  // id is invented and past sessions never count as live.
  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-live/20 bg-white" aria-label="Status Live Place">
      <details className="group">
        <summary className="flex cursor-pointer items-center gap-2 p-5">
          <span className="h-2 w-2 rounded-full bg-live/50" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-live">
            LIVE — Tidak sedang berlangsung
          </p>
        </summary>
        <p className="border-t border-live/10 px-5 pb-5 pt-3 text-sm font-semibold text-black/65">
          Place ini sedang tidak Live.
        </p>
      </details>
    </section>
  );
}
