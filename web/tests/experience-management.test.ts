import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionExperienceStatus, isExperiencePublicationReady, type Experience } from "../lib/experiences";
import { ExperienceInputError, parseExperienceMutation } from "../lib/experience-management";
import { places } from "../lib/places";

const place = { ...places[1], address: "Jalan Teh 1", latitude: -6.8, longitude: 107.6 };
const validInput = {
  id: "experience-baru", title: "Kunjungan Baru", shortDescription: "Deskripsi singkat", description: "Deskripsi lengkap untuk pengunjung.",
  durationMinutes: 60, capacity: 10, minPartySize: 1, maxPartySize: 6, ageRequirement: null,
  prerequisites: ["Datang tepat waktu"], meetingPoint: "Gerbang utama", highlights: ["Melihat proses"],
  schedules: [{ dayOfWeek: "Sunday", startTime: "09:00", endTime: "15:00", timezone: "Asia/Jakarta", status: "requires_confirmation" }],
};

test("Experience input validates Place relation and required operational fields", () => {
  const mutation = parseExperienceMutation(validInput, place);
  assert.equal(mutation.id, "experience-baru");
  assert.throws(() => parseExperienceMutation({ ...validInput, placeId: "other-place" }, place), /place_id_not_allowed/);
  assert.throws(() => parseExperienceMutation({ ...validInput, durationMinutes: 0 }, place), ExperienceInputError);
  assert.throws(() => parseExperienceMutation({ ...validInput, minPartySize: 8, maxPartySize: 2 }, place), ExperienceInputError);
});

test("Experience schedule must use the Place timezone and valid time range", () => {
  assert.throws(() => parseExperienceMutation({ ...validInput, schedules: [{ ...validInput.schedules[0], timezone: "UTC" }] }, place), /experience_schedule_invalid/);
  assert.throws(() => parseExperienceMutation({ ...validInput, schedules: [{ ...validInput.schedules[0], startTime: "16:00", endTime: "09:00" }] }, place), ExperienceInputError);
});

test("Experience publication readiness and status transitions are guarded", () => {
  const experience: Experience = { ...parseExperienceMutation(validInput, place), placeId: place.id, status: "draft", publicationStatus: "draft" };
  assert.equal(isExperiencePublicationReady(experience), true);
  assert.equal(isExperiencePublicationReady({ ...experience, schedules: [] }), false);
  assert.equal(canTransitionExperienceStatus("draft", "published"), true);
  assert.equal(canTransitionExperienceStatus("published", "paused"), true);
  assert.equal(canTransitionExperienceStatus("published", "draft"), false);
  assert.equal(canTransitionExperienceStatus("archived", "published"), false);
});