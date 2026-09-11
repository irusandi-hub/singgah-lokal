import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { readFileSync as readRepository } from "node:fs";

const migration = readFileSync(new URL("../supabase/migrations/0006_production_story.sql", import.meta.url), "utf8");
const atomicMigration = readFileSync(new URL("../supabase/migrations/0007_production_story_atomic_persistence.sql", import.meta.url), "utf8");
const repository = readRepository(new URL("../lib/production-story-repository.ts", import.meta.url), "utf8");

test("Production Story migration protects canonical relations and editor publication", () => {
  assert.match(migration, /create table if not exists public\.production_stages/);
  assert.match(migration, /unique \(place_id, sort_order\)/);
  assert.match(migration, /production_stage_experiences/);
  assert.match(migration, /new\.id is distinct from old\.id/);
  assert.match(migration, /m\.role = 'editor'/);
  assert.match(migration, /new\.status not in \('draft', 'review'\)/);
  assert.match(migration, /before insert or update on public\.production_stages/);
  assert.match(migration, /prevent_cross_place_production_stage_experience/);
  assert.match(migration, /reorder_production_stages/);
  assert.match(migration, /p_stage_ids/);
});

test("Production Story create and update use atomic server-side persistence RPCs", () => {
  assert.match(atomicMigration, /create or replace function public\.create_production_stage/);
  assert.match(atomicMigration, /create or replace function public\.update_production_stage/);
  assert.match(atomicMigration, /insert into public\.production_stages/);
  assert.match(atomicMigration, /update public\.production_stages/);
  assert.match(atomicMigration, /delete from public\.production_stage_experiences/);
  assert.match(atomicMigration, /insert into public\.production_stage_experiences/);
  assert.match(atomicMigration, /Production Stage Experience does not belong to Place/);
  assert.match(repository, /rpc\("create_production_stage"/);
  assert.match(repository, /rpc\("update_production_stage"/);
  assert.doesNotMatch(repository, /replaceExperiences/);
});