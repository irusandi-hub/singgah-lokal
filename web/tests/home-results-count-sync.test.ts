import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMERA_PRESET_RADIUS_M,
  DISTANCE_FILTERS,
  clearCitySearch,
  describeNearOrigin,
  describeRadiusOrigin,
  narrowToViewport,
  resolveActiveCenter,
  resolveSearchOrigin,
  type ActiveCenter,
  type MapViewport,
} from "../lib/live/ui";

/**
 * RESULTS SECTION <-> SEARCH STATE CONSISTENCY (bug fix 2026-10-03)
 *
 * An audit of `main` found the last remaining Requirement-D inconsistency.
 * The map coverage caption had already been fixed to name the active search
 * origin, but the results-section count subtitle was still hardcoded to
 * "di sekitar Anda". Searching "Riyadh" therefore rendered, on one screen:
 *
 *     Area pencarian: 24.6389, 46.7160        (correct)
 *     Menampilkan tempat dalam radius 1 km dari pusat pencarian Riyadh   (correct)
 *     12 tempat di sekitar Anda               (WRONG — Dammam, 392 km away)
 *
 * The two text elements disagreed with each other. This suite locks shut:
 *   - one shared origin resolver feeding BOTH the caption and the count, so
 *     they can never name different places again;
 *   - the count NUMBER is the exact array the row renders from, per layer, so
 *     it cannot disagree with the cards on screen;
 *   - the Master/MOCKUP §11 device wording stays VERBATIM (default case).
 */

/** The two real coordinates from the device report. */
const RIYADH: ActiveCenter = { lat: 24.6389, lng: 46.716 };
const DAMMAM: ActiveCenter = { lat: 26.4207, lng: 50.0888 };

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const discoveryCode = stripComments(homeDiscovery);

// ---------------------------------------------------------------------------
// One origin resolver, two consumers — they can never diverge
// ---------------------------------------------------------------------------

test("D: the caption and the count resolve their origin from the SAME function", () => {
  // If these ever diverged, the screen would contradict itself again.
  assert.match(discoveryCode, /const radiusCaption = describeRadiusOrigin\(\{/);
  assert.match(discoveryCode, /const nearOrigin = describeNearOrigin\(\{ mode: activeSearch\.mode, placeName: searchPlaceName \}\);/);
  // Both read the identical inputs: the active mode and the resolved name.
  assert.match(discoveryCode, /describeRadiusOrigin\(\{\s*\n\s*radiusLabel: activeRadiusLabel,\s*\n\s*mode: activeSearch\.mode,\s*\n\s*placeName: searchPlaceName,/);
  // No hardcoded user-origined copy may remain in either element.
  assert.doesNotMatch(discoveryCode, /tempat di sekitar Anda`/);
  assert.doesNotMatch(discoveryCode, /tempat pilihan di sekitar Anda`/);
});

test("D: resolveSearchOrigin is the single source for the origin phrase", () => {
  assert.equal(resolveSearchOrigin({ mode: "city_search", placeName: "Riyadh" }), "pusat pencarian Riyadh");
  assert.equal(resolveSearchOrigin({ mode: "city_search", placeName: null }), "pusat area pencarian");
  assert.equal(resolveSearchOrigin({ mode: "city_search", placeName: "   " }), "pusat area pencarian");
  assert.equal(resolveSearchOrigin({ mode: "device_location", placeName: "Riyadh" }), "lokasi Anda");
  // A device origin must never leak a searched city into the phrase.
  assert.equal(resolveSearchOrigin({ mode: "device_location", placeName: "Riyadh" }).includes("Riyadh"), false);
});

// ---------------------------------------------------------------------------
// Scenario 1 — city search ("Riyadh")
// ---------------------------------------------------------------------------

test("SCENARIO city search: every element describes the Riyadh origin", () => {
  const { mode, center } = resolveActiveCenter({ searchCenter: RIYADH, viewerPosition: DAMMAM });
  assert.equal(mode, "city_search");
  assert.deepEqual(center, RIYADH);

  const name = "Riyadh";
  // The map caption.
  assert.equal(
    describeRadiusOrigin({ radiusLabel: "1 km", mode, placeName: name }),
    "Menampilkan tempat dalam radius 1 km dari pusat pencarian Riyadh",
  );
  // The results count — the exact text that was wrong before.
  assert.equal(
    `${12} tempat ${describeNearOrigin({ mode, placeName: name })}`,
    "12 tempat di sekitar pusat pencarian Riyadh",
  );
  // Both name the SAME place, so the screen is self-consistent.
  assert.ok(describeRadiusOrigin({ radiusLabel: "1 km", mode, placeName: name }).includes("Riyadh"));
  assert.ok(describeNearOrigin({ mode, placeName: name }).includes("Riyadh"));
});

test("SCENARIO city search: the count and the rendered cards come from one array per layer", () => {
  // curated mode -> Baris 1 renders `curatedListed`; otherwise -> the Discovery
  // row renders `discoveryRowPlaces`. The count MUST be the .length of exactly
  // those, or the header would disagree with the visible cards.
  assert.match(
    discoveryCode,
    /curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\}`\n\s*: `\$\{discoveryRowPlaces\.length\} tempat \$\{nearOrigin\}`/,
  );
  // Baris 1 renders exactly curatedListed, and the single row everywhere else
  // renders exactly discoveryRowPlaces.
  assert.match(discoveryCode, /curatedOnly && curatedListed\.length > 0/);
  assert.match(discoveryCode, /\{discoveryRowPlaces\.length > 0 \? \(/);
  assert.match(discoveryCode, /\{curatedListed\.map\(\(place\) =>/);
  assert.match(discoveryCode, /\{discoveryRowPlaces\.map\(\(place\) =>/);
  // The per-layer rule (PO 2026-09-30) is preserved — the counts are never
  // summed, which would double-count a Place present in both rows.
  assert.doesNotMatch(discoveryCode, /curatedListed\.length \+ discoveryRowPlaces\.length/);
});

test("SCENARIO city search: a Place the coverage admitted is counted from that same coverage", () => {
  // Executable proof that the count tracks the ACTIVE center: the Riyadh
  // Places are counted and the Dammam ones are not.
  const viewport: MapViewport = { north: 24.69, south: 24.59, east: 46.77, west: 46.67 };
  const all = [
    { id: "r1", latitude: 24.64, longitude: 46.72 },
    { id: "d1", latitude: 26.42, longitude: 50.09 },
    { id: "r2", latitude: 24.66, longitude: 46.70 },
  ];
  assert.equal(narrowToViewport(all, viewport).length, 2);
  // No fallback: a frame with none yields 0, never the unfiltered total.
  assert.equal(narrowToViewport(all, { north: 0, south: -1, east: 1, west: -1 }).length, 0);
});

// ---------------------------------------------------------------------------
// Scenario 2 — radius change while a city is searched
// ---------------------------------------------------------------------------

test("SCENARIO radius change: the origin is unchanged, only the radius moves", () => {
  for (const tab of DISTANCE_FILTERS) {
    const meters = CAMERA_PRESET_RADIUS_M[tab];
    const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
    const mode = "city_search" as const;

    assert.equal(
      describeRadiusOrigin({ radiusLabel: label, mode, placeName: "Riyadh" }),
      `Menampilkan tempat dalam radius ${label} dari pusat pencarian Riyadh`,
    );
    // The COUNT keeps naming Riyadh at every radius — the origin is not a
    // function of the radius tab.
    assert.equal(describeNearOrigin({ mode, placeName: "Riyadh" }), "di sekitar pusat pencarian Riyadh");
  }
  assert.ok(CAMERA_PRESET_RADIUS_M["1 km"] < CAMERA_PRESET_RADIUS_M["5 km"]);
  assert.ok(CAMERA_PRESET_RADIUS_M["5 km"] < CAMERA_PRESET_RADIUS_M["10 km+"]);
});

// ---------------------------------------------------------------------------
// Scenario 3 — "Lokasi Saya" after a city search
// ---------------------------------------------------------------------------

test("SCENARIO Lokasi Saya: the count returns to the device origin and never keeps the city", () => {
  const cleared = clearCitySearch();
  assert.equal(cleared.placeName, null, "the resolved city name must be cleared too");
  assert.equal(cleared.query, "");

  const after = resolveActiveCenter({ searchCenter: cleared.center, viewerPosition: DAMMAM });
  assert.equal(after.mode, "device_location");

  // The count reverts to the Master wording, verbatim.
  assert.equal(describeNearOrigin({ mode: after.mode, placeName: cleared.placeName }), "di sekitar Anda");
  assert.equal(
    `${7} tempat ${describeNearOrigin({ mode: after.mode, placeName: cleared.placeName })}`,
    "7 tempat di sekitar Anda",
  );
  assert.equal(describeNearOrigin({ mode: after.mode, placeName: cleared.placeName }).includes("Riyadh"), false);
});

test("SCENARIO Lokasi Saya: the reset clears the count's inputs at every call site", () => {
  const clears = discoveryCode.match(/setSearchPlaceName\(cleared\.placeName\);/g) ?? [];
  assert.ok(clears.length >= 3, `all reset paths must clear the name, found ${clears.length}`);
  // And the count's origin derives from that same cleared state.
  assert.match(discoveryCode, /placeName: searchPlaceName/);
});

// ---------------------------------------------------------------------------
// Master wording preserved
// ---------------------------------------------------------------------------

test("the Master/MOCKUP §11 device wording is preserved VERBATIM", () => {
  // "{n} tempat pilihan di sekitar Anda" is quoted by the mockup and is the
  // default (no city searched) experience. Only the city case may differ.
  assert.equal(describeNearOrigin({ mode: "device_location", placeName: null }), "di sekitar Anda");
  assert.equal(
    `${10} tempat pilihan ${describeNearOrigin({ mode: "device_location", placeName: null })}`,
    "10 tempat pilihan di sekitar Anda",
  );
  assert.equal(
    `${10} tempat ${describeNearOrigin({ mode: "device_location", placeName: null })}`,
    "10 tempat di sekitar Anda",
  );
});

test("no Place data is invented to satisfy a count", () => {
  // The count is a pure `.length` of rendered arrays. A zero result renders the
  // honest empty state — it never falls back to showing something so the
  // number looks better.
  assert.match(discoveryCode, /\{discoveryRowPlaces\.length > 0 \? \(/);
  assert.match(discoveryCode, /Belum ada Discovery Place/);
  assert.match(discoveryCode, /Tempat tidak ditemukan/);
});