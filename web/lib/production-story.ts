export type ProductionStageStatus = "draft" | "review" | "published" | "paused" | "archived";

export type ProductionStage = {
  id: string;
  placeId: string;
  title: string;
  description: string;
  sortOrder: number;
  status: ProductionStageStatus;
  experienceIds: string[];
};

export const productionStageStatuses: ProductionStageStatus[] = ["draft", "review", "published", "paused", "archived"];
const stageIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateProductionStage(stage: ProductionStage): void {
  if (!stageIdPattern.test(stage.id)) throw new Error(`Invalid Production Stage id: ${stage.id}`);
  if (!stage.placeId.trim() || !stage.title.trim() || !stage.description.trim()) throw new Error("Production Stage content is required");
  if (!Number.isInteger(stage.sortOrder) || stage.sortOrder < 0) throw new Error("Production Stage order is invalid");
  if (!productionStageStatuses.includes(stage.status)) throw new Error("Production Stage status is invalid");
  if (new Set(stage.experienceIds).size !== stage.experienceIds.length) throw new Error("Production Stage Experiences must be unique");
}

export function canEditProductionStage(role: "owner" | "manager" | "editor"): boolean {
  return ["owner", "manager", "editor"].includes(role);
}

export function canPublishProductionStage(role: "owner" | "manager" | "editor"): boolean {
  return role === "owner" || role === "manager";
}

export function canTransitionProductionStageStatus(current: ProductionStageStatus, next: ProductionStageStatus): boolean {
  if (current === next) return true;
  if (current === "archived") return false;
  return {
    draft: ["review", "archived"],
    review: ["published", "draft", "archived"],
    published: ["paused", "archived"],
    paused: ["published", "archived"],
  }[current].includes(next);
}

export function canEditorSetProductionStageStatus(status: ProductionStageStatus): boolean {
  return status === "draft" || status === "review";
}

export function canEditorEditProductionStage(status: ProductionStageStatus): boolean {
  return status === "draft" || status === "review";
}

export function validateProductionStageReorder(stageIds: readonly string[], stages: readonly ProductionStage[]): void {
  const existingIds = stages.map((stage) => stage.id);
  if (stageIds.length !== existingIds.length || new Set(stageIds).size !== stageIds.length || stageIds.some((id) => !existingIds.includes(id))) {
    throw new Error("Production Stage order must include each Place stage exactly once");
  }
}