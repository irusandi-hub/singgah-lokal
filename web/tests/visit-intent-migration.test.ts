import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL("../supabase/migrations/0002_harden_visit_intent_rls.sql", import.meta.url);
const persistenceMigrationPath = new URL("../supabase/migrations/0003_persistence_integrity.sql", import.meta.url);
const experienceMigrationPath = new URL("../supabase/migrations/0005_experience_management.sql", import.meta.url);

test("Visit Intent hardening migration protects creation and response boundaries", async () => {
  const migration = await readFile(migrationPath, "utf8");

  assert.match(migration, /new\.status <> 'pending'/);
  assert.match(migration, /new\.producer_response_note is not null/);
  assert.match(migration, /Visit Intent creation fields are immutable/);
  assert.match(migration, /Invalid Visit Intent status transition/);
  assert.match(migration, /old\.status = 'pending' and new\.status in \('accepted', 'declined', 'requires_confirmation'\)/);
  assert.match(migration, /old\.status = 'requires_confirmation' and new\.status in \('accepted', 'declined', 'requires_confirmation'\)/);
  assert.match(migration, /user_id = auth\.uid\(\)/);
  assert.match(migration, /status = 'pending'/);
  assert.match(migration, /producer_response_note is null/);
  assert.match(migration, /m\.role in \('owner', 'manager'\)/);
  assert.match(migration, /revoke insert on public\.visit_intents from authenticated/);
  assert.match(migration, /grant update \(status, producer_response_note, updated_at\)/);
});

test("Experience management migration protects Place ownership, schedules, and editor permissions", async () => {
  const migration = await readFile(experienceMigrationPath, "utf8");

  assert.match(migration, /experiences_producer_insert/);
  assert.match(migration, /experiences_producer_update/);
  assert.match(migration, /m\.place_id = experiences\.place_id/);
  assert.match(migration, /experience_schedules_day_of_week_check/);
  assert.match(migration, /Editor cannot change restricted Experience fields/);
  assert.match(migration, /Editor cannot change Experience schedules/);
  assert.match(migration, /Experience Place is immutable/);
  assert.match(migration, /schedules_producer_delete/);
});

test("persistence migration keeps Place ownership and timezone context consistent", async () => {
  const migration = await readFile(persistenceMigrationPath, "utf8");

  assert.match(migration, /experiences_id_place_id_key unique \(id, place_id\)/);
  assert.match(migration, /visit_intents_experience_place_fkey/);
  assert.match(migration, /foreign key \(experience_id, place_id\)/);
  assert.match(migration, /validate_experience_schedule_timezone/);
  assert.match(migration, /Experience schedule timezone must match its Place timezone/);
  assert.match(migration, /validate_visit_intent_timezone/);
  assert.match(migration, /Visit Intent timezone must match its Place timezone/);
  assert.match(migration, /visit_intents_idempotency_key_not_blank/);
  assert.match(migration, /producer_memberships_user_place_idx/);
});