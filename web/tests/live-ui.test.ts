import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DISTANCE_FILTERS,
  distanceMeters,
  formatDistance,
  liveDurationLabel,
  matchesDistance,
} from "../lib/live/ui";

test("Home filter bar matches the locked PO set exactly: LIVE first, distance only", () => {
  // Policy §12.5 #1 (PO 2026-09-20): LIVE | 500 m | 1 km | 5 km | 10 km+.
  // No "Di sekitar saya" and no time filters in the distance set.
  assert.deepEqual(DISTANCE_FILTERS, ["500 m", "1 km", "5 km", "10 km+"]);
  // The removed filters must not be re-introduced silently.
  const uiSource = readFileSync(new URL("../lib/live/ui.ts", import.meta.url), "utf8");
  const homeSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(uiSource, /Di sekitar saya/);
  assert.doesNotMatch(homeSource, /Di sekitar saya/);
  // Time filters are removed from Home entirely (constant + quoted labels +
  // activeFilter state + map chip). The "Live Sekarang" card badge is NOT a
  // time filter and stays (policy §9 LIVE card).
  assert.doesNotMatch(homeSource, /const filters = \[/);
  assert.doesNotMatch(homeSource, /"SEKARANG"|"HARI INI"|"BESOK"|"PILIH WAKTU"/);
  assert.doesNotMatch(homeSource, /activeFilter/);
  // LIVE is the first/leftmost filter in the bar (rendered before distance).
  assert.ok(
    homeSource.indexOf("setLiveOnly") < homeSource.indexOf("DISTANCE_FILTERS.map"),
    "LIVE filter must render before the distance filters",
  );
});

test("Distance matching is bounded by the locked radii and fail-open for the widest filter", () => {
  const viewer = { lat: -6.9, lng: 107.6 };
  const near = { lat: -6.901, lng: 107.6 }; // ~111 m
  const mid = { lat: -6.92, lng: 107.6 }; // ~2.2 km
  const far = { lat: -6.99, lng: 107.6 }; // ~10 km

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
