import { type ProductionStage, productionStageStatuses, validateProductionStage } from "@/lib/production-story";

export class ProductionStoryInputError extends Error {}

export type ProductionStageMutation = Pick<ProductionStage, "id" | "title" | "description" | "experienceIds">;

export function parseProductionStageMutation(raw: unknown, id?: string): ProductionStageMutation {
  if (!raw || typeof raw !== "object") throw new ProductionStoryInputError("production_stage_input_invalid");
  const body = raw as Record<string, unknown>;
  if ("placeId" in body || "sortOrder" in body || "status" in body) throw new ProductionStoryInputError("production_stage_identity_or_status_not_allowed");
  const value = (key: string): string => {
    if (typeof body[key] !== "string" || !(body[key] as string).trim()) throw new ProductionStoryInputError("production_stage_required_field_invalid");
    return (body[key] as string).trim();
  };
  const experienceIds = body.experienceIds === undefined ? [] : body.experienceIds;
  if (!Array.isArray(experienceIds) || experienceIds.some((experienceId) => typeof experienceId !== "string" || !experienceId.trim())) {
    throw new ProductionStoryInputError("production_stage_experiences_invalid");
  }
  const mutation = { id: id ?? value("id"), title: value("title"), description: value("description"), experienceIds: experienceIds.map((experienceId) => experienceId.trim()) };
  try {
    validateProductionStage({ ...mutation, placeId: "place", sortOrder: 0, status: "draft" });
  } catch {
    throw new ProductionStoryInputError("production_stage_input_invalid");
  }
  return mutation;
}

export function parseProductionStageStatus(raw: unknown): ProductionStage["status"] {
  if (typeof raw !== "string" || !productionStageStatuses.includes(raw as ProductionStage["status"])) throw new ProductionStoryInputError("production_stage_status_invalid");
  return raw as ProductionStage["status"];
}