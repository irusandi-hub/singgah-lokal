import { NextResponse } from "next/server";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";

export async function GET() {
  try {
    const repository = await getServerPlaceExperienceRepository();
    return NextResponse.json(await repository.listPublishedPlaces());
  } catch {
    return NextResponse.json({ error: "Places could not be loaded" }, { status: 500 });
  }
}
