import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { validateProductionStageReorder } from "@/lib/production-story";
import { ProductionStoryInputError } from "@/lib/production-story-management";

export async function PATCH(request: Request, { params }: { params: Promise<{ placeId: string }> }) {
  try {
    const { placeId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    const body = await request.json() as { stageIds?: unknown };
    if (!Array.isArray(body.stageIds) || body.stageIds.some((stageId) => typeof stageId !== "string")) throw new ProductionStoryInputError("production_stage_order_invalid");
    const repository = await getServerProductionStoryRepository();
    const stages = await repository.listForPlace(placeId);
    validateProductionStageReorder(body.stageIds, stages);
    return NextResponse.json(await repository.reorder(placeId, body.stageIds));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof ProductionStoryInputError || error instanceof Error && error.message.includes("Production Stage order")) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "production_story_unavailable" }, { status: 400 });
  }
}
