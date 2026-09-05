import assert from "node:assert/strict";
import test from "node:test";
import { experiences, getExperienceById, getExperiencesForPlace, validateExperience, validateExperiences } from "../lib/experiences";
import { places } from "../lib/places";

test("canonical Experience data belongs to a valid Place", () => {
  assert.doesNotThrow(() => validateExperiences(experiences, places));
});

test("retrieves published Experiences through their Place", () => {
  const experience = getExperienceById("kunjungan-pengenalan-rumah-teh");

  assert.equal(experience?.placeId, "rumah-teh-lokal");
  assert.equal(getExperiencesForPlace("rumah-teh-lokal").length, 1);
});

test("Experience schedules must use the parent Place timezone", () => {
  const experience = { ...experiences[0], schedules: [{ ...experiences[0].schedules[0], timezone: "UTC" }] };
  const place = places.find((candidate) => candidate.id === experience.placeId);

  assert.ok(place);
  assert.throws(() => validateExperience(experience, place), /Invalid schedule/);
});

test("Experience cannot reference a different Place", () => {
  assert.throws(() => validateExperience(experiences[0], places[0]), /does not belong/);
});