import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SEARCH_AREA_FALLBACK_DEGREES,
  fallbackSearchArea,
  isWithinViewport,
  narrowToViewport,
  normalizeSearchArea,
  toggleLiveFilter,
  activateCuratedFilter,
  type MapViewport,
} from "../lib/live/ui";
import {
  parseGeocodeBounds,
  parseGeocodeResponse,
} from "../lib/live/geocoding-core";

/**
 * HOME LOCATION SEARCH — SUBMITTED QUERY + CANONICAL SEARCH AREA (2026-10-04)
 *
 * Two defects, one correction each.
 *
 *  1. TYPING WAS THE SEARCH. The draft in the input was also the live Place
 *     text filter, so every keystroke changed the rows and the markers before
 *     the user had committed to anything. The input now edits a DRAFT only;
 *     the committed SUBMITTED query is the single text filter, and Enter and
 *     the "Cari" button share ONE submit path with one in-flight guard.
 *
 *  2. A CITY SEARCH COVERED A FEW KILOMETRES. Coverage was a fixed ±0.05°
 *     window around the geocoder's centre point, the search camera framed only
 *     the Places inside that window, and Leaflet then reported that small
 *     frame as the real viewport — so searching "Riyadh" excluded every
 *     eligible Place on the far side of the city. Coverage is now the
 *     CANONICAL BOUNDING BOX the geocoder itself publishes for the hit it
 *     resolved; the fixed window survives only as the documented last resort
 *     for an answer that carries no usable boundary.
 *
 * The behavioural tests below run against the real resolvers; the wiring
 * tests read the component, which is how every other Home guarantee in this
 * repository is pinned.
 */

const homeDiscovery = readFileSync(
  new URL("../components/home-discovery.tsx", import.meta.url),
  "utf8",
);
const geocodeRoute = readFileSync(new URL("../app/api/geocode/route.ts", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const pageCode = stripComments(homeDiscovery);

type Row = {
  id: string;
  latitude: number | null;
  longitude: number | null;
};

const RIYADH_CENTER: [number, number] = [24.6389, 46.716];

/** The canonical bounding box Nominatim publishes for the city of Riyadh. */
const RIYADH_BOUNDS = {
  south: "24.4637",
  north: "24.9836",
  west: "46.6163",
  east: "46.8501",
};

function hit(overrides: Record<string, unknown> = {}) {
  return {
    lat: "24.6389",
    lon: "46.7160",
    display_name: "Riyadh, Riyadh, Saudi Arabia",
    type: "place",
    boundingbox: [RIYADH_BOUNDS.south, RIYADH_BOUNDS.north, RIYADH_BOUNDS.west, RIYADH_BOUNDS.east],
    ...overrides,
  };
}

function rows(...items: Array<[string, number, number]>): Row[] {
  return items.map(([id, latitude, longitude]) => ({ id, latitude, longitude }));
}

// ---------------------------------------------------------------------------
// 1. Typing alone does not search.
// ---------------------------------------------------------------------------

test("1: the Place text filter reads the SUBMITTED query, never the draft", () => {
  // The single content filter every layer shares.
  assert.match(
    pageCode,
    /const searchFiltered = useMemo\(\(\) => \{\s*const normalizedQuery = submittedQuery\.trim\(\)/,
  );
  assert.match(pageCode, /\}, \[places, submittedQuery, liveByPlaceId\]\);/);
  // And the draft is still what the input is bound to.
  assert.match(pageCode, /const handleSearchChange = useCallback\(\(value: string\) => \{\s*setSearchQuery\(value\);/);
  assert.match(pageCode, /value=\{searchQuery\}/);
  // No keystroke path may reach the geocoder, the rows, or the camera.
  assert.doesNotMatch(pageCode, /onChange=\{\(event\) => handleSearchSubmit/);
  assert.equal(/handleSearchChange[\s\S]{0,400}api\/geocode/.test(pageCode), false);
});

// ---------------------------------------------------------------------------
// 2-4. One submit path, entered once; empty submission clears.
// ---------------------------------------------------------------------------

test("2: Enter submits the current draft through the single submit path", () => {
  assert.match(
    pageCode,
    /const handleSearchKeyDown = useCallback\([\s\S]{0,400}?if \(event\.key === "Enter"\) \{\s*event\.preventDefault\(\);\s*handleSearchSubmit\(event\.currentTarget\.value\);/,
  );
  // One geocode call site in the whole component.
  assert.equal((pageCode.match(/api\/geocode/g) ?? []).length, 1);
});

test("3: 'Cari' submits the same draft through the SAME path, exactly once", () => {
  assert.match(
    pageCode,
    /const handleSearchSubmitClick = useCallback\(\(\) => \{\s*handleSearchSubmit\(searchQuery\);/,
  );
  // The button in the field calls that handler, not a second implementation.
  assert.match(
    pageCode,
    /onClick=\{handleSearchSubmitClick\}\s*\n\s*disabled=\{searchPending\}\s*\n\s*className="[^"]*bg-brand-primary[^"]*"/,
  );
  // It is a real button with an accessible name, and it cannot submit a form.
  assert.match(pageCode, /<button\s*\n\s*type="button"\s*\n\s*onClick=\{handleSearchSubmitClick\}/);
  assert.match(pageCode, /aria-label="Cari lokasi"/);
  assert.match(pageCode, />\s*Cari\s*<\/button>/);
  // A repeated identical submit while one is in flight is a NO-OP, so Enter
  // followed by a tap (or a held Enter key) cannot issue two geocodes.
  assert.match(
    pageCode,
    /if \(inFlightSearchRef\.current === trimmed\) return;\s*\n\s*inFlightSearchRef\.current = trimmed;/,
  );
  assert.match(
    pageCode,
    /finally \{[\s\S]*?if \(inFlightSearchRef\.current === trimmed\) inFlightSearchRef\.current = null;/,
  );
});

test("4: an empty submission follows the established clear semantics", () => {
  const submit = pageCode.slice(
    pageCode.indexOf("const handleSearchSubmit = useCallback"),
    pageCode.indexOf("const requestEpoch = searchEpochRef.current;"),
  );
  // It never geocodes, and it resets exactly what a real clear resets.
  assert.match(submit, /if \(!trimmed\) \{/);
  assert.doesNotMatch(submit, /api\/geocode/);
  for (const reset of [
    "searchEpochRef.current += 1;",
    'submittedSearchRef.current = "";',
    "inFlightSearchRef.current = null;",
    "setSearchQuery(cleared.query);",
    "setSubmittedQuery(cleared.query);",
    "setSearchPending(cleared.pending);",
    "setSearchError(cleared.error);",
    "setSearchCenter(cleared.center);",
    "setSearchArea(null);",
    "setSearchPlaceName(cleared.placeName);",
  ]) {
    assert.ok(submit.includes(reset), `empty submit must run: ${reset}`);
  }
});

// ---------------------------------------------------------------------------
// 5-6. Clearing, and stale responses.
// ---------------------------------------------------------------------------

test("5: X clears draft AND submitted search and invalidates stale responses", () => {
  const clear = pageCode.slice(
    pageCode.indexOf("const handleSearchClear = useCallback"),
    pageCode.indexOf("const handleLocatePress = useCallback"),
  );
  assert.ok(clear.length > 0, "the clear handler must exist");
  for (const reset of [
    "searchEpochRef.current += 1;",
    'submittedSearchRef.current = "";',
    "inFlightSearchRef.current = null;",
    "setSearchQuery(cleared.query);",
    "setSubmittedQuery(cleared.query);",
    "setSearchCenter(cleared.center);",
    "setSearchArea(null);",
  ]) {
    assert.ok(clear.includes(reset), `clear must run: ${reset}`);
  }
  // It must NOT release the viewport latch: the map did not move, so the last
  // reported bounds are still the browsing context. Nulling them would leave
  // every row unnarrowed until the next pan or zoom.
  assert.equal(clear.includes("resetViewportLatch()"), false);
  // The epoch/submitted-query guard itself is the pre-existing one, unchanged.
  assert.match(pageCode, /const isCurrent = \(\) =>\s*\n\s*acceptSearchResponse\(\{\s*\n\s*requestEpoch,\s*\n\s*currentEpoch: searchEpochRef\.current,\s*\n\s*submitted: trimmed,\s*\n\s*activeQuery: submittedSearchRef\.current,/);
});

test("6: a stale answer can neither move the map nor restore its area", () => {
  const submit = pageCode.slice(
    pageCode.indexOf("const handleSearchSubmit = useCallback"),
    pageCode.indexOf("const handleSearchKeyDown"),
  );
  // Every response path re-checks BOTH guards before it may write state.
  const guards = submit.match(/if \(submittedSearchRef\.current !== trimmed\) return;/g) ?? [];
  const epochs = submit.match(/if \(!isCurrent\(\)\) return;/g) ?? [];
  assert.ok(guards.length >= 3, `every await boundary re-checks the query (found ${guards.length})`);
  assert.ok(epochs.length >= 3, `every await boundary re-checks the epoch (found ${epochs.length})`);
  // The centre and the area are written together, after the guards only.
  assert.match(
    submit,
    /setSearchCenter\(\{ lat: latitude, lng: longitude \}\);\s*\n(?:\s*\/\/[^\n]*\n)*\s*setSearchArea\(normalizeSearchArea\(result\.bounds\)\);/,
  );
  // And every failure branch drops the area with the centre, so a failed search
  // never leaves the previous city's coverage behind.
  assert.ok((submit.match(/setSearchArea\(null\);/g) ?? []).length >= 4);
});

// ---------------------------------------------------------------------------
// 7-8, 10. Coverage.
// ---------------------------------------------------------------------------

test("7: a submitted search is not narrowed by the previously chosen distance preset", () => {
  // The preset is a CAMERA radius only — it is never a Place filter (the
  // existing contract), and it is not what a search covers either.
  assert.match(pageCode, /const searchViewport = useMemo<MapViewport \| null>\(/);
  assert.match(pageCode, /\(searchArea \? searchArea : searchCenter \? fallbackSearchArea\(searchCenter\) : null\)/);
  const searchViewportMemo = pageCode.slice(
    pageCode.indexOf("const searchViewport"),
    pageCode.indexOf("const liveCards"),
  );
  assert.doesNotMatch(searchViewportMemo, /CAMERA_PRESET_RADIUS_M|distanceFilter/);
  // A resolved answer claims the AREA caption, not the preset's radius: the
  // frame it produces is the searched place, not "N km from its centre".
  assert.match(pageCode, /setSearchCenter\(\{ lat: latitude, lng: longitude \}\);[\s\S]{0,900}?setCameraCoverage\("area"\);/);
  // Choosing a distance tab afterwards still owns its own radius caption.
  assert.match(pageCode, /setDistanceFilter\(filter\);[\s\S]{0,400}?setCameraCoverage\("radius"\);/);
});

test("8: search coverage spans the resolved AREA, not only what is near the centre", () => {
  const bounds = parseGeocodeBounds([
    RIYADH_BOUNDS.south,
    RIYADH_BOUNDS.north,
    RIYADH_BOUNDS.west,
    RIYADH_BOUNDS.east,
  ]);
  assert.ok(bounds);
  const area: MapViewport = bounds;

  // The canonical dataset is spread across the whole city; the OLD fixed
  // window kept only the middle of it, which is the reported defect.
  const places = rows(
    ["city-centre", 24.6389, 46.716],
    ["north-rim", 24.9412, 46.7203],
    ["south-rim", 24.5219, 46.7812],
    ["west-rim", 24.7001, 46.6345],
    ["east-rim", 24.7402, 46.8299],
  );

  const inArea = narrowToViewport(places, area).map((place) => place.id);
  assert.deepEqual(
    [...inArea].sort(),
    ["city-centre", "east-rim", "north-rim", "south-rim", "west-rim"],
    "every eligible Place across the resolved area is listed",
  );
  // Each of them really is inside the published box, and the centre really is
  // the middle of the city rather than its boundary.
  for (const place of places) {
    assert.equal(
      isWithinViewport(area, place.latitude as number, place.longitude as number),
      true,
      `${place.id} must be inside the canonical area`,
    );
  }

  // The behaviour this replaces, on the same data.
  const legacy = fallbackSearchArea({ lat: RIYADH_CENTER[0], lng: RIYADH_CENTER[1] });
  const legacyIds = narrowToViewport(places, legacy).map((place) => place.id);
  assert.deepEqual(legacyIds, ["city-centre"], "the fixed window listed only the centre — the bug");
  assert.ok(inArea.length > legacyIds.length, "the canonical box is strictly wider than the guess");
  // The fallback is a documented last resort, not the model of a place.
  assert.equal(SEARCH_AREA_FALLBACK_DEGREES, 0.05);
  assert.equal(fallbackSearchArea({ lat: 1, lng: 2 }).north, 1 + SEARCH_AREA_FALLBACK_DEGREES);
});

test("9: markers and rows read ONE coverage source", () => {
  // Both the marker dataset and the listed rows narrow with the same
  // `coverageViewport`, which is the real viewport or the searched area — there
  // is no second, narrower search box anywhere.
  assert.match(pageCode, /const coverageViewport = mapViewport \?\? searchViewport;/);
  assert.match(pageCode, /const listedPlaces = useMemo\(\s*\(\) => narrowToViewport\(visiblePlaces, coverageViewport\),/);
  assert.match(pageCode, /narrowToViewport\(canonical, coverageViewport\)/);
  assert.match(pageCode, /narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/);
  // The search camera frames the SAME box, so the reported viewport and the
  // rows it narrows cannot disagree. It reads the MODE-INDEPENDENT eligible
  // pool (correction 2026-10-05), so selecting "Tempat Pilihan" cannot shrink
  // the framed set to the curated subset.
  assert.match(
    pageCode,
    /const searchFitPlaces = useMemo<HomeMapPlace\[\]>\(\(\) => \{[\s\S]*?narrowToViewport\(cameraEligiblePlaces, searchViewport\)/,
  );
});

test("10: clearing search restores viewport-driven coverage", () => {
  // The area never outranks the real viewport, and the latch is released on
  // every NEW answer, so a searched area is never a permanent latch that would
  // refuse to follow the user's own panning.
  assert.match(pageCode, /const coverageViewport = mapViewport \?\? searchViewport;/);
  assert.match(pageCode, /const resetViewportLatch = useCallback\(\(\) => \{\s*lastViewportRef\.current = null;\s*setMapViewport\(null\);/);
  const clear = pageCode.slice(
    pageCode.indexOf("const handleSearchClear = useCallback"),
    pageCode.indexOf("const handleLocatePress = useCallback"),
  );
  assert.ok(clear.length > 0, "the clear handler must exist");
  assert.ok(clear.includes("setSearchArea(null)"), "clearing drops the searched area");
  assert.ok(clear.includes("setSearchCenter(cleared.center)"), "clearing drops the resolved center");
  assert.equal(clear.includes("resetViewportLatch()"), false, "the map did not move, so its bounds stay");
});

// ---------------------------------------------------------------------------
// The geocoder contract: a canonical boundary, or honestly none.
// ---------------------------------------------------------------------------

test("geocoder: the published bounding box becomes the searched area", () => {
  const result = parseGeocodeResponse([hit()], "Riyadh");
  assert.ok(result);
  assert.ok(result.bounds, "a settlement hit publishes its area");
  assert.deepEqual(result.bounds, {
    north: Number(RIYADH_BOUNDS.north),
    south: Number(RIYADH_BOUNDS.south),
    east: Number(RIYADH_BOUNDS.east),
    west: Number(RIYADH_BOUNDS.west),
  });
  // The centre is unchanged — it is still the camera fallback, not the area.
  assert.equal(result.latitude, 24.6389);
  assert.equal(result.longitude, 46.716);
  // The route passes the whole canonical result through, bounds included.
  assert.match(geocodeRoute, /NextResponse\.json\(result,/);
});

test("geocoder: a hit with no usable boundary yields null, never a guess", () => {
  for (const boundingbox of [
    undefined,
    null,
    [],
    ["24.4637"],
    ["24.4637", "24.9836", "46.6163"],
    ["a", "b", "c", "d"],
    [null, null, null, null],
  ]) {
    const result = parseGeocodeResponse([hit({ boundingbox })], "Riyadh");
    assert.ok(result, "the centre is still resolved — only the area is absent");
    assert.equal(result.bounds, null, `no invented area for ${JSON.stringify(boundingbox)}`);
    assert.equal(normalizeSearchArea(result.bounds), null);
  }
});

test("geocoder: a degenerate or out-of-range box is rejected, a reversed one repaired", () => {
  // Zero area: a point, not a place.
  assert.equal(parseGeocodeBounds(["24.6389", "24.6389", "46.716", "46.716"]), null);
  assert.equal(parseGeocodeBounds(["24.6389", "24.6389", "46.9", "46.7"]), null);
  // Out of the legal coordinate range.
  assert.equal(parseGeocodeBounds(["-91", "24", "46", "47"]), null);
  assert.equal(parseGeocodeBounds(["24", "25", "-181", "47"]), null);
  // Reversed pairs are data, not a semantic: they are repaired.
  assert.deepEqual(parseGeocodeBounds(["24.98", "24.46", "46.85", "46.61"]), {
    north: 24.98,
    south: 24.46,
    east: 46.85,
    west: 46.61,
  });
});

test("client: an untrusted area in the response is normalized before it filters anything", () => {
  const good = { north: 25, south: 24, east: 47, west: 46 };
  assert.deepEqual(normalizeSearchArea(good), good);
  for (const bad of [
    null,
    undefined,
    "Riyadh",
    42,
    {},
    { north: 24, south: 25, east: 47, west: 46 },
    { north: 24, south: 24, east: 47, west: 46 },
    { north: 24, south: 23, east: 46, west: 47 },
    { north: Number.NaN, south: 23, east: 47, west: 46 },
    { north: 91, south: 23, east: 47, west: 46 },
  ]) {
    assert.equal(normalizeSearchArea(bad), null, `must reject ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// 11. Nothing else moved.
// ---------------------------------------------------------------------------

test("11: LIVE and Tempat Pilihan semantics are unchanged", () => {
  assert.match(pageCode, /const next = toggleLiveFilter\(liveOnly, curatedOnly\);/);
  assert.match(pageCode, /const next = activateCuratedFilter\(\);/);
  // The transitions themselves are the untouched ones: LIVE and the curated
  // layer stay mutually exclusive in both directions.
  assert.deepEqual(toggleLiveFilter(true, false), { liveOnly: false, curatedOnly: false });
  assert.deepEqual(toggleLiveFilter(false, true), { liveOnly: true, curatedOnly: false });
  assert.deepEqual(activateCuratedFilter(), { liveOnly: false, curatedOnly: true });
  // LIVE filtering still reads the canonical live feed, not the search state.
  assert.match(pageCode, /if \(liveOnly\) result = result\.filter\(\(place\) => liveByPlaceId\.has\(place\.id\)\);/);
  assert.match(pageCode, /return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/);
  // Curated membership is still canonical and read from the full published set.
  assert.doesNotMatch(pageCode, /const curatedFitPlaces/);
  // The curated layer's own contextual frame still uses the same search box.
  assert.doesNotMatch(pageCode, /const curatedFitPlaces/);
  // No new eligibility, ranking, or currency rule appears anywhere.
  assert.doesNotMatch(pageCode, /currency|PLACE_CURRENCIES|SAR/);
  assert.equal(/publication_status|is_published|from\("places"\)/.test(pageCode), false);
});

// ---------------------------------------------------------------------------
// 12. The field itself.
// ---------------------------------------------------------------------------

test("12: the search field keeps its approved geometry and both controls", () => {
  // One row, one rounded surface, and the approved left glyph.
  assert.match(
    pageCode,
    /<div className="flex items-center gap-2 rounded-\[20px\] border border-black\/10 bg-white pl-3\.5 pr-1\.5 py-2 shadow-\[0_2px_10px_rgb\(0_0_0\/0\.10\)\]">/,
  );
  assert.match(pageCode, /shrink-0 text-base leading-none text-brand-ink" aria-hidden>⌕</);
  assert.match(pageCode, /placeholder="Cari tempat, cerita, produksi\.\.\."/);
  assert.match(pageCode, /aria-label="Cari tempat, cerita, produksi"/);
  // The clear control is unchanged in size, and is the only conditional one.
  assert.match(
    pageCode,
    /className="inline-flex h-\[18px\] w-\[18px\] shrink-0 items-center justify-center rounded-full bg-black\/5 text-\[15px\] leading-none text-black\/45 transition hover:bg-black\/10"/,
  );
  // "Cari" is a fixed-height, shrink-0 control, so adding it cannot change the
  // bar's height; the input is the only elastic part and it may shrink to zero.
  // 2026-10-04: `relative` was added so the touch target can be extended by an
  // absolutely positioned, out-of-flow child — the fixed height is unchanged.
  assert.match(pageCode, /className="relative inline-flex h-\[26px\] shrink-0 items-center justify-center rounded-full bg-brand-primary/);
  assert.match(pageCode, /className="w-full min-w-0 bg-transparent text-sm outline-none/);
  // The decorative settings graphic from before the last PR stays gone.
  assert.doesNotMatch(pageCode, /M4 7h10M18 7h2/);
  assert.equal((pageCode.match(/viewBox="0 0 24 24" width="18" height="18"/g) ?? []).length, 0);
});

test("the search still runs on Enter only — never on keystroke", () => {
  assert.match(pageCode, /const handleSearchChange = useCallback\(\(value: string\) => \{\s*setSearchQuery\(value\);/);
  assert.equal(/setTimeout|debounce/i.test(pageCode.slice(0, pageCode.indexOf("const handleSearchSubmit"))), false);
});