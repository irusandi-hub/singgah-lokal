import { NextResponse } from "next/server";
import { getPublicSupabaseClient } from "@/lib/supabase/public-client";
import { isPastLiveDurationCap } from "@/lib/live/session-service-cap";

// Public Live discovery — fully session-independent:
// - reads canonical live_sessions of published Places through the anon key
//   (sessionless client, no cookies() — safe for ISR route caching);
// - healed sessions (60-minute duration cap) are filtered by startedAt in the
//   handler and left as-is in the DB, so no privileged heal call is needed;
// - Places/stages are joined through the published-only repositories, which
//   now use the same sessionless client.
// Short-lived cache: revalidated at most every 10 seconds — at most 10 s
// behind the DB, which only affects how quickly a just-started Live appears,
// never authorization or canonical state. `dynamic` is kept only as
// belt-and-braces against accidental upstream opt-outs (revalidate wins).
export const revalidate = 10;
export const dynamic = "force-dynamic";

type LiveRow = {
  id: string;
  place_id: string;
  stage_id: string;
  started_at: string;
  viewer_peak: number;
};

// Map-first discovery feed (tech §9): canonical live_sessions of published
// Places, joined with Place metadata + Process titles from the existing
// repositories. Derived data only — never a cache/search index (AGENTS.md).
export async function GET() {
  try {
    const supabase = getPublicSupabaseClient();

    const { data: sessions, error } = await supabase
      .from("live_sessions")
      .select("id, place_id, stage_id, started_at, viewer_peak")
      .eq("status", "live")
      .order("started_at", { ascending: true });

    if (error) {
      return NextResponse.json({ error: "live_discovery_unavailable" }, { status: 500 });
    }

    const rows = (sessions ?? []) as LiveRow[];

    // Duration cap (tech §7) applied without privileged writes: sessions past
    // the locked 60-minute cap are filtered here (canonical heal still runs on
    // the authenticated Live-status path). This keeps the response identical
    // for every visitor and cacheable.
    const activeRows = rows.filter((row) => !isPastLiveDurationCap(row.started_at));

    if (activeRows.length === 0) {
      return NextResponse.json({ live: [] });
    }

    const { getPublicPlaceExperienceRepository } = await import("@/lib/place-experience-repository");
    const { getPublicProductionStoryRepository } = await import("@/lib/production-story-repository");
    const placeRepository = await getPublicPlaceExperienceRepository();
    const stageRepository = await getPublicProductionStoryRepository();

    const live = [];
    for (const row of activeRows) {
      const place = await placeRepository.getPublishedPlaceById(row.place_id);
      if (!place) continue; // unpublished Place: never shown (fail-closed visibility)
      const stage = await stageRepository.getById(row.place_id, row.stage_id, true);

      live.push({
        sessionId: row.id,
        placeId: place.id,
        placeName: place.name,
        placeArea: place.area,
        stageId: row.stage_id,
        processTitle: stage?.title ?? null,
        startedAt: row.started_at,
        viewerPeak: row.viewer_peak,
        position: null,
        latitude: place.latitude ?? null,
        longitude: place.longitude ?? null,
      });
    }

    return NextResponse.json({ live });
  } catch {
    return NextResponse.json({ error: "live_discovery_unavailable" }, { status: 500 });
  }
}
