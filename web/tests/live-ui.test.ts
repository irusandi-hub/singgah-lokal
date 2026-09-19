import assert from "node:assert/strict";
import test from "node:test";
import {
  DISTANCE_FILTERS,
  distanceMeters,
  formatDistance,
  liveDurationLabel,
  matchesDistance,
} from "../lib/live/ui";

test("Distance filter set matches the locked policy §9 values exactly", () => {
  assert.deepEqual(DISTANCE_FILTERS, ["Di sekitar saya", "500 m", "1 km", "5 km", "10 km+"]);
});

test("Distance matching is bounded by the locked radii and fail-open for the widest filter", () => {
  const viewer = { lat: -6.9, lng: 107.6 };
  const near = { lat: -6.901, lng: 107.6 }; // ~111 m
  const mid = { lat: -6.92, lng: 107.6 }; // ~2.2 km
  const far = { lat: -6.99, lng: 107.6 }; // ~10 km

  assert.equal(matchesDistance("Di sekitar saya", null, near), true);
  assert.equal(matchesDistance("Di sekitar saya", viewer, near), true);
  assert.equal(matchesDistance("500 m", viewer, near), true);
  assert.equal(matchesDistance("500 m", viewer, mid), false);
  assert.equal(matchesDistance("1 km", viewer, near), true);
  assert.equal(matchesDistance("1 km", viewer, mid), false);
  assert.equal(matchesDistance("5 km", viewer, mid), true);
  assert.equal(matchesDistance("5 km", viewer, far), false);
  // "10 km+" is unbounded; missing positions never hide results.
  assert.equal(matchesDistance("10 km+", viewer, far), true);
  assert.equal(matchesDistance("10 km+", null, null), true);
  assert.equal(matchesDistance("5 km", null, near), false);
});

test("Haversine distance is sane and formatted for the Indonesian UI", () => {
  const meters = distanceMeters({ lat: -6.9, lng: 107.6 }, { lat: -6.901, lng: 107.6 });
  assert.ok(meters > 90 && meters < 130);
  assert.equal(formatDistance(80), "80 m");
  assert.equal(formatDistance(1500), "1,5 km");
});

test("Live duration label caps at the locked 60 minutes", () => {
  const now = Date.now();
  assert.equal(liveDurationLabel(new Date(now - 5 * 60000).toISOString(), now), "5 menit");
  assert.equal(liveDurationLabel(new Date(now - 75 * 60000).toISOString(), now), "60 menit");
});
