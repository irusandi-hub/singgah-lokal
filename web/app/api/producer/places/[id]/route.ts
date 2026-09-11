import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { parsePlaceMutation, PlaceInputError } from "@/lib/place-management";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireProducerAccess(request, id, ["owner", "manager", "editor"]);
    const place = await (await getServerPlaceManagementRepository()).getById(id);
    return place ? NextResponse.json(place) : NextResponse.json({ error: "place_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "place_unavailable" }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await requireProducerAccess(request, id, ["owner", "manager", "editor"]);
    const mutation = parsePlaceMutation(await request.json(), id);
    const repository = await getServerPlaceManagementRepository();
    const existing = await repository.getById(id);
    if (!existing) return NextResponse.json({ error: "place_not_found" }, { status: 404 });
    const sensitiveFields: (keyof typeof mutation)[] = ["area", "address", "contactInformation", "timezone", "currency", "latitude", "longitude"];
    if (access.role === "editor" && sensitiveFields.some((field) => mutation[field] !== existing[field])) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    return NextResponse.json(await repository.update(id, mutation));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof PlaceInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "place_unavailable" }, { status: 400 });
  }
}