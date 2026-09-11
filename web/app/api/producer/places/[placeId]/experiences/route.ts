import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerExperienceManagementRepository, getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { ExperienceInputError, parseExperienceMutation } from "@/lib/experience-management";

export async function GET(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    return NextResponse.json(await (await getServerExperienceManagementRepository()).listForPlace(placeId));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "experience_unavailable" }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    const place = await (await getServerPlaceManagementRepository()).getById(placeId);
    if (!place) return NextResponse.json({ error: "place_not_found" }, { status: 404 });
    const mutation = parseExperienceMutation(await request.json(), place);
    return NextResponse.json(await (await getServerExperienceManagementRepository()).create(mutation, placeId), { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof ExperienceInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "experience_unavailable" }, { status: 400 });
  }
}