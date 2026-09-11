import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerVisitIntentRepository } from "@/lib/visit-intent-repository";
import { getProducerVisitIntentRecord, respondAsProducer, VisitIntentNotFoundError } from "@/lib/visit-intent-service";
import type { VisitIntentStatus } from "@/lib/visit-intents";

const producerResponseStatuses: Extract<VisitIntentStatus, "accepted" | "declined" | "requires_confirmation">[] = ["accepted", "declined", "requires_confirmation"];

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const repository = await getServerVisitIntentRepository();
    const record = await getProducerVisitIntentRecord(id, repository);
    await requireProducerAccess(request, record.intent.placeId, ["owner", "manager"]);
    return NextResponse.json(record);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    if (error instanceof VisitIntentNotFoundError) {
      return NextResponse.json({ error: "visit_intent_not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Visit Intent could not be loaded" }, { status: 400 });
  }
}

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
    if (!producerResponseStatuses.includes(body.status as typeof producerResponseStatuses[number])) {
      return NextResponse.json({ error: "visit_intent_status_invalid" }, { status: 400 });
    }
    if (body.producerResponseNote !== undefined && typeof body.producerResponseNote !== "string") {
      return NextResponse.json({ error: "producer_response_note_invalid" }, { status: 400 });
    }
    await respondAsProducer(id, access, body.status, body.producerResponseNote ?? "", new Date(), repository);
    return NextResponse.json(await getProducerVisitIntentRecord(id, repository));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    if (error instanceof VisitIntentNotFoundError) {
      return NextResponse.json({ error: "visit_intent_not_found" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "Producer response note must be 1000 characters or fewer") {
      return NextResponse.json({ error: "producer_response_note_invalid" }, { status: 400 });
    }
    if (error instanceof Error && error.message.startsWith("Cannot change Visit Intent from")) {
      return NextResponse.json({ error: "visit_intent_status_invalid" }, { status: 400 });
    }
    return NextResponse.json({ error: "visit_intent_unavailable" }, { status: 500 });
  }
}