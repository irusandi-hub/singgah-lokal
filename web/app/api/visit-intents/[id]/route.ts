import { NextResponse } from "next/server";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { getUserVisitIntent } from "@/lib/visit-intent-service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAuthenticatedActor(request);
    const { id } = await params;
    return NextResponse.json(await getUserVisitIntent(id, actor.userId));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    return NextResponse.json({ error: "Visit Intent was not found" }, { status: 404 });
  }
}