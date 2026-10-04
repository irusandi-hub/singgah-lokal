import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ALL_PLACES_FILTER_LABEL,
  CAMERA_FIT_PADDING,
  DEFAULT_LABEL_ANCHOR,
  LABEL_ANCHOR_ORDER,
  activateAllPlacesFilter,
  activateCuratedFilter,
  leavePlaceSetTabs,
  resolveAllPlacesLabelLayout,
  resolveContextualCuratedCoverage,
  resolveContextualPlaceCoverage,
  type MapViewport,
} from "../lib/live/ui";

/**
 * EXECUTABLE + source-contract coverage for the "Semua Tempat" tab.
 *
 * Two things are locked here, and they are different in kind:
 *
 *  1. BEHAVIOUR, run for real: the tab's state transitions, its dataset scope,
 *     its camera framing, and the label layout it paints. The label layout is
 *     the important one — the requirement is that EVERY eligible name stays
 *     painted, so the tests assert that no Place is ever dropped, that a dense
 *     cluster still labels every Place, and that the layout is deterministic.
 *
 *  2. WIRING, read from the two components: the Home tab is a genuinely
 *     separate mode with its own dataset, and it cannot reach into the curated
 *     layer. Source contracts are how every other Home/map guarantee in this
 *     repository is pinned, so the new mode follows the same convention.
 */

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");

type Row = { id: string; latitude: number; longitude: number; countryCode: string | null; regionName: string | null };

/** An origin is an ActiveCenter (`{ lat, lng }`) — the camera's own shape. */
type Center = { lat: number; lng: number };

const BANDUNG: Row = { id: "anchor", latitude: -6.9175, longitude: 107.6191, countryCode: "ID", regionName: "Jawa Barat" };
const RIYADH: Row = { id: "anchor", latitude: 24.7136, longitude: 46.6753, countryCode: "SA", regionName: "Ash Sharqiyah" };

const center = (place: Row): Center => ({ lat: place.latitude, lng: place.longitude });

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
// 1. The tab exists and is mutually exclusive with every other content mode.
// ---------------------------------------------------------------------------

test("the tab is named by the master label and is a control of its own", () => {
  assert.equal(ALL_PLACES_FILTER_LABEL, "Semua Tempat");
  assert.match(homeDiscovery, /data-home-tab="all-places"/);
  assert.match(homeDiscovery, /\{ALL_PLACES_FILTER_LABEL\}/);
  assert.match(homeDiscovery, /aria-pressed=\{allPlacesOnly\}/);
});

test("activating the tab can only ever produce ONE state", () => {
  // Same contract as `activateCuratedFilter()`: it takes no argument, so no
  // prior combination of modes can leak through it.
  assert.deepEqual(activateAllPlacesFilter(), { liveOnly: false, curatedOnly: false, allPlacesOnly: true });
});

test("the tab never disturbs the curated layer and is never disturbed by it", () => {
  assert.deepEqual(activateCuratedFilter(), { liveOnly: false, curatedOnly: true });
  // Leaving for LIVE or a distance preset clears BOTH place-set tabs.
  assert.deepEqual(leavePlaceSetTabs(), { curatedOnly: false, allPlacesOnly: false });
  // The curated handler still goes through its own tested transition, plus the
  // one extra clear the new tab requires.
  assert.match(
    homeDiscovery,
    /const next = activateCuratedFilter\(\);[\s\S]{0,300}?setLiveOnly\(next\.liveOnly\);[\s\S]{0,300}?setAllPlacesOnly\(false\);/,
  );
  assert.match(
    homeDiscovery,
    /const next = toggleLiveFilter\(liveOnly, curatedOnly\);[\s\S]{0,300}?setCuratedOnly\(next\.curatedOnly\);[\s\S]{0,300}?setAllPlacesOnly\(false\);/,
  );
  assert.match(
    homeDiscovery,
    /setDistanceFilter\(filter\);\s*const next = leavePlaceSetTabs\(\);\s*setCuratedOnly\(next\.curatedOnly\);\s*setAllPlacesOnly\(next\.allPlacesOnly\);/,
  );
});

test("choosing the tab is an EXPLICIT camera request, exactly like the curated tab", () => {
  const handler = homeDiscovery.slice(
    homeDiscovery.indexOf('data-home-tab="all-places"'),
    homeDiscovery.indexOf('data-home-tab="all-places"') + 1600,
  );
  assert.match(handler, /const next = activateAllPlacesFilter\(\);/);
  assert.match(handler, /setAllPlacesOnly\(next\.allPlacesOnly\);/);
  // The same three-line refocus contract: one fit nonce, the "area" coverage
  // scope, and one camera request. Nothing else may carry a nonce.
  assert.match(handler, /setFitNonce\(\(nonce\) => nonce \+ 1\);/);
  assert.match(handler, /setCameraCoverage\("area"\);/);
  assert.match(handler, /setCameraRequestNonce\(\(nonce\) => nonce \+ 1\);/);
});

// ---------------------------------------------------------------------------
// 2. The dataset is EVERY eligible Place, never the curated subset.
// ---------------------------------------------------------------------------

test("the tab's dataset is the whole eligible set, narrowed only by the shared search", () => {
  assert.match(
    homeDiscovery,
    /if \(allPlacesOnly\) \{\s*return searchFiltered;\s*\}/,
    "the all-Places branch returns the unfiltered eligible set",
  );
  // It must come BEFORE the curated filter, so a curated Place is never treated
  // specially and a non-curated Place is never excluded.
  const allPlacesBranch = homeDiscovery.indexOf("if (allPlacesOnly) {");
  const curatedBranch = homeDiscovery.indexOf("if (curatedOnly) {");
  assert.ok(allPlacesBranch > -1 && allPlacesBranch < curatedBranch, "all-Places branch is evaluated first");
  // The curated branch itself is unchanged.
  assert.match(homeDiscovery, /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/);
});

test("the tab adds no data source: it reads the same server-provided Places", () => {
  // No new fetch, no new query, no second dataset. Everything comes from the
  // `initialPlaces` the canonical server wrapper already passed in, so the tab
  // cannot surface an unpublished, deleted, or otherwise ineligible Place: the
  // client never computes eligibility.
  assert.match(homeDiscovery, /const \[places\] = useState<Place\[]>\(initialPlaces\);/);
  // Exactly ONE fetch exists in the whole Home surface — the LIVE poll that was
  // always there — so the new tab adds no request of its own.
  assert.equal((homeDiscovery.match(/fetch\("/g) ?? []).length, 1, "no new request was added");
  assert.equal(homeDiscovery.match(/useQuery|supabase|createClient/g), null, "no new data-access path");
});

test("search scopes the tab to the active tab and nothing else changes", () => {
  // ONE search implementation feeds every layer, so a query in this tab can
  // never reach into the curated layer or invent its own semantics.
  assert.match(homeDiscovery, /const searchFiltered = useMemo\(\(\) => \{\s*const normalizedQuery = searchQuery\.trim\(\)/);
  assert.match(homeDiscovery, /return places\.filter\(\(place\) => \{/);
  // Submit-only geocoding is untouched by the new tab.
  assert.match(homeDiscovery, /const handleSearchSubmit = useCallback\(async/);
});

test("no duplicate Place record can enter the tab's markers", () => {
  // The existing dedupe in `mapPlaces` is the only place a Place can be listed
  // twice, and it is still the single `seen` guard.
  assert.match(
    homeDiscovery,
    /const seen = new Set<string>\(\);\s*return source\.flatMap\(\(place\) => \{\s*if \(seen\.has\(place\.id\)\) return \[\];\s*seen\.add\(place\.id\);/,
  );
  // The camera dataset is deduplicated too (a Place defines a frame once).
  assert.match(homeDiscovery, /function toCameraCandidates\(source: readonly Place\[\]\)/);
});

test("an empty result set stays a real empty state in this tab", () => {
  assert.match(homeDiscovery, /const mapEmptyStateVisible =\s*mapPlaces\.length === 0 \|\| \(viewportReported && !viewportHasPlaces\);/);
  // The empty overlay copy has its own wording for the curated layer and a
  // truthful generic one for everything else, which is what this tab uses.
  assert.match(homeDiscovery, /Belum ada Tempat Terdaftar di sekitar area ini/);
});

test("Place selection and navigation are reused, never re-implemented", () => {
  // The same markers, the same click target, and the same detail route: the tab
  // adds no Place page, no card, and no navigation of its own.
  assert.match(homeMap, /\.on\("click", \(\) => router\.push\(`\/places\/\$\{place\.id\}`\)\);/);
  assert.match(homeDiscovery, /<VisitedLink/);
  assert.equal(homeDiscovery.includes('href={`/places/${'), false, "no new Place route was introduced");
});

// ---------------------------------------------------------------------------
// 3. The camera frames the eligible Places of the ACTIVE CONTEXT.
// ---------------------------------------------------------------------------

test("the camera dataset is the contextual coverage of the WHOLE eligible set", () => {
  assert.match(
    homeDiscovery,
    /const allPlacesFitPlaces = useMemo<HomeMapPlace\[\]>\(\(\) => \{\s*const coverage = resolveContextualPlaceCoverage\(\{\s*places: toCameraCandidates\(visiblePlaces\),/,
  );
  // Same origin precedence as every other camera dataset: the searched city
  // first, the real fix second, and no invented coordinate ever.
  assert.match(
    homeDiscovery,
    /const allPlacesFitPlaces[\s\S]*?origin: searchCenter \?\? viewerPosition,\s*searchViewport,\s*\}\);/,
  );
});

test("contextual coverage is ONE shared rule, so both tabs frame the same way", () => {
  // The curated resolver delegates instead of keeping a second implementation.
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
});

test("the eligible set is framed by the viewer's context, never the whole world", () => {
  // The canonical dataset spans two continents. Fitting all of it is the world
  // frame that made the curated tab useless, so the tab must never do it.
  const world = rows(
    BANDUNG,
    { id: "riyadh-1", latitude: 24.6937, longitude: 46.6853, countryCode: "SA", regionName: "Ash Sharqiyah" },
    { id: "riyadh-2", latitude: 24.8325, longitude: 46.64, countryCode: "SA", regionName: "Ash Sharqiyah" },
  );
  const bandung = resolveContextualPlaceCoverage({ places: world, origin: center(BANDUNG), searchViewport: null });
  assert.equal(bandung.basis, "area");
  assert.deepEqual(
    bandung.places.map((place) => place.id),
    ["anchor"],
  );
  // All three were CONSIDERED — nothing was dropped from the dataset, only from
  // the frame.
  assert.equal(bandung.consideredCount, 3);

  const riyadh = resolveContextualPlaceCoverage({ places: world, origin: center(RIYADH), searchViewport: null });
  assert.equal(riyadh.basis, "area");
  assert.deepEqual(riyadh.places.map((place) => place.id).sort(), ["riyadh-1", "riyadh-2"]);

  // A searched region wins over the device fix, and it frames only that region.
  const searched = resolveContextualPlaceCoverage({
    places: world,
    origin: center(BANDUNG),
    searchViewport: { north: 24.9, south: 24.6, east: 46.8, west: 46.6 },
  });
  assert.equal(searched.basis, "search");
  assert.deepEqual(searched.places.map((place) => place.id).sort(), ["riyadh-1", "riyadh-2"]);
});

test("with no usable origin the camera keeps its frame instead of inventing one", () => {
  const frame = resolveContextualPlaceCoverage({
    places: rows(BANDUNG, { id: "far", latitude: 24.6937, longitude: 46.6853, countryCode: "SA", regionName: null }),
    origin: null,
    searchViewport: null,
  });
  assert.equal(frame.basis, "none");
  assert.deepEqual(frame.places, []);
  assert.equal(frame.consideredCount, 2);
});

// ---------------------------------------------------------------------------
// 4. EVERY name is painted, and density is handled by moving labels, not hiding.
// ---------------------------------------------------------------------------

test("every rendered Place keeps its label painted in this tab", () => {
  assert.match(homeDiscovery, /labelEveryPlaceName=\{allPlacesOnly\}/);
  // The map then paints the WHOLE marker set, with no budget, no ranking, and no
  // priority — a Place cannot lose its name in this tab.
  assert.match(
    homeMap,
    /const alwaysLabelledPlaceIds = labelEveryPlaceName\s*\?\s*\/\/[\s\S]*?new Set\(currentPlaces\.map\(\(place\) => place\.id\)\)\s*:\s*selectAlwaysLabelledPlaceIds\(/,
  );
  // The curated/dense budget is untouched and still the default path.
  assert.match(homeMap, /labelEveryPlaceName = false,/);
});

test("the label rule is part of the marker signature, so switching tabs re-paints", () => {
  // Without this, opening "Semua Tempat" would keep the curated tab's paint
  // state and some names would open hidden.
  assert.match(homeMap, /labels:\$\{labelEveryPlaceName \? "all" : "budget"\}/);
  assert.match(homeMap, /\[places, liveByPlaceId, labelEveryPlaceName\]/);
});

test("no layout measurement, no per-frame work, and no clustering is introduced", () => {
  // The layout reads the frame and the size the map already measures for its own
  // scale bar and viewport report. It never touches the DOM.
  const mapCode = homeMap
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal((mapCode.match(/getBoundingClientRect\(\)/g) ?? []).length, 1, "only the pre-existing pulse reflow");
  assert.doesNotMatch(mapCode, /offsetWidth|offsetHeight|clientWidth|clientHeight/);
  // Markers are still one Leaflet marker per Place: no cluster layer, no
  // spiderfy, no grouping that could remove a name.
  assert.equal((homeMap.match(/L\.marker\(/g) ?? []).length, 2, "one base marker plus the LIVE pin");
  assert.doesNotMatch(homeMap, /markerClusterGroup|L\.markerClusterGroup/);
  // It runs inside the one marker-rebuild effect, never in a render path.
  const effect = homeMap.slice(homeMap.indexOf("const markerPositionsRef"), homeMap.indexOf("}, [ready, markerKey]);"));
  assert.match(effect, /resolveAllPlacesLabelLayout\(\{/);
});

test("labels are placed around pins and away from the reserved map chrome", () => {
  const frame: MapViewport = { north: -6.85, south: -6.95, east: 107.7, west: 107.5 };
  const size = { x: 360, y: 460 };
  // A tight cluster: four Places inside a few hundred metres.
  const cluster = [
    { id: "a", latitude: -6.9, longitude: 107.6 },
    { id: "b", latitude: -6.9002, longitude: 107.6002 },
    { id: "c", latitude: -6.9004, longitude: 107.6001 },
    { id: "d", latitude: -6.8998, longitude: 107.6003 },
  ];
  const layout = resolveAllPlacesLabelLayout({ places: cluster, frame, size });

  // EVERY Place has an anchor: nothing is dropped, nothing is "decluttered away".
  assert.deepEqual([...layout.anchors.keys()].sort(), ["a", "b", "c", "d"]);
  for (const place of cluster) {
    assert.ok(LABEL_ANCHOR_ORDER.includes(layout.anchors.get(place.id)!), "the anchor is one of the four legal ones");
  }
  // Density is handled by MOVING labels, so at least one chip had to be
  // relocated away from the default below-the-pin placement.
  assert.ok(layout.relocated > 0, "a dense cluster relocates chips instead of hiding them");
  // The layout is deterministic: the same frame yields the same anchors.
  const again = resolveAllPlacesLabelLayout({ places: cluster, frame, size });
  assert.deepEqual([...again.anchors.entries()], [...layout.anchors.entries()]);
});

test("a sparse frame keeps the default placement every pin has always used", () => {
  // Both Places sit in the middle of the usable map area, far enough apart that
  // no chip can collide — the frame a user actually sees most of the time must
  // look exactly like the map that shipped.
  const frame: MapViewport = { north: -6.5, south: -7.2, east: 108.0, west: 107.2 };
  const layout = resolveAllPlacesLabelLayout({
    places: [
      { id: "a", latitude: -6.8804, longitude: 107.5333 },
      { id: "b", latitude: -7.0174, longitude: 107.6444 },
    ],
    frame,
    size: { x: 360, y: 460 },
  });
  assert.equal(layout.relocated, 0);
  assert.equal(layout.crowded, 0);
  for (const anchor of layout.anchors.values()) assert.equal(anchor, DEFAULT_LABEL_ANCHOR);
});

test("a chip is never parked under the opaque map controls, and the limit is reported", () => {
  const frame: MapViewport = { north: -6.85, south: -6.95, east: 107.7, west: 107.5 };
  const size = { x: 360, y: 460 };
  // A Place in the middle band gets the placement the map has always used.
  const comfortable = resolveAllPlacesLabelLayout({
    places: [{ id: "mid", latitude: -6.9, longitude: 107.6 }],
    frame,
    size,
  });
  assert.equal(comfortable.anchors.get("mid"), DEFAULT_LABEL_ANCHOR);
  assert.equal(comfortable.crowded, 0);

  // A Place hard against the right edge: no anchor can clear the control column
  // on a 360px map, so the chip keeps its default side AND the crowding is
  // counted — never "solved" by dropping the label or the Place.
  const rightEdge = resolveAllPlacesLabelLayout({
    places: [{ id: "right", latitude: -6.9, longitude: 107.695 }],
    frame,
    size,
  });
  assert.notEqual(rightEdge.anchors.get("right"), "right", "no chip is parked under the control column");
  assert.equal(rightEdge.anchors.size, 1, "the Place keeps its name");
  assert.equal(rightEdge.crowded, 1, "the unavoidable overlap is reported honestly");

  // The reserved chrome is the SAME padding the camera fit reserves, so the two
  // can never disagree about where the usable map area starts.
  assert.equal(CAMERA_FIT_PADDING.top, 190);
  assert.equal(CAMERA_FIT_PADDING.right, 76);
});

test("a frame that cannot be measured changes nothing and invents nothing", () => {
  const places = [{ id: "a", latitude: -6.9, longitude: 107.6 }];
  for (const input of [
    { frame: null, size: { x: 360, y: 460 } },
    { frame: { north: -6.9, south: -6.9, east: 107.6, west: 107.6 }, size: { x: 360, y: 460 } },
    { frame: { north: -6.85, south: -6.95, east: 107.7, west: 107.5 }, size: { x: 0, y: 0 } },
  ]) {
    const layout = resolveAllPlacesLabelLayout({ places, ...input });
    assert.equal(layout.anchors.get("a"), DEFAULT_LABEL_ANCHOR);
    assert.equal(layout.relocated, 0);
    assert.equal(layout.crowded, 0);
  }
});

test("an extreme cluster is reported honestly instead of dropping names", () => {
  // Twenty Places in a few metres cannot be laid out without overlap. The
  // contract is that every name is still painted and the crowding is COUNTED,
  // never resolved by removing a Place or hiding a label.
  const frame: MapViewport = { north: -6.9, south: -6.9001, east: 107.6001, west: 107.6 };
  const places = Array.from({ length: 20 }, (_, index) => ({
    id: `p-${index}`,
    latitude: -6.90005 + index * 1e-7,
    longitude: 107.60005 + index * 1e-7,
  }));
  const layout = resolveAllPlacesLabelLayout({ places, frame, size: { x: 360, y: 460 } });
  assert.equal(layout.anchors.size, 20, "every Place still has a label");
  // Density is answered by moving chips around the cluster, never by removing
  // one. No claim is made that twenty names in a few metres can be laid out
  // without touching — the counters report what the layout could not fix.
  assert.ok(layout.relocated > 0, "chips were moved to get the names apart");
  for (const place of places) {
    assert.ok(LABEL_ANCHOR_ORDER.includes(layout.anchors.get(place.id)!));
  }
});

test("a Place without real coordinates is never given an invented label position", () => {
  const layout = resolveAllPlacesLabelLayout({
    places: [
      { id: "real", latitude: -6.9, longitude: 107.6 },
      { id: "broken", latitude: Number.NaN, longitude: 107.6 },
    ],
    frame: { north: -6.85, south: -6.95, east: 107.7, west: 107.5 },
    size: { x: 360, y: 460 },
  });
  assert.equal(layout.anchors.get("real"), DEFAULT_LABEL_ANCHOR);
  assert.equal(layout.anchors.get("broken"), DEFAULT_LABEL_ANCHOR, "kept at the default, never relocated on invented geometry");
});

test("the placement is applied through one helper and keeps the chip identical", () => {
  assert.match(homeMap, /function labelAnchorStyle\(anchor: LabelAnchor\): string \{/);
  // The default branch is the placement every pin has used since names were
  // added, byte for byte.
  assert.match(homeMap, /return "position:absolute;left:50%;top:100%;transform:translate\(-50%,1px\);";/);
  // Same chip, same class, same truncation, same accessible name in every state.
  assert.match(
    homeMap,
    /<span class="singgah-pin-label" \$\{PIN_LABEL_ON_DEMAND_ATTRIBUTE\}="\$\{labelState\}" style="\$\{labelAnchorStyle\(labelAnchor\)\}">\$\{escapeHtml\(place\.name\)\}<\/span>/,
  );
});
