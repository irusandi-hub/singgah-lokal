import assert from "node:assert/strict";
import test from "node:test";
import { experiences } from "../lib/experiences";
import { places, type Place } from "../lib/places";
import { canManagePlace, getProducerPlaces, getProducerVisitIntents, type ProducerAccess } from "../lib/producer";
import { createVisitIntent, respondToVisitIntent, type VisitIntentInput } from "../lib/visit-intents";

const place: Place = {
  ...places[0],
  producer: { id: "producer-1", displayName: "Producer 1" },
};
const experience = {
  ...experiences[0],
  placeId: place.id,
  schedules: [{ ...experiences[0].schedules[0], dayOfWeek: "Sunday" }],
};
const access: ProducerAccess = { producerId: "producer-1", role: "owner" };
const now = new Date("2026-09-05T00:00:00.000Z");

const intentInput: VisitIntentInput = {
  userId: "user-1",
  placeId: place.id,
  experienceId: experience.id,
  requestedDate: "2026-09-06",
  requestedStartTime: "10:00",
  requestedEndTime: "11:00",
  partySize: 2,
};

test("Producer access is limited to linked Places", () => {
  assert.equal(canManagePlace(place, access), true);
  assert.equal(getProducerPlaces([place, places[1]], access).length, 1);
  assert.equal(getProducerPlaces([place], { producerId: "other", role: "owner" }).length, 0);
});

test("Producer inbox filters Visit Intents by Place authorization", () => {
  const intent = createVisitIntent(intentInput, place, experience, now);
  const visible = getProducerVisitIntents([intent], [place], [experience], access);

  assert.equal(visible.length, 1);
  assert.equal(visible[0].experience?.id, experience.id);
  assert.equal(getProducerVisitIntents([intent], [place], [experience], { producerId: "other", role: "owner" }).length, 0);
});

test("Producer inbox rejects an Experience that does not belong to the intent Place", () => {
  const intent = createVisitIntent(intentInput, place, experience, now);
  const mismatchedExperience = { ...experience, placeId: "another-place" };

  assert.equal(
    getProducerVisitIntents(
      [{ ...intent, experienceId: mismatchedExperience.id }],
      [place],
      [mismatchedExperience],
      access,
    ).length,
    0,
  );
});

test("Producer can respond to pending Visit Intent with authorization", () => {
  const intent = createVisitIntent(intentInput, place, experience, now);
  const accepted = respondToVisitIntent(intent, place, access, "accepted", "Waktu perlu dikonfirmasi saat kunjungan.", now);

  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.producerResponseNote, "Waktu perlu dikonfirmasi saat kunjungan.");
  assert.throws(() => respondToVisitIntent(intent, place, { producerId: "other", role: "owner" }, "accepted", "", now), /not authorized/);
  assert.throws(() => respondToVisitIntent(accepted, place, access, "declined", "", now), /Cannot change/);
});