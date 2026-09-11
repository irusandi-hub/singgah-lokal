import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { canTransitionPlaceStatus, isPlacePublicationReady, type PublicationStatus } from "@/lib/places";

const statuses: PublicationStatus[] = ["draft", "published", "paused", "archived"];

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireProducerAccess(request, id);
    const body = await request.json() as { publicationStatus?: unknown };
    if (!statuses.includes(body.publicationStatus as PublicationStatus)) return NextResponse.json({ error: "place_status_invalid" }, { status: 400 });
    const nextStatus = body.publicationStatus as PublicationStatus;
    const repository = await getServerPlaceManagementRepository();
    const place = await repository.getById(id);
    if (!place) return NextResponse.json({ error: "place_not_found" }, { status: 404 });
    if (!canTransitionPlaceStatus(place.publicationStatus, nextStatus)) return NextResponse.json({ error: "place_status_transition_invalid" }, { status: 400 });
    if (nextStatus === "published" && !isPlacePublicationReady(place)) return NextResponse.json({ error: "place_publication_not_ready" }, { status: 400 });
    return NextResponse.json(await repository.updatePublicationStatus(id, nextStatus));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "place_unavailable" }, { status: 400 });
  }
}