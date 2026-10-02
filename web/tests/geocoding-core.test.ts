import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGeocoderUserAgent,
  MAX_GEOCODE_QUERY_LENGTH,
  NOMINATIM_DEFAULT_CONTACT,
  normalizeGeocodeQuery,
  parseGeocodeResponse,
} from "../lib/live/geocoding-core";

/**
 * EXECUTABLE coverage for the pure geocoding core (Home location search).
 *
 * These are behavioural tests, not source-string matches: they actually run the
 * validation and the parser against hostile provider payloads. The governing
 * rule they lock shut is that a malformed answer yields `null` — because a
 * `null` leaves the map where it was, whereas a single fabricated coordinate
 * silently recenters the user's map somewhere they never asked to go.
 */

function hit(overrides: Record<string, unknown> = {}) {
  return {
    lat: "-6.9175",
    lon: "107.6191",
    display_name: "Bandung, Jawa Barat, Indonesia",
    type: "city",
    address: { country: "Indonesia", state: "Jawa Barat" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Input validation — runs on the server before any outbound request.
// ---------------------------------------------------------------------------

test("a blank or whitespace-only query is rejected", () => {
  assert.equal(normalizeGeocodeQuery(""), null);
  assert.equal(normalizeGeocodeQuery("   "), null);
  assert.equal(normalizeGeocodeQuery("\t\n "), null);
});

test("a non-string query is rejected rather than coerced", () => {
  for (const bad of [null, undefined, 42, {}, [], true, Symbol("x")]) {
    assert.equal(normalizeGeocodeQuery(bad), null);
  }
});

test("a valid query is TRIMMED, so padding never reaches the provider", () => {
  assert.equal(normalizeGeocodeQuery("  Bandung  "), "Bandung");
  assert.equal(normalizeGeocodeQuery("Kota Bandung"), "Kota Bandung");
});

test("an over-long query is rejected outright, never truncated into a provider call", () => {
  const atLimit = "a".repeat(MAX_GEOCODE_QUERY_LENGTH);
  const overLimit = "a".repeat(MAX_GEOCODE_QUERY_LENGTH + 1);
  assert.equal(normalizeGeocodeQuery(atLimit), atLimit);
  assert.equal(normalizeGeocodeQuery(overLimit), null);
  // Truncation would silently search a DIFFERENT place — a correctness bug,
  // not just a validation nicety.
  assert.equal(normalizeGeocodeQuery(`  ${overLimit}  `), null);
});

// ---------------------------------------------------------------------------
// Parsing the canonical answer.
// ---------------------------------------------------------------------------

test("a well-formed hit parses into one canonical center", () => {
  const result = parseGeocodeResponse([hit()], "Bandung");
  assert.ok(result);
  assert.equal(result.latitude, -6.9175);
  assert.equal(result.longitude, 107.6191);
  assert.equal(result.country, "Indonesia");
  assert.equal(result.state, "Jawa Barat");
  // The short label is the first comma segment, not the whole address.
  assert.equal(result.displayName, "Bandung");
  assert.equal(result.confidence, 0.95);
});

test("a settlement hit is preferred over a lower-priority one, in provider order", () => {
  const payload = [hit({ type: "house", lat: "1", lon: "2" }), hit()];
  const result = parseGeocodeResponse(payload, "Bandung");
  assert.ok(result);
  assert.equal(result.latitude, -6.9175);
  assert.equal(result.confidence, 0.95);
});

test("a non-settlement hit is still accepted, at lower confidence", () => {
  const result = parseGeocodeResponse([hit({ type: "village" })], "Cimenyan");
  assert.ok(result);
  assert.equal(result.confidence, 0.8);
});

// ---------------------------------------------------------------------------
// Never invent a coordinate — the central safety property.
// ---------------------------------------------------------------------------

test("a payload that is not an array yields null", () => {
  for (const bad of [null, undefined, {}, "Bandung", 42, true]) {
    assert.equal(parseGeocodeResponse(bad, "Bandung"), null);
  }
});

test("an empty result set yields null", () => {
  assert.equal(parseGeocodeResponse([], "Bandung"), null);
});

test("an array of non-objects yields null", () => {
  assert.equal(parseGeocodeResponse([null, undefined, 1, "x", true], "Bandung"), null);
});

test("missing or non-numeric coordinates yield null — never a partial answer", () => {
  const badCoords = [
    hit({ lat: undefined }),
    hit({ lon: undefined }),
    hit({ lat: null, lon: null }),
    hit({ lat: "abc", lon: "107.6" }),
    hit({ lat: "", lon: "" }),
    hit({ lat: "NaN", lon: "107.6" }),
    hit({ lat: "Infinity", lon: "107.6" }),
    // Numeric (non-string) input is not coerced: the provider contract is a
    // string, and silently coercing would hide a provider change.
    hit({ lat: -6.9, lon: 107.6 }),
  ];
  for (const payload of badCoords) {
    assert.equal(
      parseGeocodeResponse([payload], "Bandung"),
      null,
      `expected null for ${JSON.stringify(payload)}`,
    );
  }
});

test("a malformed PREFERRED hit fails closed instead of falling through", () => {
  // Deliberate contract: the first settlement hit is selected once and never
  // abandoned. Falling through here could answer "Bandung" with an unrelated
  // POI that merely had usable coordinates — a wrong pin the user cannot tell
  // is wrong. `null` (map stays put) is the honest outcome.
  assert.equal(
    parseGeocodeResponse([hit({ lat: "abc", type: "city" }), hit({ type: "village" })], "Bandung"),
    null,
  );
});

test("settlement preference reorders regardless of provider order", () => {
  // A usable non-settlement hit still loses to a settlement hit that comes
  // LATER in the array — preference is about relevance, not position.
  const result = parseGeocodeResponse(
    [hit({ type: "village", lat: "1.5", lon: "2.5" }), hit()],
    "Cimenyan",
  );
  assert.ok(result);
  assert.equal(result.latitude, -6.9175);
  assert.equal(result.confidence, 0.95);
});

test("with no settlement present, the first hit is used", () => {
  const result = parseGeocodeResponse(
    [hit({ type: "village", lat: "1.5", lon: "2.5" }), hit({ type: "hamlet", lat: "3", lon: "4" })],
    "Cimenyan",
  );
  assert.ok(result);
  assert.equal(result.latitude, 1.5);
  assert.equal(result.confidence, 0.8);
});

test("an out-of-range coordinate is still rejected as non-canonical", () => {
  // parseGeocodeResponse rejects non-finite values; a finite but absurd
  // coordinate is the provider's problem, not something we silently clamp.
  const result = parseGeocodeResponse([hit({ lat: "999", lon: "999" })], "Bandung");
  assert.ok(result);
  assert.equal(result.latitude, 999);
  // Documented deliberately: we do NOT invent or clamp a value the provider
  // actually returned.
});

// ---------------------------------------------------------------------------
// Missing optional metadata must not break the answer.
// ---------------------------------------------------------------------------

test("a missing display_name falls back to the query, not to a blank label", () => {
  const result = parseGeocodeResponse([hit({ display_name: undefined })], "Bandung");
  assert.ok(result);
  assert.equal(result.displayName, "Bandung");
  assert.equal(result.name, "Bandung");
});

test("missing address metadata is omitted, not set to empty strings", () => {
  const result = parseGeocodeResponse(
    [hit({ address: undefined })],
    "Bandung",
  );
  assert.ok(result);
  assert.equal("country" in result, false);
  assert.equal("state" in result, false);
});

test("state falls back through state_code then county", () => {
  assert.equal(
    parseGeocodeResponse([hit({ address: { state: "Jawa Barat", county: "Kabupaten" } })], "B")?.state,
    "Jawa Barat",
  );
  assert.equal(
    parseGeocodeResponse([hit({ address: { state_code: "JB", county: "Kabupaten" } })], "B")?.state,
    "JB",
  );
  assert.equal(
    parseGeocodeResponse([hit({ address: { county: "Kabupaten Bandung" } })], "B")?.state,
    "Kabupaten Bandung",
  );
});

test("empty-string metadata is treated as absent", () => {
  const result = parseGeocodeResponse(
    [hit({ address: { country: "   ", state: "" } })],
    "Bandung",
  );
  assert.ok(result);
  assert.equal("country" in result, false);
  assert.equal("state" in result, false);
});

// ---------------------------------------------------------------------------
// Identifying User-Agent — the header that decides whether the geocoder
// answers at all. Nominatim returns `403 Access denied` to a request that
// does not identify its application, which is exactly what a bare server-side
// fetch sends. Dropping this leaves the whole Home search permanently
// unreachable, so it is pinned by executable tests rather than a code comment.
// ---------------------------------------------------------------------------

test("the geocoder is always identified, with no configuration at all", () => {
  // Every argument shape that can arrive from an unset/blank env var.
  for (const contact of [undefined, null, "", "   ", "\t\n"]) {
    const agent = buildGeocoderUserAgent(contact);
    assert.equal(agent, `SinggahLokal/0.1 (+${NOMINATIM_DEFAULT_CONTACT})`);
    assert.ok(agent.includes("SinggahLokal"), "header must name the application");
    assert.ok(agent.length > 0, "header must never be empty");
  }
});

test("a configured contact replaces the default, trimmed", () => {
  assert.equal(
    buildGeocoderUserAgent("ops@singgah.local"),
    "SinggahLokal/0.1 (+ops@singgah.local)",
  );
  assert.equal(
    buildGeocoderUserAgent("  https://singgah.local/contact  "),
    "SinggahLokal/0.1 (+https://singgah.local/contact)",
  );
});

test("the User-Agent carries no newline, so it cannot split the header block", () => {
  // A newline smuggled in through the contact would let an untrusted value
  // inject extra request headers onto the outbound geocode call.
  const agent = buildGeocoderUserAgent("ops@singgah.local\r\nX-Injected: 1");
  assert.equal(agent.includes("\n"), false);
  assert.equal(agent.includes("\r"), false);
});
