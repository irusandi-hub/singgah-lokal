import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerExperienceManagementRepository, getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { canTransitionExperienceStatus, type Experience } from "@/lib/experiences";
import { ExperienceInputError, parseExperienceStatus, validateExperiencePublication } from "@/lib/experience-management";
import { canPublishExperience } from "@/lib/producer";

export async function PATCH(request: Request, { params }: { params: Promise<{ placeId: string; experienceId: string }> }) {
  try {
    const { placeId, experienceId } = await params;
    const access = await requireProducerAccess(request, placeId, ["owner", "manager"]);
    const body = await request.json() as { status?: unknown };
    const nextStatus = parseExperienceStatus(body.status);
    const place = await (await getServerPlaceManagementRepository()).getById(placeId);
    const repository = await getServerExperienceManagementRepository();
    const existing = await repository.getById(experienceId);
    if (!place || !existing || !canPublishExperience(access, placeId, existing.placeId, place.producer?.id)) {
      return NextResponse.json({ error: "experience_not_found" }, { status: 404 });
    }
    if (!canTransitionExperienceStatus(existing.status, nextStatus)) return NextResponse.json({ error: "experience_status_transition_invalid" }, { status: 400 });
    if (nextStatus === "published") validateExperiencePublication(existing);
    const publicationStatus: Experience["publicationStatus"] = nextStatus === "published" ? "published" : "draft";
    return NextResponse.json(await repository.updateStatus(experienceId, placeId, nextStatus, publicationStatus));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof ExperienceInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "experience_unavailable" }, { status: 400 });
  }
}