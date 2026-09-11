import assert from "node:assert/strict";
import test from "node:test";
import { experiences } from "../lib/experiences";
import { places } from "../lib/places";
import { InMemoryVisitIntentRepository } from "../lib/visit-intent-repository";
import { getUserVisitIntent, respondAsProducer, submitVisitIntent, VisitIntentConflictError } from "../lib/visit-intent-service";

const place = places.find((candidate) => candidate.id === "rumah-teh-lokal");
const experience = {
  ...experiences[0],
  schedules: [{ ...experiences[0].schedules[0], dayOfWeek: "Sunday" }],
};
const now = new Date("2026-09-05T00:00:00.000Z");

class TestVisitIntentRepository extends InMemoryVisitIntentRepository {
  async getExperienceById(id: string) {
    return id === experience.id ? experience : undefined;
  }
}

if (!place) {
  throw new Error("Expected canonical test Place");
}

const input = {
  placeId: place.id,
  experienceId: experience.id,
  requestedDate: "2026-09-06",
  requestedStartTime: "10:00",
  requestedEndTime: "11:00",
  partySize: 2,
};

test("idempotency replays the original Visit Intent", async () => {
  const repository = new TestVisitIntentRepository();
  const first = await submitVisitIntent(input, "user-1", "request-1", now, repository);
  const replay = await submitVisitIntent(input, "user-1", "request-1", new Date("2026-09-05T00:01:00.000Z"), repository);

  assert.equal(replay.id, first.id);
  assert.equal((await repository.listForUser("user-1")).length, 1);
});

test("equivalent active Visit Intents are rejected across keys", async () => {
  const repository = new TestVisitIntentRepository();
  await submitVisitIntent(input, "user-1", "request-1", now, repository);

  await assert.rejects(() => submitVisitIntent(input, "user-1", "request-2", now, repository), VisitIntentConflictError);
});

test("user access is limited to the authenticated user", async () => {
  const repository = new TestVisitIntentRepository();
  const intent = await submitVisitIntent(input, "user-1", "request-1", now, repository);

  assert.equal((await getUserVisitIntent(intent.id, "user-1", repository)).id, intent.id);
  await assert.rejects(() => getUserVisitIntent(intent.id, "user-2", repository), /not found/);
});

test("Producer response requires Place authorization", async () => {
  const repository = new TestVisitIntentRepository();
  const intent = await submitVisitIntent(input, "user-1", "request-1", now, repository);

  await assert.rejects(
    () => respondAsProducer(intent.id, { producerId: "other", role: "owner" }, "accepted", "", now, repository),
    /not found/,
  );
});

test("Producer response rejects an Experience from another Place", async () => {
  const repository = new TestVisitIntentRepository();
  const intent = await submitVisitIntent(input, "user-1", "request-1", now, repository);
  const mismatchedExperience = { ...experience, placeId: "another-place" };
  const mismatchedRepository = new (class extends TestVisitIntentRepository {
    async getExperienceById(id: string) {
      return id === mismatchedExperience.id ? mismatchedExperience : undefined;
    }
  })();
  await mismatchedRepository.insert(intent, "request-1");

  await assert.rejects(
    () => respondAsProducer(intent.id, { producerId: "producer-1", role: "owner", placeId: place.id }, "accepted", "", now, mismatchedRepository),
    /not found/,
  );
});