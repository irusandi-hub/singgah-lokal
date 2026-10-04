import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMERA_FIT_PADDING,
  DISTANCE_FILTERS,
  LIVE_FILTER_LABEL,
  activateCuratedFilter,
  resolveContextualCuratedCoverage,
  resolveContextualPlaceCoverage,
  selectAlwaysLabelledPlaceIds,
  toggleLiveFilter,
} from "../lib/live/ui";

/**
 * HOME TAB ROW — the approved five-control row, and the tab that is GONE.
 *
 * This file replaces the former "Semua Tempat" all-Places tab suite. The tab
 * (its button, its `allPlacesOnly` mode, its own camera dataset, and its
 * "paint every name" pin-label rule) was REMOVED on 2026-10-04: the approved
 * Home/Map mockup has no such tab, and no other entry point for it is defined
 * by the approved product flow, so nothing replaced it.
 *
 * What is locked here now:
 *
 *  1. ABSENCE — no "Semua Tempat" tab, no replacement control, and no
 *     alternative entry point back into the removed mode.
 *  2. THE ROW THAT REMAINS — LIVE, "Tempat Pilihan", and the three distance
 *     tabs, in that order, on the same single row, with their own handlers.
 *  3. WHAT THE REMOVAL MUST NOT HAVE TOUCHED — the curated dataset, the shared
 *     contextual coverage rule, the pin-label density budget, Place selection,
 *     navigation, and the canonical data source.
 */

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");

/** The comment-free component source: comments describe, they never decide. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const discoveryCode = stripComments(homeDiscovery);
const mapCode = stripComments(homeMap);

type Row = { id: string; latitude: number; longitude: number; countryCode: string | null; regionName: string | null };

const BANDUNG: Row = { id: "anchor", latitude: -6.9175, longitude: 107.6191, countryCode: "ID", regionName: "Jawa Barat" };

const center = (place: Row) => ({ lat: place.latitude, lng: place.longitude });

function rows(...items: Array<Partial<Row> & { id: string }>): Row[] {
  return items.map((item) => ({
    latitude: item.latitude ?? -6.9,
    longitude: item.longitude ?? 107.6,
    countryCode: item.countryCode ?? "ID",
    regionName: item.regionName ?? "Jawa Barat",
    ...item,
  }));
}

// ---------------------------------------------------------------------------
// 1. The removed tab can never come back, by any route.
// ---------------------------------------------------------------------------

test("no 'Semua Tempat' tab is rendered anywhere in the Home surface", () => {
  // Comments are allowed to name the removed tab (that is how the removal is
  // documented); what must not survive is anything the browser can render or
  // anything the component can branch on. The ONLY surviving occurrence of the
  // words is the long-standing LIVE empty-state action, which clears LIVE and
  // predates the tab by several PRs — it is not an entry point into the mode.
  assert.equal(discoveryCode.includes(">{ALL_PLACES_FILTER_LABEL}"), false);
  assert.equal(discoveryCode.includes('data-home-tab="all-places"'), false, "no tab hook for the removed mode");
  const occurrences = discoveryCode.match(/Semua Tempat/g) ?? [];
  assert.deepEqual(occurrences, ["Semua Tempat"], "only the LIVE empty-state action may use the words");
  assert.match(discoveryCode, /Lihat Semua Tempat/);
});

test("the removed content mode leaves no state, handler, or prop behind", () => {
  // One unreachable flag would be a second, invisible way into a dataset that
  // the approved UI no longer offers, so the whole mode goes with the tab.
  for (const symbol of [
    "allPlacesOnly",
    "setAllPlacesOnly",
    "activateAllPlacesFilter",
    "ALL_PLACES_FILTER_LABEL",
    "leavePlaceSetTabs",
    "labelEveryPlaceName",
    "onScaleChange",
    "mapScale",
  ]) {
    assert.equal(discoveryCode.includes(symbol), false, `${symbol} must not remain in home-discovery.tsx`);
  }
  // The map's own all-Places label mode and scale measurement go with it.
  for (const symbol of [
    "labelEveryPlaceName",
    "resolveAllPlacesLabelLayout",
    "resolveMapScale",
    "onScaleChange",
    "labelAnchorStyle",
    "toViewportBounds",
  ]) {
    assert.equal(mapCode.includes(symbol), false, `${symbol} must not remain in home-map.tsx`);
  }
});

test("no alternative entry point for the removed mode was invented", () => {
  // The only Place-listing affordances that may exist are the ones the approved
  // mockup keeps: the tab row, the floating results panel, and the pre-existing
  // LIVE empty-state action (which clears LIVE, a long-standing control and not
  // a back door into the removed mode).
  assert.equal((discoveryCode.match(/data-home-tab=/g) ?? []).length, 0);
  assert.doesNotMatch(discoveryCode, /setAllPlacesOnly|activateAllPlacesFilter/);
  // The LIVE empty state keeps its own button and clears only LIVE.
  assert.match(discoveryCode, /onClick=\{\(\) => setLiveOnly\(false\)\}/);
  assert.doesNotMatch(discoveryCode, /onClick=\{\(\) => setCuratedOnly\(true\)\}/);
});

// ---------------------------------------------------------------------------
// 2. The row that remains: five controls, same order, same handlers.
// ---------------------------------------------------------------------------

test("the tab row is still ONE row of the five approved controls", () => {
  assert.match(
    discoveryCode,
    /<div className="pointer-events-auto mt-2\.5 grid grid-cols-\[auto_auto_1fr_1fr_1fr\] gap-1\.5">/,
    "the single five-control row is unchanged",
  );
  // Order in source: LIVE → Tempat Pilihan → the three distance tabs.
  const live = discoveryCode.indexOf("aria-pressed={liveOnly}");
  const curated = discoveryCode.indexOf("aria-pressed={curatedOnly}");
  const distances = discoveryCode.indexOf("DISTANCE_FILTERS.map");
  assert.ok(live > -1 && curated > live, "LIVE stays leftmost");
  assert.ok(distances > curated, "'Tempat Pilihan' stays beside LIVE, distance tabs after it");
  assert.ok(discoveryCode.includes(LIVE_FILTER_LABEL), "LIVE keeps its master label");
  assert.equal((discoveryCode.match(/DISTANCE_FILTERS\.map/g) ?? []).length, 1, "exactly one distance-tab loop");
  assert.deepEqual(DISTANCE_FILTERS, ["1 km", "5 km", "10 km+"]);
  // And no sixth control joined the row: two buttons plus the ONE distance loop
  // that renders the three distance tabs.
  const row = discoveryCode.slice(discoveryCode.indexOf('grid-cols-[auto_auto_1fr_1fr_1fr]'));
  const rowEnd = row.indexOf("</div>");
  assert.equal((row.slice(0, rowEnd).match(/<button/g) ?? []).length, 2 + 1);
  assert.equal((row.slice(0, rowEnd).match(/DISTANCE_FILTERS\.map/g) ?? []).length, 1);
});

test("LIVE, 'Tempat Pilihan', and the distance tabs keep their own transitions", () => {
  assert.deepEqual(activateCuratedFilter(), { liveOnly: false, curatedOnly: true });
  assert.deepEqual(toggleLiveFilter(true, false), { liveOnly: false, curatedOnly: false });
  assert.deepEqual(toggleLiveFilter(false, true), { liveOnly: true, curatedOnly: false });
  // The curated tab still fits the frame once and claims "area" coverage.
  const curatedHandler = discoveryCode.slice(
    discoveryCode.indexOf("const next = activateCuratedFilter();"),
    discoveryCode.indexOf("const next = activateCuratedFilter();") + 500,
  );
  assert.match(curatedHandler, /setFitNonce\(\(nonce\) => nonce \+ 1\);/);
  assert.match(curatedHandler, /setCameraCoverage\("area"\);/);
  assert.match(curatedHandler, /setCameraRequestNonce\(\(nonce\) => nonce \+ 1\);/);
  // A distance tab sets its radius, leaves the curated layer, and claims the
  // radius coverage — exactly the rules it had before.
  const distanceHandler = discoveryCode.slice(
    discoveryCode.indexOf("setDistanceFilter(filter);"),
    discoveryCode.indexOf("setDistanceFilter(filter);") + 400,
  );
  assert.match(distanceHandler, /setCuratedOnly\(false\);/);
  assert.match(distanceHandler, /setCameraCoverage\("radius"\);/);
  assert.match(distanceHandler, /setCameraRequestNonce\(\(nonce\) => nonce \+ 1\);/);
});

test("selected state is unchanged: one active control, brand green or LIVE red", () => {
  assert.match(discoveryCode, /aria-pressed=\{liveOnly\}/);
  assert.match(discoveryCode, /aria-pressed=\{curatedOnly\}/);
  assert.match(discoveryCode, /aria-pressed=\{distanceFilter === filter && !curatedOnly\}/);
});

// ---------------------------------------------------------------------------
// 3. What the removal must not have changed.
// ---------------------------------------------------------------------------

test("the curated dataset is untouched", () => {
  assert.match(
    discoveryCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
  // Only the two place-set rules remain, and they stay mutually exclusive.
  assert.match(discoveryCode, /const contextFramedTab = curatedOnly;/);
  assert.match(discoveryCode, /const contextFitPlaces = curatedFitPlaces;/);
});

test("the contextual coverage rule is still ONE shared implementation", () => {
  const curated = resolveContextualCuratedCoverage({
    curatedPlaces: rows(BANDUNG, { id: "a", latitude: -6.9, longitude: 107.6 }),
    origin: center(BANDUNG),
    searchViewport: null,
  });
  const generic = resolveContextualPlaceCoverage({
    places: rows(BANDUNG, { id: "a", latitude: -6.9, longitude: 107.6 }),
    origin: center(BANDUNG),
    searchViewport: null,
  });
  assert.deepEqual(curated, generic);
  // It still frames the viewer's context, never the whole world.
  const world = rows(
    BANDUNG,
    { id: "riyadh-1", latitude: 24.6937, longitude: 46.6853, countryCode: "SA", regionName: "Ash Sharqiyah" },
  );
  const frame = resolveContextualPlaceCoverage({ places: world, origin: center(BANDUNG), searchViewport: null });
  assert.equal(frame.basis, "area");
  assert.deepEqual(frame.places.map((place) => place.id), ["anchor"]);
  assert.equal(frame.consideredCount, 2);
});

test("the pin-label density budget is still the only label rule", () => {
  // Every rendered pin keeps ONE placement — below the pin — and the
  // deterministic budget still decides which chips stay painted. No clustering,
  // no measurement pass, and no name can be dropped from the DOM.
  assert.match(mapCode, /const alwaysLabelledPlaceIds = selectAlwaysLabelledPlaceIds\(/);
  assert.match(mapCode, /const labelState = alwaysLabelledPlaceIds\.has\(place\.id\) \? "always" : "on-demand";/);
  assert.match(
    mapCode,
    /<span class="singgah-pin-label" \$\{PIN_LABEL_ON_DEMAND_ATTRIBUTE\}="\$\{labelState\}" style="\$\{PIN_LABEL_ANCHOR_STYLE\}">\$\{escapeHtml\(place\.name\)\}<\/span>/,
  );
  assert.equal((mapCode.match(/getBoundingClientRect\(\)/g) ?? []).length, 1, "only the pre-existing pulse reflow");
  assert.doesNotMatch(mapCode, /offsetWidth|offsetHeight|clientWidth|clientHeight/);
  assert.equal((mapCode.match(/L\.marker\(/g) ?? []).length, 2, "one base marker plus the LIVE pin");
  assert.doesNotMatch(mapCode, /markerClusterGroup|L\.markerClusterGroup/);
  // The budget itself still behaves: it keeps at least one label and never all.
  const candidates = Array.from({ length: 40 }, (_, index) => ({
    id: `p-${index}`,
    isCurated: index < 2,
    isLive: false,
  }));
  const always = selectAlwaysLabelledPlaceIds(candidates);
  assert.ok(always.size >= 1 && always.size < candidates.length);
});

test("Place selection, navigation, and the canonical data source are untouched", () => {
  assert.match(mapCode, /\.on\("click", \(\) => router\.push\(`\/places\/\$\{place\.id\}`\)\);/);
  assert.match(discoveryCode, /<VisitedLink/);
  assert.equal(discoveryCode.includes('href={`/places/${'), false, "no new Place route");
  assert.match(discoveryCode, /const \[places\] = useState<Place\[\]>\(initialPlaces\);/);
  // Exactly ONE fetch exists in the whole Home surface (the LIVE poll that was
  // always there), so removing the tab removed no data path and added none.
  assert.equal((discoveryCode.match(/fetch\("/g) ?? []).length, 1);
  assert.equal(discoveryCode.match(/useQuery|supabase|createClient/g), null);
  assert.match(discoveryCode, /const seen = new Set<string>\(\);/);
});

test("the empty state, the dedupe, and the reserved camera padding still hold", () => {
  assert.match(discoveryCode, /Belum ada Tempat Terdaftar di sekitar area ini/);
  assert.match(discoveryCode, /Belum ada Tempat Pilihan di sekitar area ini/);
  assert.equal(CAMERA_FIT_PADDING.top, 190);
  assert.equal(CAMERA_FIT_PADDING.right, 76);
});