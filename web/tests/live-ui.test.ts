import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DISTANCE_FILTERS,
  activateCuratedFilter,
  distanceMeters,
  formatDistance,
  liveDurationLabel,
  matchesDistance,
  toggleLiveFilter,
} from "../lib/live/ui";

test("Home filter bar matches the locked PO set exactly: LIVE first, distance only", () => {
  // PO 2026-09-26 (amending Policy §12.5 #1): one row — LIVE | Tempat
  // Pilihan | 1 km | 5 km | 10 km+. "500 m" was removed from the UI, state,
  // default, and filter logic; no "Di sekitar saya" and no time filters.
  assert.deepEqual(DISTANCE_FILTERS, ["1 km", "5 km", "10 km+"]);
  // The removed filters must not be re-introduced silently.
  const uiSource = readFileSync(new URL("../lib/live/ui.ts", import.meta.url), "utf8");
  const homeSource = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
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

  assert.equal(matchesDistance("1 km", viewer, near), true);
  assert.equal(matchesDistance("1 km", viewer, mid), false);
  assert.equal(matchesDistance("5 km", viewer, mid), true);
  assert.equal(matchesDistance("5 km", viewer, far), false);
  // "10 km+" is unbounded; missing positions never hide results.
  assert.equal(matchesDistance("10 km+", viewer, far), true);
  assert.equal(matchesDistance("10 km+", null, null), true);
  assert.equal(matchesDistance("5 km", null, near), false);
  // "500 m" is fully removed: the filter value must not exist anymore.
  const typeSource = readFileSync(new URL("../lib/live/ui.ts", import.meta.url), "utf8");
  assert.equal(typeSource.includes('"500 m"'), false, '"500 m" must not exist in the filter model');
  const homeCode = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
  assert.equal(homeCode.includes('"500 m"'), false, '"500 m" must not exist in Home state/default');
  // Default is the smallest remaining bounded radius.
  assert.match(homeCode, /useState<DistanceFilter>\("1 km"\)/);
});

test("LIVE and Tempat Pilihan are mutually exclusive, and turning LIVE off changes nothing else", () => {
  // BUG FIX (2026-10-01): the LIVE toggle used to flip `liveOnly` alone, so
  // activating LIVE while the curated layer was open produced a state no mode
  // owns — both buttons pressed, and the rendered rows/badge described a
  // combination that does not exist.
  // Turning LIVE ON always leaves the curated layer...
  assert.deepEqual(toggleLiveFilter(false, false), { liveOnly: true, curatedOnly: false });
  assert.deepEqual(toggleLiveFilter(false, true), { liveOnly: true, curatedOnly: false });
  // ...and the result can never have both active, from any starting pair.
  for (const liveOnly of [false, true]) {
    for (const curatedOnly of [false, true]) {
      const next = toggleLiveFilter(liveOnly, curatedOnly);
      assert.equal(
        next.liveOnly && next.curatedOnly,
        false,
        `LIVE and Tempat Pilihan must never both be active (from live=${liveOnly}, curated=${curatedOnly})`,
      );
    }
  }
  // Turning LIVE OFF is exactly a reversal: the curated layer and the rest of
  // the state are untouched — no accidental filter change.
  assert.deepEqual(toggleLiveFilter(true, false), { liveOnly: false, curatedOnly: false });
  assert.deepEqual(toggleLiveFilter(true, true), { liveOnly: false, curatedOnly: true });
  // Curated activation is the mirror image and always clears LIVE.
  assert.deepEqual(activateCuratedFilter(), { liveOnly: false, curatedOnly: true });
  // Turning LIVE off never silently re-enables a layer: it only reverses
  // LIVE itself, leaving the curated layer exactly as it is (false here,
  // because activating LIVE already released it).
  const on = toggleLiveFilter(false, true);
  assert.deepEqual(on, { liveOnly: true, curatedOnly: false });
  assert.deepEqual(toggleLiveFilter(on.liveOnly, on.curatedOnly), {
    liveOnly: false,
    curatedOnly: false,
  });
});

test("Home wires both filter buttons to the exclusive transitions, not to raw setters", () => {
  // Guard against a regression back to bare setters: the buttons must go
  // through the tested transitions so the aria-pressed state and the rendered
  // rows stay consistent with the active mode.
  const homeSource = readFileSync(
    new URL("../components/home-discovery.tsx", import.meta.url),
    "utf8",
  );
  assert.match(homeSource, /const next = toggleLiveFilter\(liveOnly, curatedOnly\);\s*setLiveOnly\(next\.liveOnly\);\s*setCuratedOnly\(next\.curatedOnly\);/);
  assert.match(homeSource, /const next = activateCuratedFilter\(\);\s*setCuratedOnly\(next\.curatedOnly\);\s*setLiveOnly\(next\.liveOnly\);/);
  // LIVE and Tempat Pilihan keep their own aria-pressed binding, and the
  // distance tabs stay deselected while the curated layer is active.
  assert.match(homeSource, /aria-pressed=\{liveOnly\}/);
  assert.match(homeSource, /aria-pressed=\{curatedOnly\}/);
  assert.match(homeSource, /aria-pressed=\{distanceFilter === filter && !curatedOnly\}/);
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
