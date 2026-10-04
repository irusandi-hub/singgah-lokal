import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  boundsOfPoints,
  collectGeoPoints,
  distanceMeters,
  resolveCameraFitPadding,
  resolveContextualCuratedCoverage,
  resolveLocalAreaCoverage,
} from "../lib/live/ui";

/**
 * CONTEXTUAL CURATED CAMERA FRAMING (2026-10-05)
 *
 * THE DEFECT THIS COVERS. "Tempat Pilihan" framed EVERY curated Place in the
 * whole published set in one `fitBounds`. On the canonical dataset that set
 * spans West Java and the Kingdom of Saudi Arabia — roughly 13 000 km — so a
 * single fit produced a WORLD frame in which the viewer's own neighbourhood was
 * a couple of pixels wide. The curated zoom ceiling (`CURATED_FIT_MAX_ZOOM =
 * 13`) could not prevent it, because a maxZoom can only widen a frame that is
 * too TIGHT, never one that is already too wide.
 *
 * THE RULE NOW: the camera frames the curated selection IN THE USER'S CURRENT
 * CONTEXT — the active searched region, otherwise the viewer's local area —
 * resolved by the existing `resolveContextualCuratedCoverage` helper. No
 * curated Place anywhere else can enter that frame, no radius and no
 * hard-coded place is involved, and with no origin the pool is empty so the
 * camera keeps the frame it has.
 *
 * These tests are executable against the real resolver and the real fixtures,
 * and they measure the resulting FRAME (span and the zoom a fit would need)
 * rather than asserting that a helper was called.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}
const mapCode = stripComments(homeMap);
const pageCode = stripComments(homeDiscovery);

type Row = {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  countryCode: string | null;
  regionName: string | null;
};

/** The real canonical geography: West Java (ID) and the Kingdom of Saudi Arabia. */
const BANDUNG = { lat: -6.9, lng: 107.61 };
const RIYADH = { lat: 24.7136, lng: 46.6753 };
const DAMMAM = { lat: 26.4207, lng: 50.0888 };

function row(
  id: string,
  latitude: number | null,
  longitude: number | null,
  countryCode: string,
  regionName: string,
): Row {
  return { id, name: id, latitude, longitude, countryCode, regionName };
}

/** The curated set the canonical dataset actually carries, in two regions. */
const CURATED_JAVA: readonly Row[] = [
  row("cur-java-1", -6.9115, 107.6098, "ID", "Jawa Barat"),
  row("cur-java-2", -6.8214, 107.5849, "ID", "Jawa Barat"),
  row("cur-java-3", -6.8402, 107.6012, "ID", "Jawa Barat"),
];
const CURATED_RIYADH: readonly Row[] = [
  row("cur-riyadh-1", 24.7136, 46.6753, "SA", "Ar Riyad"),
  row("cur-riyadh-2", 24.8241, 46.6432, "SA", "Ar Riyad"),
  row("cur-riyadh-3", 24.6937, 46.6853, "SA", "Ar Riyad"),
];
const CURATED_EASTERN: readonly Row[] = [
  row("cur-east-1", 26.4207, 50.0888, "SA", "Ash Sharqiyah"),
  row("cur-east-2", 26.5, 50.1, "SA", "Ash Sharqiyah"),
];
/** One curated Place with no canonical coordinates at all (fail-closed case). */
const CURATED_WITHOUT_COORDINATES: readonly Row[] = [row("cur-no-coords", null, null, "ID", "Jawa Barat")];
/** A Place whose coordinates are present but not finite (a broken row). */
const CURATED_BROKEN_COORDINATES: readonly Row[] = [row("cur-broken", Number.NaN, 107.6, "ID", "Jawa Barat")];

const ALL_CURATED: readonly Row[] = [
  ...CURATED_JAVA,
  ...CURATED_RIYADH,
  ...CURATED_EASTERN,
  ...CURATED_WITHOUT_COORDINATES,
];

function searchViewportFor(center: { lat: number; lng: number }) {
  return {
    north: center.lat + 0.05,
    south: center.lat - 0.05,
    east: center.lng + 0.05,
    west: center.lng - 0.05,
  };
}

/** Exactly the production composition, mirrored so the rules are executable. */
function curatedFrame(input: {
  origin: { lat: number; lng: number } | null;
  searchCenter?: { lat: number; lng: number } | null;
  curated?: readonly Row[];
}) {
  const curated = input.curated ?? ALL_CURATED;
  return resolveContextualCuratedCoverage({
    curatedPlaces: curated,
    origin: input.searchCenter ?? input.origin,
    searchViewport: input.searchCenter ? searchViewportFor(input.searchCenter) : null,
  });
}

/** The widest straight-line distance between the framed Places, in km. */
function frameSpanKm(places: readonly Row[]): number {
  if (places.length < 2) return 0;
  let widest = 0;
  for (const a of places) {
    for (const b of places) {
      if (a.latitude === null || a.longitude === null) continue;
      if (b.latitude === null || b.longitude === null) continue;
      widest = Math.max(widest, distanceMeters({ lat: a.latitude, lng: a.longitude }, { lat: b.latitude, lng: b.longitude }) / 1000);
    }
  }
  return widest;
}

/**
 * The zoom a `fitBounds` would need for these Places on a phone-sized map,
 * with the real chrome padding. This reproduces Leaflet's own `getBoundsZoom`
 * arithmetic (EPSG:3857, 256 px tiles) so the assertions are about the frame a
 * fit would actually produce, not about a helper being called.
 */
function zoomForFrame(
  places: readonly { latitude: number | null; longitude: number | null }[],
  size = { x: 360, y: 460 },
): number | null {
  const points = collectGeoPoints(places);
  const bounds = boundsOfPoints(points);
  if (!bounds) return null;
  const padding = resolveCameraFitPadding(size);
  const availableX = size.x - (padding.paddingTopLeft[0] + padding.paddingBottomRight[0]);
  const availableY = size.y - (padding.paddingTopLeft[1] + padding.paddingBottomRight[1]);
  if (availableX <= 0 || availableY <= 0) return null;
  const mercatorY = (lat: number) =>
    (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2;
  const lngSpan = Math.max(Math.abs(bounds.east - bounds.west), 1e-9);
  const latSpan = Math.max(Math.abs(mercatorY(bounds.north) - mercatorY(bounds.south)), 1e-9);
  const zoomFromLng = Math.log2(availableX / (lngSpan * (256 / 360)));
  const zoomFromLat = Math.log2(availableY / (latSpan * 256));
  return Math.min(zoomFromLng, zoomFromLat);
}

// ---------------------------------------------------------------------------
// A1 — several curated Places inside ONE relevant area
// ---------------------------------------------------------------------------

test("A1 several curated Places in one area are framed together", () => {
  const coverage = curatedFrame({ origin: BANDUNG, curated: CURATED_JAVA });
  assert.equal(coverage.basis, "area");
  assert.deepEqual(coverage.places.map((place) => place.id), ["cur-java-1", "cur-java-2", "cur-java-3"]);
  // A city-scale selection must NOT be forced out to a world frame.
  assert.ok(frameSpanKm(coverage.places) < 30, `frame span ${frameSpanKm(coverage.places)} km`);
  assert.ok((zoomForFrame(coverage.places) ?? 0) >= 10);
});

// ---------------------------------------------------------------------------
// A2 — the curated layer distributed across DISTANT areas
// ---------------------------------------------------------------------------

test("A2 curated Places in distant regions never produce one global frame", () => {
  // The whole canonical curated layer, West Java + Riyadh + the Eastern
  // Province. The frame must be ONE area, never the layer.
  const java = curatedFrame({ origin: BANDUNG });
  assert.equal(java.places.some((place) => place.id.startsWith("cur-riyadh")), false);
  assert.equal(java.places.some((place) => place.id.startsWith("cur-east")), false);

  const riyadh = curatedFrame({ origin: RIYADH });
  assert.equal(riyadh.places.some((place) => place.id.startsWith("cur-java")), false);
  assert.equal(riyadh.places.some((place) => place.id.startsWith("cur-east")), false);

  // The layer itself really does span continents — that is the defect.
  assert.ok(frameSpanKm(ALL_CURATED) > 7_000, "the curated layer is genuinely global");
  const globalZoom = zoomForFrame(ALL_CURATED);
  assert.ok((globalZoom ?? 99) < 5, `an all-curated fit would zoom out to zoom ${globalZoom}`);

  // ...and each contextual frame is a normal map level instead.
  for (const coverage of [java, riyadh]) {
    assert.ok(frameSpanKm(coverage.places) < 100);
    assert.ok((zoomForFrame(coverage.places) ?? 0) >= 9, "a contextual frame is never a world view");
  }
});

test("A2b a viewer in a third region gets THAT area, not the layer", () => {
  const eastern = curatedFrame({ origin: DAMMAM });
  assert.equal(eastern.basis, "area");
  assert.deepEqual(eastern.places.map((place) => place.id), ["cur-east-1", "cur-east-2"]);
});

// ---------------------------------------------------------------------------
// A3 — the context changes after a search
// ---------------------------------------------------------------------------

test("A3 a new searched region re-frames the curated camera onto that region", () => {
  const deviceInJava = curatedFrame({ origin: BANDUNG });
  assert.ok(deviceInJava.places.every((place) => place.id.startsWith("cur-java")));

  // The same viewer searches "Riyadh": the frame follows the SEARCH, not the
  // device, and a stale geolocation update can never pull it back.
  const searched = curatedFrame({ origin: BANDUNG, searchCenter: RIYADH });
  assert.equal(searched.basis, "search");
  assert.deepEqual(searched.places.map((place) => place.id), ["cur-riyadh-1", "cur-riyadh-3"]);
  assert.equal(searched.places.some((place) => place.id.startsWith("cur-java")), false);
  assert.ok(frameSpanKm(searched.places) < 30);

  // The searched city owns the frame: the component reads exactly the two
  // stable state values the resolver is given.
  assert.match(pageCode, /origin: searchCenter \?\? viewerPosition,/);
});

test("A3b clearing the search returns the frame to the real fix", () => {
  const afterClear = curatedFrame({ origin: BANDUNG, searchCenter: null });
  assert.equal(afterClear.basis, "area");
  assert.ok(afterClear.places.every((place) => place.id.startsWith("cur-java")));
});

// ---------------------------------------------------------------------------
// A4 — current-location framing
// ---------------------------------------------------------------------------

test("A4 current-location framing is preserved and stays local", () => {
  const located = curatedFrame({ origin: RIYADH });
  assert.equal(located.basis, "area");
  assert.ok(located.places.length > 0);
  assert.ok(located.places.every((place) => place.id.startsWith("cur-riyadh")));

  // "Lokasi Saya" reads the SAME dataset in curated mode, so the press frames
  // the local selection instead of a distant layer.
  assert.match(pageCode, /const locateFitPlaces = curatedOnly \? curatedFitPlaces : selectedFitPlaces;/);
  // ...and it keeps its own trigger, its own latch, and its own close floor.
  assert.match(mapCode, /const applied = await fitCamera\(map, candidates, LOCATE_FIT_MAX_ZOOM\)/);
  assert.match(mapCode, /if \(!locateNonce \|\| lastLocateNonceRef\.current === locateNonce\) return;/);
});

test("A4b an origin inside no curated area frames one area, never the whole layer", () => {
  // Fail-closed: with the device somewhere that holds no curated Place, the
  // local-area rule still resolves the nearest curated Place's own
  // subdivision, so the frame is that ONE area — never West Java AND Riyadh
  // AND the Eastern Province at once.
  const farAway = curatedFrame({ origin: { lat: -8.5, lng: 115.2 } });
  const ids = farAway.places.map((place) => place.id);
  assert.ok(ids.length > 0);
  assert.ok(ids.every((id) => id.startsWith("cur-java")), `framed ${ids.join(", ")}`);
});

// ---------------------------------------------------------------------------
// A5 — empty and invalid coordinates
// ---------------------------------------------------------------------------

test("A5 a curated Place without coordinates is never framed", () => {
  const coverage = curatedFrame({ origin: BANDUNG, curated: CURATED_WITHOUT_COORDINATES });
  assert.equal(coverage.places.length, 0);
  assert.equal(coverage.basis, "none");
  assert.equal(zoomForFrame(coverage.places), null);
});

test("A5b a non-finite coordinate is dropped by the resolver itself", () => {
  const coverage = curatedFrame({ origin: BANDUNG, curated: CURATED_BROKEN_COORDINATES });
  assert.equal(coverage.places.length, 0);
  assert.equal(coverage.basis, "none");
});

test("A5c no origin at all frames nothing — there is never a world fallback", () => {
  const coverage = curatedFrame({ origin: null });
  assert.deepEqual(coverage.places, []);
  assert.equal(coverage.basis, "none");
  // The component therefore leaves the camera exactly where it is: `fitCamera`
  // returns false for an empty dataset and moves nothing.
  assert.match(mapCode, /const bounds = boundsOfPoints\(points\);\s*if \(!bounds\) return false;/);
});

// ---------------------------------------------------------------------------
// A6 — membership, order, and independence from the viewport
// ---------------------------------------------------------------------------

test("A6 contextual framing never changes curated membership, order, or rows", () => {
  // The candidates are still exactly the canonical curated ids over the full
  // published set — context bounds WHICH are framed, never WHICH are curated.
  const pool = pageCode.slice(pageCode.indexOf("const curatedFitPlaces"), pageCode.indexOf("const cameraFitPlaces"));
  assert.match(pool, /curatedIdSet\.has\(place\.id\)/);
  assert.match(pool, /places\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\)/);

  // The curated LIST and both rows still read canonical membership only.
  assert.match(
    pageCode,
    /const curatedListed = useMemo\(\s*\(\) => narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
  assert.match(pageCode, /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/);

  // Canonical input order is preserved by the resolver.
  const reversed = [...CURATED_JAVA].reverse();
  const coverage = curatedFrame({ origin: BANDUNG, curated: reversed });
  assert.deepEqual(coverage.places.map((place) => place.id), reversed.map((place) => place.id));
});

test("A6b the camera dataset stays independent of the reported viewport", () => {
  // A circular dependency would make the camera chase its own markers.
  const pool = pageCode.slice(pageCode.indexOf("const curatedFitPlaces"), pageCode.indexOf("const cameraFitPlaces"));
  assert.doesNotMatch(pool, /mapViewport|coverageViewport|visibleMapPlaces/);
  // ...and no viewport report can re-frame it: the curated fit is keyed on the
  // explicit nonce alone.
  assert.match(mapCode, /const fitChanged = fitNonce > 0 && fitNonce !== lastFitNonceRef\.current;/);
  assert.equal((pageCode.match(/setFitNonce\(\(nonce\) => nonce \+ 1\)/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// A7 — the zoom ceiling and the easing are untouched
// ---------------------------------------------------------------------------

test("A7 the curated zoom ceiling of 13 is preserved and can only widen", () => {
  assert.match(mapCode, /const CURATED_FIT_MAX_ZOOM = 13;/);
  assert.match(mapCode, /const applied = await fitCamera\(map, fitPlacesRef\.current, CURATED_FIT_MAX_ZOOM\)/);
  // A ceiling can only WIDEN a frame, so no candidate is ever dropped by it.
  assert.match(
    mapCode,
    /typeof maxZoom === "number" \? \{ maxZoom \} : \{\}/,
  );
  // Executable form of the same rule.
  const tight = zoomForFrame([
    { latitude: -6.9115, longitude: 107.6098 },
    { latitude: -6.9116, longitude: 107.6099 },
  ]);
  assert.ok((tight ?? 0) > 13, "a tight selection would exceed the ceiling, which then widens it");
  assert.equal(Math.min(tight ?? 0, 13), 13);
});

test("A8 the approved camera easing is still the single shared helper", () => {
  assert.match(
    mapCode,
    /function cameraAnimationOptions\(\): \{ animate: boolean; duration\?: number; easeLinearity\?: number \} \{[\s\S]*?duration: 0\.6,[\s\S]*?easeLinearity: 0\.25/,
  );
  // Every camera apply still routes through it, including all three fits.
  assert.match(mapCode, /map\.setView\(\[points\[0\]\.lat, points\[0\]\.lng\], singleZoom, \{ \.\.\.cameraAnimationOptions\(\) \}\)/);
  assert.match(mapCode, /\.\.\.cameraAnimationOptions\(\),\n      \}\);\n      return true;/);
  assert.match(mapCode, /map\.setView\(\[viewerPosition\.lat, viewerPosition\.lng\], Math\.max\(map\.getZoom\(\), LOCATE_MIN_ZOOM\), \{\s*\.\.\.cameraAnimationOptions\(\)/);
  assert.match(mapCode, /map\.setView\(\[searchCenter\.lat, searchCenter\.lng\], Math\.max\(map\.getZoom\(\), SEARCH_MIN_ZOOM\), \{\s*\.\.\.cameraAnimationOptions\(\)/);
  // Reduced motion still falls back to the instant apply.
  assert.match(mapCode, /if \(reduced\) return \{ animate: false \};/);
});

test("A9 the curated pool is CAMERA geometry only — no state, no new control", () => {
  // It is never stored, never a filter, and never reaches a result row.
  assert.doesNotMatch(pageCode, /setCameraFit|setCuratedContext|setContextPlaces/);
  // No new control, tab, or filter was introduced by this change: the bar is
  // still exactly LIVE + "Tempat Pilihan" + the three ordered distance tabs,
  // and the two mode switches still go through the shared helpers.
  assert.equal((pageCode.match(/DISTANCE_FILTERS\.map/g) ?? []).length, 1);
  assert.match(pageCode, /activateCuratedFilter\(\)/);
  assert.match(pageCode, /toggleLiveFilter\(liveOnly, curatedOnly\)/);
  assert.match(pageCode, />\s*Tempat Pilihan\s*<\/button>/);
  assert.match(pageCode, />\s*LIVE\s*<\/button>/);
  // ...and the tab set itself is untouched.
  assert.deepEqual(
    [...pageCode.matchAll(/setCameraRequestNonce\(\(nonce\) => nonce \+ 1\)/g)].length,
    3,
  );
});

test("A10 the local-area resolver still owns the geographic decision", () => {
  // Contextual framing adds no new geographic rule: it delegates to the
  // existing resolver, which is bounded by trusted canonical geography.
  const coverage = curatedFrame({ origin: RIYADH });
  const resolver = resolveLocalAreaCoverage({ origin: RIYADH, places: CURATED_RIYADH });
  assert.equal(coverage.basis, "area");
  assert.deepEqual(coverage.places.map((place) => place.id), resolver.places.map((place) => place.id));
});