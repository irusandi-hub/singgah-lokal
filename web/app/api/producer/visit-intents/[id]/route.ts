import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerVisitIntentRepository } from "@/lib/visit-intent-repository";
import { respondAsProducer } from "@/lib/visit-intent-service";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const repository = await getServerVisitIntentRepository();
    const existing = await repository.findById(id);
    if (!existing) {
      return NextResponse.json({ error: "visit_intent_not_found" }, { status: 404 });
    }
    const access = await requireProducerAccess(request, existing.placeId);
    const intent = await respondAsProducer(id, access, body.status, body.producerResponseNote ?? "", new Date(), repository);
    return NextResponse.json(intent);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Visit Intent could not be updated" }, { status: 400 });
  }
}