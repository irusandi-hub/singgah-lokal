import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildDiscoveryViewModel } from "../lib/discovery/view-model";
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
  // The default row renders the engine-ordered list (no re-sort client-side):
  // the ranked engine order from the server view model.
  assert.match(code, /orderedListed\.map\(\(place\) =>\s*renderPlaceCard/);
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
  const row2 = code.indexOf("discoveryListed.length > 0");
  assert.ok(row1 >= 0 && row2 > row1, "Baris 1 (Tempat Pilihan) renders before Baris 2 (Discovery Place)");
  assert.match(code, /discoveryListed\.map\(\(place\) =>\s*renderPlaceCard/);
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
  // discoveryListed uses the engine ranking ∩ search; no intersection step.
  const code = stripComments(home);
  assert.match(code, /const curatedListed = useMemo\(/);
  assert.match(code, /const discoveryListed = useMemo\(/);
  assert.equal(code.includes("dedupe"), false);
  // OVERLAP functional proof with the pure view model: Place A is curated
  // AND engine-eligible → present in BOTH lists, never deduplicated.
  const inputA = makeInput("place-a", { followers: 30 });
  const inputB = makeInput("place-b");
  const vm = buildDiscoveryViewModel([inputA, inputB], new Set(["place-a", "place-b"]), NOW);
  assert.equal(vm.curatedPlaceIds.includes("place-a"), true);
  assert.equal(vm.discovery.some((entry) => entry.placeId === "place-a"), true);
  assert.equal(vm.discovery.some((entry) => entry.placeId === "place-b"), true);
  // The Discovery row marks overlap cards with the ✦ Tempat Pilihan marker.
  assert.match(code, /curatedIdSet\.has\(place\.id\)/);
  assert.match(code, /✦ Tempat Pilihan/);
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
  // Map dataset = visiblePlaces with canonical coords (never radius-gated).
  const mapDataset = code.slice(code.indexOf("const mapPlaces"));
  assert.match(mapDataset, /visiblePlaces\.flatMap\(\(place\) =>/);
  // ONE camera preset path, curated camera intact (locked Task 1 semantics).
  assert.match(code, /cameraRadiusMeters=\{\s*curatedOnly \? CURATED_CAMERA_RADIUS_M : CAMERA_PRESET_RADIUS_M\[distanceFilter\]\s*\}/);
  assert.match(code, /curatedMarkers=\{curatedOnly\}/);
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
