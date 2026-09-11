import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { submitVisitIntent, VisitIntentConflictError } from "@/lib/visit-intent-service";

export async function POST(request: Request) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
    const body = await request.json();
    const intent = await submitVisitIntent(body, actor.userId, idempotencyKey);
    return NextResponse.json(intent, { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof VisitIntentConflictError) {
      return NextResponse.json({ error: "visit_intent_conflict" }, { status: 409 });
    }
    if (error instanceof Error && error.message === "Place or Experience was not found") {
      return NextResponse.json({ error: "visit_intent_invalid" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "Idempotency key is required") {
      return NextResponse.json({ error: "visit_intent_invalid" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "Requested time is outside the Experience schedule") {
      return NextResponse.json({ error: "visit_intent_schedule_unavailable" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "Requested time must be in the future") {
      return NextResponse.json({ error: "visit_intent_time_invalid" }, { status: 400 });
    }
    if (
      error instanceof Error &&
      ["Party size is outside the Experience limits", "Party size exceeds Experience capacity"].includes(error.message)
    ) {
      return NextResponse.json({ error: "visit_intent_party_size_invalid" }, { status: 400 });
    }
    if (error instanceof Error && error.message.startsWith("Invalid requested")) {
      return NextResponse.json({ error: "visit_intent_invalid" }, { status: 400 });
    }
    if (
      error instanceof Error &&
      [
        "Requested start time must be before requested end time",
        "Visit Intent Place and Experience relationship is invalid",
        "Visit Intent requires a published Experience",
        "Optional note must be 500 characters or fewer",
      ].includes(error.message)
    ) {
      return NextResponse.json({ error: "visit_intent_invalid" }, { status: 400 });
    }
    return NextResponse.json({ error: "visit_intent_unavailable" }, { status: 500 });
  }
}