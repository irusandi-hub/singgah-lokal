import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProductionStoryRepository } from "../lib/production-story-repository";
import { canEditorEditProductionStage, canEditorSetProductionStageStatus, canPublishProductionStage, canTransitionProductionStageStatus, validateProductionStageReorder, type ProductionStage } from "../lib/production-story";
import { parseProductionStageMutation, ProductionStoryInputError } from "../lib/production-story-management";

const stages: ProductionStage[] = [
  { id: "source", placeId: "place-a", title: "Sumber", description: "Fakta sumber.", sortOrder: 0, status: "published", experienceIds: ["experience-a"] },
  { id: "process", placeId: "place-a", title: "Proses", description: "Fakta proses.", sortOrder: 1, status: "review", experienceIds: [] },
  { id: "other-place-stage", placeId: "place-b", title: "Stage lain", description: "Place lain.", sortOrder: 0, status: "published", experienceIds: [] },
];

test("Production Story roles separate editing, review, and publication authority", () => {
  assert.equal(canPublishProductionStage("owner"), true);
  assert.equal(canPublishProductionStage("manager"), true);
  assert.equal(canPublishProductionStage("editor"), false);
  assert.equal(canEditorSetProductionStageStatus("draft"), true);
  assert.equal(canEditorSetProductionStageStatus("review"), true);
  assert.equal(canEditorSetProductionStageStatus("published"), false);
  assert.equal(canEditorSetProductionStageStatus("paused"), false);
  assert.equal(canEditorSetProductionStageStatus("archived"), false);
  assert.equal(canEditorEditProductionStage("draft"), true);
  assert.equal(canEditorEditProductionStage("review"), true);
  assert.equal(canEditorEditProductionStage("published"), false);
});

test("Production Story status requires approval before publication and preserves lifecycle", () => {
  assert.equal(canTransitionProductionStageStatus("draft", "review"), true);
  assert.equal(canTransitionProductionStageStatus("draft", "published"), false);
  assert.equal(canTransitionProductionStageStatus("review", "published"), true);
  assert.equal(canTransitionProductionStageStatus("published", "paused"), true);
  assert.equal(canTransitionProductionStageStatus("paused", "published"), true);
  assert.equal(canTransitionProductionStageStatus("archived", "published"), false);
});

test("Production Story CRUD is scoped to Place and keeps stage identity on reorder", async () => {
  const repository = new InMemoryProductionStoryRepository(stages);
  const created = await repository.create("place-a", { id: "finish", title: "Finishing", description: "Fakta finishing.", experienceIds: [] });
  const updated = await repository.update("place-a", created.id, { id: created.id, title: "Finishing final", description: "Fakta final.", experienceIds: ["experience-a"] });
  assert.equal(updated.id, "finish");
  assert.equal(updated.sortOrder, 2);
  await repository.reorder("place-a", ["finish", "source", "process"]);
  const ordered = await repository.listForPlace("place-a");
  assert.deepEqual(ordered.map((stage) => [stage.id, stage.sortOrder]), [["finish", 0], ["source", 1], ["process", 2]]);
  assert.equal((await repository.getById("place-b", "source")), undefined);
  assert.throws(() => validateProductionStageReorder(["source", "finish"], ordered), /exactly once/);
});

test("Production Story public visibility returns published stages only", async () => {
  const repository = new InMemoryProductionStoryRepository(stages);
  const publicStages = await repository.listForPlace("place-a", true);
  assert.deepEqual(publicStages.map((stage) => stage.id), ["source"]);
  assert.equal((await repository.listForPlace("place-b", true))[0].id, "other-place-stage");
});

test("Production Story input keeps identity and status server-controlled", () => {
  const mutation = parseProductionStageMutation({ id: "source", title: "Sumber", description: "Fakta", experienceIds: [] });
  assert.equal(mutation.id, "source");
  assert.throws(() => parseProductionStageMutation({ id: "source", title: "Sumber", description: "Fakta", status: "published" }), ProductionStoryInputError);
  assert.throws(() => parseProductionStageMutation({ id: "source", title: "Sumber", description: "Fakta", placeId: "place-b" }), ProductionStoryInputError);
});