import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerExperienceManagementRepository, getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { ExperienceInputError, parseExperienceMutation } from "@/lib/experience-management";

export async function GET(request: Request, { params }: { params: Promise<{ placeId: string; experienceId: string }> }) {
  try {
    const { placeId, experienceId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    const experience = await (await getServerExperienceManagementRepository()).getById(experienceId);
    if (!experience || experience.placeId !== placeId) return NextResponse.json({ error: "experience_not_found" }, { status: 404 });
    return NextResponse.json(experience);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "experience_unavailable" }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ placeId: string; experienceId: string }> }) {
  try {
    const { placeId, experienceId } = await params;
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    const place = await (await getServerPlaceManagementRepository()).getById(placeId);
    const repository = await getServerExperienceManagementRepository();
    const existing = await repository.getById(experienceId);
    if (!place || !existing || existing.placeId !== placeId) return NextResponse.json({ error: "experience_not_found" }, { status: 404 });
    const mutation = parseExperienceMutation(await request.json(), place, experienceId);
    if (access.role === "editor" && (mutation.durationMinutes !== existing.durationMinutes || mutation.capacity !== existing.capacity || mutation.minPartySize !== existing.minPartySize || mutation.maxPartySize !== existing.maxPartySize || mutation.ageRequirement !== existing.ageRequirement || mutation.meetingPoint !== existing.meetingPoint || JSON.stringify(mutation.schedules) !== JSON.stringify(existing.schedules))) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    return NextResponse.json(await repository.update(experienceId, mutation, access.role !== "editor"));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof ExperienceInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "experience_unavailable" }, { status: 400 });
  }
}