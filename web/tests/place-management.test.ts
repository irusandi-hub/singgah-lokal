import assert from "node:assert/strict";
import test from "node:test";
import { PLACE_CATEGORIES, PLACE_CURRENCIES, canTransitionPlaceStatus, isPlacePublicationReady, type Place } from "../lib/places";
import { parsePlaceMutation, resolvePlaceMutation, resolveTimezoneFromCoordinates, PlaceInputError } from "../lib/place-management";

const validInput = {
  id: "place-baru", name: "Place Baru", shortDescription: "Cerita lokal", category: "Sumber Daya Alam", type: "production",
  area: "Bandung", countryCode: "ID", regionName: "Jawa Barat",
  address: "Jalan Lokal 1", contactInformation: "hello@example.test", timezone: "Asia/Jakarta",
  currency: "idr", latitude: -6.9, longitude: 107.6,
};

test("Place mutation validates required fields, coordinates, timezone, and currency", () => {
  assert.equal(parsePlaceMutation(validInput).currency, "IDR");
  assert.throws(() => parsePlaceMutation({ ...validInput, producerId: "producer-other" }), /producer_id_not_allowed/);
  assert.throws(() => parsePlaceMutation({ ...validInput, latitude: 91 }), PlaceInputError);
  assert.throws(() => parsePlaceMutation({ ...validInput, timezone: "Not/AZone" }), PlaceInputError);
  assert.throws(() => parsePlaceMutation({ ...validInput, currency: "US" }), /place_currency_invalid/);
  assert.throws(() => parsePlaceMutation({ ...validInput, category: "Other" }), PlaceInputError);
});

test("Only the three canonical Place categories are valid — retired ones are refused", () => {
  // The exact vocabulary (PO, 2026-09-28): nothing outside it exists.
  assert.deepEqual([...PLACE_CATEGORIES], ["Sumber Daya Alam", "Industri & Pengolahan", "Perdagangan & Jasa"]);
  // Every canonical category parses; a normalized round-trip keeps the value.
  for (const category of PLACE_CATEGORIES) {
    const mutation = parsePlaceMutation({ ...validInput, category });
    assert.equal(mutation.category, category);
  }
  // The retired categories cannot be saved through the ONE shared validator
  // (both the Admin and the Producer write path inherit this refusal).
  for (const retired of ["Kopi", "Teh", "Kuliner", "kraft"]) {
    assert.throws(
      () => parsePlaceMutation({ ...validInput, category: retired }),
      /place_type_or_category_invalid/,
      `category "${retired}" must be refused`,
    );
  }
});

test("Only IDR and USD are valid currencies", () => {
  assert.deepEqual([...PLACE_CURRENCIES], ["IDR", "USD"]);
  assert.equal(parsePlaceMutation({ ...validInput, currency: "usd" }).currency, "USD");
  for (const invalid of ["EUR", "SGD", "us", "IDRX"]) {
    assert.throws(
      () => parsePlaceMutation({ ...validInput, currency: invalid }),
      /place_currency_invalid/,
      `currency "${invalid}" must be refused`,
    );
  }
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

test("Changed coordinates recompute the timezone; a failed lookup fails the save", async () => {
  // Stub the network layer: the resolver must call it with the coordinates
  // it was given, and the answer must become the stored zone.
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("latitude=-6.9")) {
      return new Response(JSON.stringify({ timeZone: "Asia/Jakarta" }), { status: 200 });
    }
    // A different coordinate resolves to a DIFFERENT zone.
    return new Response(JSON.stringify({ timeZone: "Asia/Makassar" }), { status: 200 });
  }) as typeof fetch;
  try {
    const jakarta = await resolvePlaceMutation(validInput);
    assert.equal(jakarta.timezone, "Asia/Jakarta");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /latitude=-6\.9&longitude=107\.6/);

    // The Admin/Producer edit path recomputes from the NEW coordinates on
    // every save — a Place moved across a zone boundary changes its zone.
    const makassar = await resolvePlaceMutation({ ...validInput, latitude: -5.14, longitude: 119.42 });
    assert.equal(makassar.timezone, "Asia/Makassar");
    assert.match(calls[1], /latitude=-5\.14&longitude=119\.42/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // A failed lookup (network error, non-OK answer, or a non-IANA payload)
  // FAILS the save — there is no Asia/Jakarta fallback and no silent keep.
  const originalFetch2 = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => resolveTimezoneFromCoordinates(-6.9, 107.6),
      /place_timezone_unavailable/,
    );
    await assert.rejects(() => resolvePlaceMutation(validInput), /place_timezone_unavailable/);
  } finally {
    globalThis.fetch = originalFetch2;
  }

  // A payload that is not a real IANA zone is equally unusable.
  const originalFetch3 = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ timeZone: "Mars/Olympus" }), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => resolveTimezoneFromCoordinates(0, 0), /place_timezone_unavailable/);
  } finally {
    globalThis.fetch = originalFetch3;
  }
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
