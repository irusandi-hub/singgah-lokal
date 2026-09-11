import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryPlaceExperienceRepository } from "../lib/place-experience-repository";

test("in-memory Place repository returns validated canonical Places", async () => {
  const repository = new InMemoryPlaceExperienceRepository();
  const places = await repository.listPublishedPlaces();

  assert.deepEqual(places.map((place) => place.id), ["kopi-dari-kebun", "rumah-teh-lokal", "dapur-rasa"]);
  assert.equal((await repository.getPublishedPlaceById("unknown-place")), undefined);
});

test("in-memory Experience repository preserves Place ownership and publication filtering", async () => {
  const repository = new InMemoryPlaceExperienceRepository();
  const experiences = await repository.listPublishedExperiencesForPlace("rumah-teh-lokal");

  assert.equal(experiences.length, 1);
  assert.equal(experiences[0].placeId, "rumah-teh-lokal");
  assert.equal(experiences[0].publicationStatus, "published");
  assert.equal((await repository.getPublishedExperienceById("unknown-experience")), undefined);
});

test("in-memory public Place repository hides unpublished Places", async () => {
  const repository = new InMemoryPlaceExperienceRepository();
  const original = (await repository.getPublishedPlaceById("kopi-dari-kebun"))!;
  assert.equal(original.publicationStatus, "published");
});
