import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDiscoveryViewModel } from "../lib/discovery/view-model";
import { narrowToViewport, type MapViewport } from "../lib/live/ui";
import type { DiscoveryPlaceInput } from "../lib/discovery/scoring";

/**
 * STAGE 3 REGRESSION — Discovery × Home integration (contract v1.0 +
 * Stage 3 PO directive). Required cases:
 * 1. default → Discovery  2. curated → Curated first  3. Discovery second
 * 4. overlap remains      5. unpublished not shown     6. search keeps working
 * 7. map behavior locked  8. LIVE behavior locked
 */

const NOW = new Date("2026-09-29T12:00:00.000Z");

const home = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const appPage = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const homeService = readFileSync(new URL("../lib/discovery/home-service.ts", import.meta.url), "utf8");
const repoSource = readFileSync(new URL("../lib/place-experience-repository.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/0035_place_curated_flag.sql", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const zeroEngagement = {
  followers: 0,
  visitIntents: 0,
  publishedExperiences: 0,
  hasCoverImage: false,
  photoCount: 0,
};

function makeInput(
  id: string,
  options: {
    publicationStatus?: "draft" | "published" | "paused" | "archived";
    coordinates?: { lat: number; lng: number } | null;
    followers?: number;
  } = {},
): DiscoveryPlaceInput {
  const { publicationStatus = "published", coordinates = { lat: -6.9, lng: 107.6 }, followers = 0 } = options;
  return {
    place: {
      id,
      name: `Place ${id}`,
      shortDescription: "Deskripsi singkat.",
      area: "Bandung",
      address: "Jl. Contoh 123",
      latitude: coordinates ? coordinates.lat : null,
      longitude: coordinates ? coordinates.lng : null,
      claimStatus: "unverified",
      publicationStatus,
    },
    signals: {
      live: null,
      engagement: { ...zeroEngagement, followers },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. default → Discovery
// ---------------------------------------------------------------------------

test("default mode headings and row are the canonical Discovery layer", () => {
  const code = stripComments(home);
  // The default results heading is "Discovery Place" (engine-backed layer).
  assert.match(code, /curatedOnly\s*\?\s*"Tempat Pilihan"\s*:\s*"Discovery Place"/);
  // The default row renders the canonical engine list (no re-sort client-side):
  // the ranked engine order from the server view model. Each entry is wrapped
  // in a fixed-width flex track (MOCKUP §12/§19, 2026-10-01) so the card can
  // never collapse inside the horizontal strip — the wrapper is presentation
  // only and the row still renders exactly one card per canonical entry, in
  // engine order.
  assert.match(code, /discoveryRowPlaces\.map\(\(place\) => \(/);
  assert.match(code, /renderPlaceCard\(place, curatedIdSet\.has\(place\.id\)\)/);
  // Home never recomputes the score: no engine scoring import exists here.
  assert.equal(code.includes("computeDiscoveryScore"), false);
  assert.equal(code.includes("discoveryStarsForScore"), false);
});

test("the server view model feeds Home from the ONE engine (no second scoring path)", () => {
  const pageCode = stripComments(appPage);
  assert.match(pageCode, /loadDiscoveryViewModel\(\)/);
  assert.match(pageCode, /discovery=\{discovery\}/);
  const serviceCode = stripComments(homeService);
  assert.match(serviceCode, /buildDiscoveryViewModel\(inputs, curatedPlaceIds, new Date\(\)\)/);
  // Public mapping exposes stars/rank only — the numeric score never leaves
  // the server (contract §3).
  const viewModel = readFileSync(new URL("../lib/discovery/view-model.ts", import.meta.url), "utf8");
  assert.match(viewModel, /stars,\s*rank/);
  assert.doesNotMatch(viewModel, /score: entry\.score|score,\s*\}[\s\S]*public/);
});

// ---------------------------------------------------------------------------
// 2 + 3. curated → Curated first, Discovery second
// ---------------------------------------------------------------------------

test("curated mode renders TWO ordered rows: Tempat Pilihan (Baris 1) then Discovery Place (Baris 2)", () => {
  const code = stripComments(home);
  const row1 = code.indexOf("curatedOnly && curatedListed.length > 0");
  const row2 = code.indexOf("discoveryRowPlaces.length > 0");
  assert.ok(row1 >= 0 && row2 > row1, "Baris 1 (Tempat Pilihan) renders before Baris 2 (Discovery Place)");
  assert.match(code, /discoveryRowPlaces\.map\(\(place\) => \(/);
  assert.match(code, /renderPlaceCard\(place, curatedIdSet\.has\(place\.id\)\)/);
});

test("curated membership is published + isCurated only, read through the canonical repository", () => {
  const repoCode = stripComments(repoSource);
  // The ONE curated read path: publication_status filter + the 0035 flag.
  assert.match(repoCode, /\.eq\("publication_status", "published"\)/);
  assert.match(repoCode, /\.eq\("is_curated", true\)/);
  assert.match(repoCode, /listCuratedPublishedPlaceIds/);
  // Migration is additive: only the flag, an index, and a comment.
  assert.match(migration, /add column if not exists is_curated boolean not null default false/);
  assert.equal(/drop\s/i.test(migration), false, "no destructive statements");
  assert.equal(/create table/i.test(migration), false, "no new table — the flag lives on canonical places");
});

// ---------------------------------------------------------------------------
// 4. overlap remains
// ---------------------------------------------------------------------------

test("overlap: a curated Place that is also engine-eligible appears in BOTH rows", () => {
  // Pure layer view: both row derivations exist independently and neither
  // filters the other out — curatedListed uses visiblePlaces ∩ flag ids,
  // discoveryRowPlaces uses the engine ranking ∩ search; no intersection step.
  const code = stripComments(home);
  assert.match(code, /const curatedListed = useMemo\(/);
  assert.match(code, /const discoveryRowPlaces = useMemo\(/);
  assert.equal(code.includes("dedupe"), false);
  // OVERLAP functional proof with the pure view model: Place A is curated
  // AND engine-eligible → present in BOTH lists, never deduplicated.
  const inputA = makeInput("place-a", { followers: 30 });
  const inputB = makeInput("place-b");
  const vm = buildDiscoveryViewModel([inputA, inputB], new Set(["place-a", "place-b"]), NOW);
  assert.equal(vm.curatedPlaceIds.includes("place-a"), true);
  assert.equal(vm.discovery.some((entry) => entry.placeId === "place-a"), true);
  assert.equal(vm.discovery.some((entry) => entry.placeId === "place-b"), true);
  // The Discovery row marks overlap cards with the ✦ Tempat Pilihan badge.
  // MOCKUP §14/§17 (2026-10-01): the badge is now a compact ✦ chip with an
  // accessible "Tempat Pilihan" label instead of the long text pill, so it
  // never covers the image at the narrower card width. The canonical source of
  // the flag is unchanged.
  assert.match(code, /curatedIdSet\.has\(place\.id\)/);
  assert.match(code, /<span aria-hidden>✦<\/span>/);
  assert.match(code, /<span className="sr-only">Tempat Pilihan<\/span>/);
});

// ---------------------------------------------------------------------------
// 5. unpublished not shown
// ---------------------------------------------------------------------------

test("unpublished Places never reach any layer (engine eligibility + repository filter)", () => {
  // Engine: draft/paused/archived are ineligible — they never get ranked.
  const vm = buildDiscoveryViewModel(
    [makeInput("draft-place", { publicationStatus: "draft" }), makeInput("ok-place")],
    new Set(),
    NOW,
  );
  assert.equal(vm.discovery.some((entry) => entry.placeId === "draft-place"), false);
  assert.equal(vm.discovery.some((entry) => entry.placeId === "ok-place"), true);
  // Repository: the canonical read path stays publication-filtered for the
  // Home card data (listPublishedPlaces) — the UI can only render what the
  // server passed (initialPlaces), which is published-only.
  const repoCode = stripComments(repoSource);
  assert.match(repoCode, /\.eq\("publication_status", "published"\)/);
});

// ---------------------------------------------------------------------------
// 6. search keeps working
// ---------------------------------------------------------------------------

test("search keeps its existing single implementation across every layer", () => {
  const code = stripComments(home);
  // ONE search step feeds ALL layers (no second search implementation).
  assert.match(code, /const searchFiltered = useMemo\(/);
  assert.match(code, /toLocaleLowerCase\("id-ID"\)/);
  assert.match(code, /haystack\.includes\(normalizedQuery\)/);
  // The search-filtered id set gates the Discovery row — search narrows it.
  assert.match(code, /searchFilteredIds\.has\(place\.id\)/);
  // ONE search implementation: exactly one searchFiltered memo step exists —
  // every layer derives from it, none re-implements the query comparison.
  assert.equal((code.match(/const searchFiltered = useMemo\(/g) ?? []).length, 1, "exactly one search implementation");
});

// ---------------------------------------------------------------------------
// 7. map behavior stays locked
// ---------------------------------------------------------------------------

test("map behavior is untouched: dataset, camera presets, curated camera", () => {
  const code = stripComments(home);
  // Map dataset = content-filtered Places with canonical coords (never
  // radius-gated in the normal modes; the curated mode adds its own explicit
  // coverage step, locked above).
  const mapDataset = code.slice(code.indexOf("const mapPlaces"));
  assert.match(mapDataset, /: visiblePlaces;/);
  // ONE camera preset path, curated camera intact (locked Task 1 semantics).
  assert.match(code, /cameraRadiusMeters=\{\s*curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]\s*\}/);
  // The curated marker treatment is per Place (canonical is_curated), not a
  // mode-level prop — the curated map shows both kinds at once.
  assert.doesNotMatch(code, /curatedMarkers/);
  assert.match(code, /isCurated: curatedOnly && curatedIdSet\.has\(place\.id\),/);
  // Distance tabs never became filters again; no removed filter is revived.
  assert.equal(code.includes("CURATED_COLLECTIONS"), false);
  assert.equal(code.includes("Di sekitar saya"), false);
  assert.equal(/500 m/.test(code), false);
});

// ---------------------------------------------------------------------------
// 8. LIVE behavior stays locked
// ---------------------------------------------------------------------------

test("LIVE behavior is untouched: poll gate, cards, filter, per-card affordances", () => {
  const code = stripComments(home);
  // The 15s poll runs only while the LIVE tab is active.
  assert.match(code, /if \(!liveOnly\) return;/);
  assert.match(code, /window\.setInterval\(load, 15000\)/);
  assert.match(code, /\}, \[liveOnly\]\);/);
  // LIVE stays a process/status filter on the content pipeline.
  assert.match(code, /liveByPlaceId\.has\(place\.id\)/);
  // LIVE cards stay hidden inside the Tempat Pilihan layer.
  assert.match(code, /!curatedOnly && liveCards\.length > 0/);
  // The permanent per-card LIVE affordances survive verbatim.
  assert.match(code, /LIVE — Lihat proses sekarang/);
  assert.match(code, /LIVE — Belum berlangsung/);
});

// ---------------------------------------------------------------------------

test("stars are displayed from the engine output without exposing the numeric score", () => {
  const code = stripComments(home);
  // The UI may read only stars/rank from the view model entries.
  assert.doesNotMatch(code, /entry\.score|\.score\b/);
  // The view model type carries no public score field.
  const viewModel = stripComments(
    readFileSync(new URL("../lib/discovery/view-model.ts", import.meta.url), "utf8"),
  );
  assert.match(viewModel, /DiscoveryPublicPlace = DiscoveryRankedPlace/);
  assert.doesNotMatch(viewModel, /score: number/);
});

// ---------------------------------------------------------------------------
// P0 INTEGRITY — the Discovery Place row is the CANONICAL result, not the
// published list re-sorted by rank.
// ---------------------------------------------------------------------------

test("P0: the Discovery Place row is built from the canonical discovery result", () => {
  const code = stripComments(home);
  // The row iterates the server view model's canonical entries and resolves
  // each id; a Place that the engine did not rank has no entry and therefore
  // cannot be rendered.
  assert.match(code, /const discoveryRowPlaces = useMemo\(/);
  const row = code.slice(code.indexOf("const discoveryRowPlaces"), code.indexOf("const curatedListed"));
  assert.match(row, /discovery\?\.discovery \?\? \[\]/);
  assert.match(row, /placeById\.get\(entry\.placeId\)/);
  assert.match(row, /searchFilteredIds\.has\(place\.id\)/);
  // Every render of the row goes through that one canonical list — there is no
  // second list that can leak a published-but-ineligible Place.
  assert.equal((code.match(/discoveryRowPlaces\.map\(/g) ?? []).length, 1);
  // Ranking rank is NOT used as an eligibility proxy anymore: the old
  // "sort the published list by rank, then append unranked Places" path is
  // gone, together with the rank lookup it depended on.
  assert.doesNotMatch(code, /rankById/);
  assert.doesNotMatch(code, /orderedListed/);
});

test("P0: a published but ineligible Place cannot reach the Discovery Place row", () => {
  // Engine proof: published + NOT publication-ready (no canonical coordinates)
  // is published yet ineligible, so it never enters discovery.discovery.
  const publishedNotReady = makeInput("published-not-ready", { coordinates: null });
  const eligible = makeInput("eligible-place");
  const vm = buildDiscoveryViewModel([publishedNotReady, eligible], new Set(), NOW);

  assert.equal(
    vm.discovery.some((entry) => entry.placeId === "published-not-ready"),
    false,
    "published-but-ineligible Place must not be in the canonical Discovery result",
  );
  assert.equal(
    vm.discovery.some((entry) => entry.placeId === "eligible-place"),
    true,
    "eligible Place must be present",
  );

  // Home join proof: the row can only surface ids the engine produced, so a
  // published card that the engine rejected stays invisible even though the
  // server also passed it in `initialPlaces`.
  const placeCardsById = new Map(
    [publishedNotReady, eligible].map((input) => [input.place.id, input.place] as const),
  );
  const rowIds = vm.discovery
    .map((entry) => placeCardsById.get(entry.placeId))
    .filter((place) => place !== undefined)
    .map((place) => place.id);
  assert.deepEqual(rowIds, ["eligible-place"]);
});

test("P0: the Discovery row can never widen the canonical id set", () => {
  // Search and the viewport gate are the only narrowing steps; neither can add
  // an id that the engine did not rank. A rank is presentation only.
  // (SUPERSEDED 2026-10-01: the radius gate became the real-viewport gate;
  // both are filter-only steps, so the invariant is unchanged.)
  const code = stripComments(home);
  const row = code.slice(code.indexOf("const discoveryRowPlaces"), code.indexOf("const curatedListed"));
  const filtering = row.split("return").slice(1).join("return");
  assert.match(
    filtering,
    /narrowToViewport\(canonical, coverageViewport\)/,
    "only filter steps, no re-mapping from a wider source",
  );
  assert.doesNotMatch(row, /listedPlaces/);
  assert.doesNotMatch(row, /places\.filter/);
  // Executable proof that the viewport gate can only REMOVE canonical entries,
  // never add or re-order one.
  const canonical = [
    { id: "a", latitude: -6.2, longitude: 106.8 },
    { id: "b", latitude: -6.25, longitude: 106.8 },
    { id: "c", latitude: -7.5, longitude: 107.9 },
  ];
  const viewport: MapViewport = { north: -6.1, south: -6.3, east: 106.9, west: 106.7 };
  assert.deepEqual(
    narrowToViewport(canonical, viewport).map((place) => place.id),
    ["a", "b"],
    "canonical order preserved, only the out-of-viewport Place removed",
  );
});

// ---------------------------------------------------------------------------
// P0 EMPTY STATE — curatedOnly with an empty curated id set stays empty.
// ---------------------------------------------------------------------------

test("P0: empty curated set produces an empty Tempat Pilihan result (no published fallback)", () => {
  const code = stripComments(home);
  const visible = code.slice(code.indexOf("const visiblePlaces"), code.indexOf("const listedPlaces"));
  // The curated branch filters by the curated id set unconditionally.
  assert.match(visible, /if \(curatedOnly\) \{[\s\S]*searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\)/);
  // The old "empty set → show every published Place" fallback is gone: no
  // size check can swap the curated layer for the full published set.
  assert.doesNotMatch(visible, /curatedIdSet\.size > 0/);
  assert.doesNotMatch(visible, /:\s*searchFiltered\s*;/);
  // Curated row and count both follow the empty set. The header counts ONLY
  // the curated selection (PO fix, 2026-09-30): the Discovery Place row is
  // never summed into the Tempat Pilihan counter, and normal modes keep the
  // Discovery Place count. The curated row is narrowed by the REAL visible
  // viewport (product decision, 2026-10-01) on top of that membership set.
  // never summed into the Tempat Pilihan counter, and normal modes keep the
  // Discovery Place count.
  assert.match(
    code,
    /const curatedListed = useMemo\(\s*\(\) => narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
  // The header count stays per-layer (PO fix, 2026-09-30). The NUMBERS are
  // unchanged and still per-layer; the ORIGIN fragment is now `nearOrigin`
  // (bug fix 2026-10-03), which keeps the MOCKUP §11 device wording verbatim
  // and names a searched city when one is active.
  assert.match(
    code,
    /curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\}`\n\s*: `\$\{discoveryRowPlaces\.length\} tempat \$\{nearOrigin\}`/,
  );
  assert.doesNotMatch(code, /curatedListed\.length \+ discoveryRowPlaces\.length/);
});

test("P0: curated map coverage is the REAL VISIBLE VIEWPORT, independent of membership", () => {
  // Behavioural proof of the curated MAP rule with real geometry: a curated
  // Place is on the curated map (canonical membership), an ordinary Place
  // joins it ONLY while it sits inside the visible viewport, and neither fact
  // changes curated membership or the curated list.
  //
  // SUPERSEDED (product decision, 2026-10-01): the fixed 10 km coverage
  // radius around the Current Location is retired — the Leaflet viewport is
  // the coverage source, so the same Places change membership on screen when
  // the user pans instead of when a radius preset is chosen.
  const viewport: MapViewport = { north: -6.1, south: -6.3, east: 106.9, west: 106.7 };
  const curatedPlace = { ...makeInput("curated-a").place, latitude: -6.2, longitude: 106.8166 };
  const insideOrdinary = { ...makeInput("ordinary-inside").place, latitude: -6.25, longitude: 106.8166 };
  const outsideOrdinary = { ...makeInput("ordinary-outside").place, latitude: -6.6, longitude: 106.8166 };
  const published = [curatedPlace, insideOrdinary, outsideOrdinary];
  const curatedIdSet = new Set(["curated-a"]);

  const curatedListed = published.filter((place) => curatedIdSet.has(place.id));
  const coverage = narrowToViewport(
    published.filter((place) => !curatedIdSet.has(place.id)),
    viewport,
  );
  const mapIds = [...curatedListed, ...coverage].map((place) => place.id);
  assert.deepEqual(curatedListed.map((place) => place.id), ["curated-a"], "list stays curated-only");
  assert.deepEqual(coverage.map((place) => place.id), ["ordinary-inside"], "ordinary Places join the map only inside the viewport");
  assert.deepEqual(mapIds, ["curated-a", "ordinary-inside"], "curated + ordinary-in-viewport on the curated map");
  // Panning the viewport (no data, no preset change) is what adds or removes
  // the ordinary Place from the curated MAP — never a radius preset.
  const pannedAway: MapViewport = { north: -6.1, south: -6.3, east: 106.75, west: 106.7 };
  assert.deepEqual(
    narrowToViewport([insideOrdinary], pannedAway).map((place) => place.id),
    [],
    "panning away removes the ordinary Place from the map dataset",
  );
  // The ordinary Place that only appears on the map is NOT curated and does
  // not enter the curated list — and Discovery is not consulted for either.
  assert.equal(curatedIdSet.has("ordinary-inside"), false);
  assert.equal(curatedListed.some((place) => place.id === "ordinary-inside"), false);
  const vm = buildDiscoveryViewModel(
    [makeInput("curated-a"), makeInput("ordinary-inside"), makeInput("ordinary-outside")],
    curatedIdSet,
    NOW,
  );
  assert.deepEqual([...vm.curatedPlaceIds], ["curated-a"], "membership comes only from is_curated");
  assert.equal(vm.discovery.length, 3, "Discovery stays independent of the curated map coverage");
});

test("P0: an empty curated set yields zero curated Places even when places are published", () => {
  // Behavioural proof of the rule, independent of the source shape: the
  // curated layer is an intersection with the curated id set, and an empty set
  // intersects to nothing.
  const searchFiltered = [makeInput("published-a").place, makeInput("published-b").place];
  const curatedIdSet = new Set<string>();
  const curatedListed = searchFiltered.filter((place) => curatedIdSet.has(place.id));
  assert.deepEqual(curatedListed, []);
  // ...while the Discovery layer still resolves normally: the empty curated
  // set never empties Discovery and never empties it into the full set.
  const vm = buildDiscoveryViewModel(
    [makeInput("published-a"), makeInput("published-b")],
    curatedIdSet,
    NOW,
  );
  assert.equal(vm.discovery.length, 2);
  assert.deepEqual(vm.curatedPlaceIds, []);
});

test("P0: the curated MAP shows curated + ordinary Places in coverage, the curated LIST stays curated-only", () => {
  const code = stripComments(home);
  // MEMBERSHIP (canonical is_curated only)...
  assert.match(code, /const curatedIdSet = useMemo\(\s*\(\) => new Set\(discovery\?\.curatedPlaceIds \?\? \[\]\)/);
  const visible = code.slice(code.indexOf("const visiblePlaces"), code.indexOf("const listedPlaces"));
  assert.match(visible, /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);\s*\}/);
  // ...the curated LIST reads that membership and nothing else...
  assert.match(
    code,
    /const curatedListed = useMemo\(\s*\(\) => narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
  // ...and the extra MAP-only source is explicitly the NON-curated remainder,
  // bounded by the 10 km coverage around the REAL fix.
  // RE-ORDERED (product decision, 2026-10-03): the non-curated remainder is
  // named ONCE as `curatedCoverageSource` (the un-narrowed candidate set) and
  // the marker coverage narrows that, so the slice starts there. It ends at
  // the CAMERA dataset, which is a separate rule (the viewer's local area,
  // 2026-10-03) and legitimately reads the real fix.
  const coverage = code.slice(code.indexOf("const curatedCoverageSource"), code.indexOf("const cameraFitPlaces"));
  assert.match(coverage, /if \(!curatedOnly\) return \[\];/);
  assert.match(coverage, /searchFiltered\.filter\(\(place\) => !curatedIdSet\.has\(place\.id\)\)/);
  // SUPERSEDED (product decision, 2026-10-01): the 10 km coverage radius and
  // the `!viewerPosition` fallback are retired — the extra map source is now
  // the ordinary remainder INSIDE THE REAL VISIBLE VIEWPORT.
  assert.match(coverage, /return narrowToViewport\(curatedCoverageSource, coverageViewport\);/);
  assert.doesNotMatch(coverage, /distanceMeters\(|viewerPosition|CURATED_MAP_COVERAGE_RADIUS_M/);
  // The map dataset is curated + coverage places, deduplicated, coordinates
  // fail-closed, and each Place carries its OWN curated flag for the marker.
  const mapDataset = code.slice(code.indexOf("const mapPlaces"), code.indexOf("const mapEmptyStateVisible"));
  assert.match(mapDataset, /const source = curatedOnly \? \[\.\.\.visiblePlaces, \.\.\.curatedCoveragePlaces\] : visiblePlaces;/);
  assert.match(mapDataset, /if \(seen\.has\(place\.id\)\) return \[\];/);
  assert.match(mapDataset, /if \(place\.latitude === null \|\| place\.longitude === null\) return \[\];/);
  assert.match(mapDataset, /isCurated: curatedOnly && curatedIdSet\.has\(place\.id\),/);
  // The coverage source is MAP-ONLY: it can never reach the curated list, the
  // header count, or Discovery.
  const curatedRow = code.slice(code.indexOf("const curatedListed"), code.indexOf("const curatedCoveragePlaces"));
  assert.doesNotMatch(curatedRow, /curatedCoveragePlaces|CURATED_MAP_COVERAGE_RADIUS_M/);
  assert.doesNotMatch(code, /discovery\?\.discovery[\s\S]{0,200}curatedCoveragePlaces/);
  // The curated camera radius stays CAMERA-ONLY: it is never a dataset or
  // membership input, so a 10 km frame can never fabricate Places.
  assert.doesNotMatch(code, /matchesDistance\([^)]*CURATED_CAMERA_RADIUS_M|distanceMeters\([^)]*CURATED_CAMERA_RADIUS_M/);
  // The dataset-empty branch of the overlay stays the truthful fallback when
  // neither curated Places nor coverage Places exist.
  assert.match(
    code,
    /const mapEmptyStateVisible =\n\s*mapPlaces\.length === 0 \|\| \(viewportReported && !viewportHasPlaces\);/,
  );
});

test("P0: ordinary coverage Places never leak into the curated list or its count", () => {
  const code = stripComments(home);
  // The curated row, its counter, and the map-only coverage source are three
  // separate statements: the coverage Places exist ONLY inside mapPlaces.
  const curatedListSlice = code.slice(code.indexOf("const curatedListed"), code.indexOf("const curatedCoveragePlaces"));
  assert.doesNotMatch(curatedListSlice, /curatedCoveragePlaces|CURATED_MAP_COVERAGE_RADIUS_M/);
  assert.match(code, /curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\}`/);
  // The coverage memo is referenced by exactly ONE consumer — the map dataset.
  const uses = code.match(/curatedCoveragePlaces/g) ?? [];
  assert.equal(uses.length, 3, "declaration + the curated dataset union + its dependency list only");
  // Behavioural proof of the rule, independent of the source shape: an
  // ordinary Place inside coverage is in the map dataset and NOT in the
  // curated list, while a curated Place is in both and stays curated.
  const places = [makeInput("curated-a").place, makeInput("ordinary-b").place];
  const curatedIdSet = new Set(["curated-a"]);
  const curatedListed = places.filter((place) => curatedIdSet.has(place.id));
  const coverageOnly = places.filter((place) => !curatedIdSet.has(place.id));
  assert.deepEqual(curatedListed.map((place) => place.id), ["curated-a"]);
  assert.deepEqual(coverageOnly.map((place) => place.id), ["ordinary-b"]);
  // Membership never changes because of the map: promoting an ordinary Place
  // is still the Admin's canonical is_curated write, nothing else.
  const vm = buildDiscoveryViewModel([makeInput("curated-a"), makeInput("ordinary-b")], curatedIdSet, NOW);
  assert.deepEqual([...vm.curatedPlaceIds], ["curated-a"]);
  assert.equal(vm.discovery.length, 2, "Discovery stays independent of the curated layer");
});
