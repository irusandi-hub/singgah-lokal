import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { ProductionStoryInputError, parseProductionStageMutation } from "@/lib/production-story-management";

export async function GET(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    return NextResponse.json(await (await getServerProductionStoryRepository()).listForPlace(placeId));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "production_story_unavailable" }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    const mutation = parseProductionStageMutation(await request.json());
    return NextResponse.json(await (await getServerProductionStoryRepository()).create(placeId, mutation), { status: 201 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof ProductionStoryInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "production_story_unavailable" }, { status: 400 });
  }
}
