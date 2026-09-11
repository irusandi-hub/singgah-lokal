import { NextResponse } from "next/server";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";

export async function GET(_request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId } = await params;
    const place = await (await getServerPlaceExperienceRepository()).getPublishedPlaceById(placeId);
    if (!place) return NextResponse.json({ error: "place_not_found" }, { status: 404 });
    return NextResponse.json(await (await getServerProductionStoryRepository()).listForPlace(placeId, true));
  } catch {
    return NextResponse.json({ error: "production_story_unavailable" }, { status: 500 });
  }
}
