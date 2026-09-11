import assert from "node:assert/strict";
import test from "node:test";
import { experiences } from "../lib/experiences";
import { places, type Place } from "../lib/places";
import { createVisitIntent, validateVisitIntent, type VisitIntentInput } from "../lib/visit-intents";

const canonicalPlace = places.find((candidate) => candidate.id === "rumah-teh-lokal");
const experience = {
  ...experiences[0],
  schedules: [{ ...experiences[0].schedules[0], dayOfWeek: "Sunday" }],
};
const now = new Date("2026-09-05T00:00:00.000Z");

if (!canonicalPlace) {
  throw new Error("Expected canonical test Place");
}
const place: Place = canonicalPlace;

function validInput(overrides: Partial<VisitIntentInput> = {}): VisitIntentInput {
  return {
    userId: "user-1",
    placeId: place.id,
    experienceId: experience.id,
    requestedDate: "2026-09-06",
    requestedStartTime: "10:00",
    requestedEndTime: "11:00",
    partySize: 2,
    ...overrides,
  };
}

test("creates a pending Visit Intent using the Place timezone", () => {
  const intent = createVisitIntent(validInput(), place, experience, now);

  assert.equal(intent.status, "pending");
  assert.equal(intent.timezone, place.timezone);
  assert.equal(intent.producerResponseNote, null);
});

test("rejects an Experience that does not belong to the Place", () => {
  assert.throws(() => validateVisitIntent(validInput({ experienceId: "wrong-experience" }), place, experience, now), /relationship is invalid/);
});

test("rejects a requested time outside the published schedule", () => {
  assert.throws(() => validateVisitIntent(validInput({ requestedStartTime: "15:00", requestedEndTime: "16:00" }), place, experience, now), /outside the Experience schedule/);
});

test("accepts a requested date matching the Experience schedule day", () => {
  assert.doesNotThrow(() => validateVisitIntent(validInput(), place, experience, now));
});

test("rejects a requested date that does not match the Experience schedule day", () => {
  assert.throws(() => validateVisitIntent(validInput({ requestedDate: "2026-09-07" }), place, experience, now), /outside the Experience schedule/);
});

test("uses the Place timezone when checking whether the requested time is in the future", () => {
  const timezonePlace = { ...place, timezone: "America/Los_Angeles" };
  const timezoneExperience = {
    ...experience,
    schedules: [{ ...experience.schedules[0], timezone: "America/Los_Angeles" }],
  };

  assert.doesNotThrow(() =>
    validateVisitIntent(
      validInput({ requestedDate: "2026-09-06", requestedStartTime: "10:00", requestedEndTime: "11:00" }),
      timezonePlace,
      timezoneExperience,
      new Date("2026-09-06T16:30:00.000Z"),
    ),
  );
});

test("accepts schedule boundary times", () => {
  assert.doesNotThrow(() =>
    validateVisitIntent(validInput({ requestedStartTime: "09:00", requestedEndTime: "15:00" }), place, experience, now),
  );
});

test("rejects party sizes outside Experience limits", () => {
  assert.throws(() => validateVisitIntent(validInput({ partySize: 7 }), place, experience, now), /Party size is outside/);
});

test("rejects a past date according to the Place timezone", () => {
  assert.throws(() => validateVisitIntent(validInput({ requestedDate: "2026-09-04" }), place, experience, now), /future/);
});