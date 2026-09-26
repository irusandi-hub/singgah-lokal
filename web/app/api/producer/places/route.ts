import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireAuthenticatedActor, requireProducerOwner } from "@/lib/auth/server";
import { getServerPlaceManagementRepository } from "@/lib/place-experience-repository";
import { derivePlaceIdFromName, parsePlaceMutation, PlaceInputError } from "@/lib/place-management";

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
    const body = await request.json();
    const mutation = parsePlaceMutation(body);
    const repository = await getServerPlaceManagementRepository();
    // System-generated Place ID (PO, 2026-09-26): the Producer never types a
    // technical ID. Derive the slug from the name, fall back to a random id
    // for non-latin names, and enforce uniqueness (repo.create rejects
    // duplicates with a 400, so the UI never shows a half-created Place).
    if (!mutation.id) {
      const base = derivePlaceIdFromName(mutation.name);
      mutation.id = base || `place-${globalThis.crypto.randomUUID().slice(0, 8)}`;
      if (await repository.getById(mutation.id)) {
        throw new PlaceInputError("place_id_taken");
      }
    }
    return NextResponse.json(await repository.create(mutation, actor.producerId as string, actor.userId), { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof PlaceInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "place_unavailable" }, { status: 400 });
  }
}