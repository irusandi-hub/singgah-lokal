import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { canEditProductionStage, canEditorEditProductionStage, canPublishProductionStage, canTransitionProductionStageStatus, canEditorSetProductionStageStatus } from "@/lib/production-story";
import { ProductionStoryInputError, parseProductionStageMutation, parseProductionStageStatus } from "@/lib/production-story-management";

export async function GET(request: Request, { params }: { params: Promise<{ placeId: string; stageId: string }> }) {
  try {
    const { placeId, stageId } = await params;
    await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    const stage = await (await getServerProductionStoryRepository()).getById(placeId, stageId);
    return stage ? NextResponse.json(stage) : NextResponse.json({ error: "production_stage_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json({ error: "production_story_unavailable" }, { status: 400 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ placeId: string; stageId: string }> }) {
  try {
    const { placeId, stageId } = await params;
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    if (!canEditProductionStage(access.role)) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    const stage = await (await getServerProductionStoryRepository()).getById(placeId, stageId);
    if (!stage) return NextResponse.json({ error: "production_stage_not_found" }, { status: 404 });
    if (access.role === "editor" && !canEditorEditProductionStage(stage.status)) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    const mutation = parseProductionStageMutation(await request.json(), stageId);
    return NextResponse.json(await (await getServerProductionStoryRepository()).update(placeId, stageId, mutation));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof ProductionStoryInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "production_story_unavailable" }, { status: 400 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ placeId: string; stageId: string }> }) {
  try {
    const { placeId, stageId } = await params;
    const access = await requireProducerAccess(request, placeId, ["owner", "manager", "editor"]);
    const stage = await (await getServerProductionStoryRepository()).getById(placeId, stageId);
    if (!stage) return NextResponse.json({ error: "production_stage_not_found" }, { status: 404 });
    const nextStatus = parseProductionStageStatus((await request.json() as { status?: unknown }).status);
    if (!canTransitionProductionStageStatus(stage.status, nextStatus)) return NextResponse.json({ error: "production_stage_status_transition_invalid" }, { status: 400 });
    if (!canPublishProductionStage(access.role) && !canEditorSetProductionStageStatus(nextStatus)) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    return NextResponse.json(await (await getServerProductionStoryRepository()).updateStatus(placeId, stageId, nextStatus));
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (error instanceof ProducerAuthorizationRequiredError) return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    if (error instanceof ProductionStoryInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "production_story_unavailable" }, { status: 400 });
  }
}
