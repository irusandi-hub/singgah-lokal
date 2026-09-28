import assert from "node:assert/strict";
import test from "node:test";
import { canTransitionPlaceStatus, isPlacePublicationReady, type Place } from "../lib/places";
import { parsePlaceMutation, resolvePlaceMutation, PlaceInputError } from "../lib/place-management";

const validInput = {
  id: "place-baru", name: "Place Baru", shortDescription: "Cerita lokal", category: "Kopi", type: "production",
  area: "Bandung", countryCode: "ID", regionName: "Jawa Barat",
  address: "Jalan Lokal 1", contactInformation: "hello@example.test", timezone: "Asia/Jakarta",
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

test("Producer save path resolves the timezone server-side from coordinates", async () => {
  // With coordinates, the IANA zone is looked up from them and any
  // client-sent value is discarded — coordinates are the source of truth.
  const withCoordinates = await resolvePlaceMutation(validInput);
  assert.notEqual(withCoordinates.timezone, "");
  assert.notEqual(withCoordinates.timezone, "UTC");

  // A NEW Place without coordinates has nothing to resolve from and no
  // stored zone to keep, so it fails clearly instead of guessing.
  await assert.rejects(
    () => resolvePlaceMutation({ ...validInput, latitude: null, longitude: null }),
    /place_timezone_unresolved/,
  );

  // A saved Place without coordinates keeps its stored zone (legacy data is
  // never damaged); the lookup is never called for it.
  const legacy = await resolvePlaceMutation({ ...validInput, latitude: null, longitude: null }, "place-baru", {
    fallbackTimezone: "Asia/Jakarta",
  });
  assert.equal(legacy.timezone, "Asia/Jakarta");
  // An unusable stored zone does not pass silently either.
  await assert.rejects(
    () => resolvePlaceMutation({ ...validInput, latitude: null, longitude: null }, "place-baru", {
      fallbackTimezone: "",
    }),
    /place_timezone_unresolved/,
  );
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