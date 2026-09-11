import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionPlaceStatus, isPlacePublicationReady, type Place } from "../lib/places";
import { parsePlaceMutation, PlaceInputError } from "../lib/place-management";

const validInput = {
  id: "place-baru", name: "Place Baru", shortDescription: "Cerita lokal", category: "Kopi", type: "production",
  area: "Bandung", address: "Jalan Lokal 1", contactInformation: "hello@example.test", timezone: "Asia/Jakarta",
  currency: "idr", latitude: -6.9, longitude: 107.6,
};

test("Place mutation validates required fields, coordinates, timezone, and currency", () => {
  assert.equal(parsePlaceMutation(validInput).currency, "IDR");
  assert.throws(() => parsePlaceMutation({ ...validInput, producerId: "producer-other" }), /producer_id_not_allowed/);
  assert.throws(() => parsePlaceMutation({ ...validInput, latitude: 91 }), PlaceInputError);
  assert.throws(() => parsePlaceMutation({ ...validInput, timezone: "Not/AZone" }), PlaceInputError);
  assert.throws(() => parsePlaceMutation({ ...validInput, currency: "US" }), PlaceInputError);
  assert.throws(() => parsePlaceMutation({ ...validInput, category: "Other" }), PlaceInputError);
});

test("Place publication readiness requires location data", () => {
  const place = parsePlaceMutation(validInput) as Place;
  assert.equal(isPlacePublicationReady({ ...place, producer: null, claimStatus: "unverified", publicationStatus: "draft" }), true);
  assert.equal(isPlacePublicationReady({ ...place, address: "", producer: null, claimStatus: "unverified", publicationStatus: "draft" }), false);
});

test("Place status transitions preserve archived terminal state", () => {
  assert.equal(canTransitionPlaceStatus("draft", "published"), true);
  assert.equal(canTransitionPlaceStatus("published", "paused"), true);
  assert.equal(canTransitionPlaceStatus("published", "draft"), false);
  assert.equal(canTransitionPlaceStatus("archived", "published"), false);
});