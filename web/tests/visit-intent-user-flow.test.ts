import assert from "node:assert/strict";
import test from "node:test";
import { experiences } from "../lib/experiences";
import { places } from "../lib/places";
import { InMemoryVisitIntentRepository } from "../lib/visit-intent-repository";
import {
  listProducerVisitIntents,
  listUserVisitIntents,
  respondAsProducer,
  submitVisitIntent,
  VisitIntentConflictError,
} from "../lib/visit-intent-service";

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

test("authenticated user creates a persisted Visit Intent (record readable back from the repository)", async () => {
  const repository = new TestVisitIntentRepository();
  const intent = await submitVisitIntent(input, "user-1", "request-1", now, repository);

  // Persistence proof: the record is read back from the store, not just echoed.
  const stored = await repository.findById(intent.id);
  assert.ok(stored);
  assert.equal(stored.id, intent.id);
  assert.equal(stored.userId, "user-1");
  assert.equal(stored.status, "pending");
});

test("unauthenticated submission is rejected by the domain", async () => {
  const repository = new TestVisitIntentRepository();
  await assert.rejects(() => submitVisitIntent(input, "   ", "request-1", now, repository), /Authenticated user is required/);
});

test("user listing returns only the authenticated user's own Visit Intents", async () => {
  const repository = new TestVisitIntentRepository();
  const own = await submitVisitIntent(input, "user-1", "request-1", now, repository);
  const other = await submitVisitIntent(input, "user-2", "request-2", now, repository);

  const mine = await listUserVisitIntents("user-1", repository);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].intent.id, own.id);
  assert.equal(mine[0].place.id, place.id);
  assert.equal(mine[0].experience.id, experience.id);
  assert.notEqual(mine[0].intent.id, other.id);
});

test("Producer Inbox reads the same record for owned Places only", async () => {
  const repository = new TestVisitIntentRepository();
  const intent = await submitVisitIntent(input, "user-1", "request-1", now, repository);

  const inbox = await listProducerVisitIntents([place.id], {}, repository);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].intent.id, intent.id);
  assert.equal(inbox[0].place.id, place.id);
  assert.equal(inbox[0].experience.id, experience.id);

  const unauthorized = await listProducerVisitIntents(["some-other-place"], {}, repository);
  assert.equal(unauthorized.length, 0);
});

test("Producer response status and note become visible to the user", async () => {
  const repository = new TestVisitIntentRepository();
  const intent = await submitVisitIntent(input, "user-1", "request-1", now, repository);

  await respondAsProducer(intent.id, { producerId: "producer-1", role: "owner", placeId: place.id }, "accepted", "Sampai jumpa", new Date("2026-09-05T01:00:00.000Z"), repository);

  const mine = await listUserVisitIntents("user-1", repository);
  assert.equal(mine[0].intent.status, "accepted");
  assert.equal(mine[0].intent.producerResponseNote, "Sampai jumpa");
});

test("idempotency replays the saved record and equivalent duplicates stay rejected", async () => {
  const repository = new TestVisitIntentRepository();
  const first = await submitVisitIntent(input, "user-1", "request-1", now, repository);
  const replay = await submitVisitIntent(input, "user-1", "request-1", now, repository);
  assert.equal(replay.id, first.id);
  assert.equal((await listUserVisitIntents("user-1", repository)).length, 1);

  await assert.rejects(() => submitVisitIntent(input, "user-1", "request-other-key", now, repository), VisitIntentConflictError);
});
