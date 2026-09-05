import assert from "node:assert/strict";
import test from "node:test";
import { getPlaceById, places, validatePlace, validatePlaces } from "../lib/places";

test("canonical Place data is valid and uses unique ids", () => {
  assert.doesNotThrow(() => validatePlaces(places));
});

test("retrieves a valid Place by stable id", () => {
  assert.equal(getPlaceById("kopi-dari-kebun")?.name, "Kopi dari Kebun");
});

test("returns undefined for an unknown Place id", () => {
  assert.equal(getPlaceById("unknown-place"), undefined);
});

test("rejects invalid coordinates", () => {
  const place = { ...places[0], latitude: 91 };
  assert.throws(() => validatePlace(place), /Invalid latitude/);
});