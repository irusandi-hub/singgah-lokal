import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { applyLiveDurationCap, isPastLiveDurationCap } from "@/lib/live/session-service-cap";

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
    const supabase = await createSupabaseServerClient();

    const { data: sessions, error } = await supabase
      .from("live_sessions")
      .select("id, place_id, stage_id, started_at, viewer_peak")
      .eq("status", "live")
      .order("started_at", { ascending: true });

    if (error) {
      return NextResponse.json({ error: "live_discovery_unavailable" }, { status: 500 });
    }

    const rows = (sessions ?? []) as LiveRow[];

    // Opportunistic duration cap (tech §7): heal any session past the locked
    // 60 minutes before reporting it as live. Same pattern as /api/live/status.
    const expiredIds: string[] = [];
    for (const row of rows) {
      if (isPastLiveDurationCap(row.started_at)) {
        expiredIds.push(row.id);
      }
    }
    if (expiredIds.length > 0) {
      await Promise.all(expiredIds.map((id) => applyLiveDurationCap(id)));
    }
    const activeRows = expiredIds.length
      ? rows.filter((row) => !expiredIds.includes(row.id))
      : rows;

    if (activeRows.length === 0) {
      return NextResponse.json({ live: [] });
    }

    const { getServerPlaceExperienceRepository } = await import("@/lib/place-experience-repository");
    const { getServerProductionStoryRepository } = await import("@/lib/production-story-repository");
    const placeRepository = await getServerPlaceExperienceRepository();
    const stageRepository = await getServerProductionStoryRepository();

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
