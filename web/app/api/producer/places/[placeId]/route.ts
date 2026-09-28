import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { resolvePlaceMutation, PlaceInputError } from "@/lib/place-management";

export async function GET(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId: id } = await params;
    await requireProducerAccess(request, id, ["owner", "manager", "editor"]);
    const place = await (await getServerPlaceManagementRepository()).getById(id);
    return place ? NextResponse.json(place) : NextResponse.json({ error: "place_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "place_unavailable" }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId: id } = await params;
    const access = await requireProducerAccess(request, id, ["owner", "manager", "editor"]);
    const repository = await getServerPlaceManagementRepository();
    const existing = await repository.getById(id);
    if (!existing) return NextResponse.json({ error: "place_not_found" }, { status: 404 });
    // Timezone is server-owned (PO, 2026-09-28): with coordinates the IANA
    // zone is re-resolved from them (the client cannot set it); without
    // coordinates a saved Place keeps its stored zone — legacy data is never
    // damaged. The lookup failing with coordinates present fails the save
    // clearly instead of silently keeping the old zone.
    const mutation = await resolvePlaceMutation(await request.json(), id, {
      fallbackTimezone: existing.timezone ?? null,
    });
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