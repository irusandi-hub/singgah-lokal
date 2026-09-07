import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { submitVisitIntent } from "@/lib/visit-intent-service";

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
    return NextResponse.json({ error: error instanceof Error ? error.message : "Visit Intent could not be created" }, { status: 400 });
  }
}