import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { ProductionStage, ProductionStageStatus } from "@/lib/production-story";
import type { ProductionStageMutation } from "@/lib/production-story-management";

export type ProductionStoryRepository = {
  listForPlace(placeId: string, publishedOnly?: boolean): Promise<ProductionStage[]>;
  getById(placeId: string, id: string, publishedOnly?: boolean): Promise<ProductionStage | undefined>;
  create(placeId: string, mutation: ProductionStageMutation): Promise<ProductionStage>;
  update(placeId: string, id: string, mutation: ProductionStageMutation): Promise<ProductionStage>;
  updateStatus(placeId: string, id: string, status: ProductionStageStatus): Promise<ProductionStage>;
  reorder(placeId: string, stageIds: readonly string[]): Promise<ProductionStage[]>;
};

export class InMemoryProductionStoryRepository implements ProductionStoryRepository {
  private readonly stages: ProductionStage[];

  constructor(initialStages: readonly ProductionStage[] = []) {
    this.stages = initialStages.map((stage) => ({ ...stage, experienceIds: [...stage.experienceIds] }));
  }

  async listForPlace(placeId: string, publishedOnly = false): Promise<ProductionStage[]> {
    return this.stages
      .filter((stage) => stage.placeId === placeId && (!publishedOnly || stage.status === "published"))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
      .map((stage) => ({ ...stage, experienceIds: [...stage.experienceIds] }));
  }

  async getById(placeId: string, id: string, publishedOnly = false): Promise<ProductionStage | undefined> {
    return (await this.listForPlace(placeId, publishedOnly)).find((stage) => stage.id === id);
  }

  async create(placeId: string, mutation: ProductionStageMutation): Promise<ProductionStage> {
    const stage: ProductionStage = { ...mutation, placeId, sortOrder: this.stages.filter((item) => item.placeId === placeId).length, status: "draft" };
    this.stages.push(stage);
    return (await this.getById(placeId, stage.id))!;
  }

  async update(placeId: string, id: string, mutation: ProductionStageMutation): Promise<ProductionStage> {
    const stage = this.stages.find((item) => item.placeId === placeId && item.id === id);
    if (!stage) throw new Error("Production Stage not found");
    stage.title = mutation.title;
    stage.description = mutation.description;
    stage.experienceIds = [...mutation.experienceIds];
    return (await this.getById(placeId, id))!;
  }

  async updateStatus(placeId: string, id: string, status: ProductionStageStatus): Promise<ProductionStage> {
    const stage = this.stages.find((item) => item.placeId === placeId && item.id === id);
    if (!stage) throw new Error("Production Stage not found");
    stage.status = status;
    return (await this.getById(placeId, id))!;
  }

  async reorder(placeId: string, stageIds: readonly string[]): Promise<ProductionStage[]> {
    for (const [sortOrder, id] of stageIds.entries()) {
      const stage = this.stages.find((item) => item.placeId === placeId && item.id === id);
      if (!stage) throw new Error("Production Stage order must include each Place stage exactly once");
      stage.sortOrder = sortOrder;
    }
    return this.listForPlace(placeId);
  }
}

function mapStage(row: Record<string, unknown>, experienceIds: string[]): ProductionStage {
  return {
    id: String(row.id),
    placeId: String(row.place_id),
    title: String(row.title),
    description: String(row.description),
    sortOrder: Number(row.sort_order),
    status: row.status as ProductionStageStatus,
    experienceIds,
  };
}

export class SupabaseProductionStoryRepository implements ProductionStoryRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listForPlace(placeId: string, publishedOnly = false): Promise<ProductionStage[]> {
    let query = this.client.from("production_stages").select("*").eq("place_id", placeId).order("sort_order").order("id");
    if (publishedOnly) query = query.eq("status", "published");
    const { data, error } = await query;
    if (error) throw error;
    return this.mapRows(data ?? []);
  }

  async getById(placeId: string, id: string, publishedOnly = false): Promise<ProductionStage | undefined> {
    let query = this.client.from("production_stages").select("*").eq("place_id", placeId).eq("id", id);
    if (publishedOnly) query = query.eq("status", "published");
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    return (await this.mapRows([data]))[0];
  }

  async create(placeId: string, mutation: ProductionStageMutation): Promise<ProductionStage> {
    const { error } = await this.client.rpc("create_production_stage", {
      p_id: mutation.id,
      p_place_id: placeId,
      p_title: mutation.title,
      p_description: mutation.description,
      p_experience_ids: mutation.experienceIds,
    });
    if (error) throw error;
    const result = await this.getById(placeId, mutation.id);
    if (!result) throw new Error("Production Stage could not be loaded after creation");
    return result;
  }

  async update(placeId: string, id: string, mutation: ProductionStageMutation): Promise<ProductionStage> {
    const { error } = await this.client.rpc("update_production_stage", {
      p_id: id,
      p_place_id: placeId,
      p_title: mutation.title,
      p_description: mutation.description,
      p_experience_ids: mutation.experienceIds,
    });
    if (error) throw error;
    const result = await this.getById(placeId, id);
    if (!result) throw new Error("Production Stage could not be loaded after update");
    return result;
  }

  async updateStatus(placeId: string, id: string, status: ProductionStageStatus): Promise<ProductionStage> {
    const { error } = await this.client.from("production_stages").update({
      status,
      updated_at: new Date().toISOString(),
    }).eq("id", id).eq("place_id", placeId);
    if (error) throw error;
    const result = await this.getById(placeId, id);
    if (!result) throw new Error("Production Stage could not be loaded after status update");
    return result;
  }

  async reorder(placeId: string, stageIds: readonly string[]): Promise<ProductionStage[]> {
    const { error } = await this.client.rpc("reorder_production_stages", { p_place_id: placeId, p_stage_ids: stageIds });
    if (error) throw error;
    return this.listForPlace(placeId);
  }

  private async mapRows(rows: Record<string, unknown>[]): Promise<ProductionStage[]> {
    if (rows.length === 0) return [];
    const stageIds = rows.map((row) => String(row.id));
    const { data, error } = await this.client.from("production_stage_experiences").select("production_stage_id, experience_id").in("production_stage_id", stageIds);
    if (error) throw error;
    const experienceIdsByStage = new Map<string, string[]>();
    for (const relation of data ?? []) {
      const stageId = String(relation.production_stage_id);
      experienceIdsByStage.set(stageId, [...(experienceIdsByStage.get(stageId) ?? []), String(relation.experience_id)]);
    }
    return rows.map((row) => mapStage(row, experienceIdsByStage.get(String(row.id)) ?? []));
  }
}

export async function getServerProductionStoryRepository(): Promise<ProductionStoryRepository> {
  return new SupabaseProductionStoryRepository(await createSupabaseServerClient());
}
