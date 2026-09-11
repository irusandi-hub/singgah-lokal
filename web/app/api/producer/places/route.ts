import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireAuthenticatedActor, requireProducerOwner } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { parsePlaceMutation, PlaceInputError } from "@/lib/place-management";

export async function GET(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const repository = await getServerPlaceManagementRepository();
    return NextResponse.json(await repository.listForUser(actor.userId));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireProducerOwner(request);
    const mutation = parsePlaceMutation(await request.json());
    const repository = await getServerPlaceManagementRepository();
    return NextResponse.json(await repository.create(mutation, actor.producerId as string), { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof PlaceInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "place_unavailable" }, { status: 400 });
  }
}