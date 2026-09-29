import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDiscoveryScore,
  discoveryStarsForScore,
  evaluateDiscoveryEligibility,
  rankDiscoveryPlaces,
  type DiscoveryEngagementSignal,
  type DiscoveryLiveSignal,
  type DiscoveryPlaceInput,
  type DiscoverySignalSet,
} from "../lib/discovery/scoring";

/**
 * Stage 2 tests — contract docs/DISCOVERY_CONTRACT_v1.0.md.
 * Required cases (user contract): unpublished not eligible, eligible enters
 * scoring, score/stars/ranking deterministic, missing optional signals never
 * crash, min-10 when ≥10 eligible, no duplicate Place, Discovery ⊥ curated.
 */

const NOW = new Date("2026-09-29T12:00:00.000Z");

const ZERO_ENGAGEMENT: DiscoveryEngagementSignal = {
  followers: 0,
  visitIntents: 0,
  publishedExperiences: 0,
  hasCoverImage: false,
  photoCount: 0,
};

function makeInput(
  overrides: {
    id?: string;
    publicationStatus?: "draft" | "published" | "paused" | "archived";
    claimStatus?: "unverified" | "claimed" | "verified";
    coordinates?: { lat: number; lng: number } | null;
    signals?: { live?: DiscoveryLiveSignal | null; engagement?: Partial<DiscoveryEngagementSignal> };
  } = {},
): DiscoveryPlaceInput {
  const {
    id = "place-a",
    publicationStatus = "published",
    claimStatus = "unverified",
    coordinates = { lat: -6.9, lng: 107.6 },
    signals = {},
  } = overrides;
  const live: DiscoveryLiveSignal | null =
    signals.live === undefined
      ? { status: "ended", startedAt: null }
      : signals.live;
  return {
    place: {
      id,
      name: `Place ${id}`,
      shortDescription: "Deskripsi singkat.",
      area: "Bandung",
      address: "Jl. Contoh 123",
      latitude: coordinates ? coordinates.lat : null,
      longitude: coordinates ? coordinates.lng : null,
      claimStatus,
      publicationStatus,
    },
    signals: {
      live,
      engagement: { ...ZERO_ENGAGEMENT, ...(signals.engagement ?? {}) },
    },
  };
}

test("unpublished Place tidak eligible (draft/paused/archived never enter Discovery)", () => {
  for (const status of ["draft", "paused", "archived"] as const) {
    const input = makeInput({ publicationStatus: status });
    assert.equal(evaluateDiscoveryEligibility(input.place), false);
  }
  // Not ranked even if it somehow reaches the engine.
  const ranked = rankDiscoveryPlaces(
    [makeInput({ id: "draft-x", publicationStatus: "draft" })],
    NOW,
  );
  assert.equal(ranked.length, 0);
});

test("eligible Place masuk scoring (published + ready → scored and ranked)", () => {
  const input = makeInput({ id: "ok-place" });
  assert.equal(evaluateDiscoveryEligibility(input.place), true);
  const ranked = rankDiscoveryPlaces([input], NOW);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].placeId, "ok-place");
  assert.equal(ranked[0].stars, 1);
  assert.ok(ranked[0].score >= 0 && ranked[0].score <= 100);
});

test("score deterministic — same inputs and now always produce the same score", () => {
  const input = makeInput({
    id: "det-score",
    signals: {
      live: { status: "ended", startedAt: "2026-09-24T00:00:00.000Z" },
      engagement: { followers: 12, visitIntents: 5, publishedExperiences: 1, hasCoverImage: true, photoCount: 2 },
    },
  });
  const first = computeDiscoveryScore(input, NOW).score;
  const second = computeDiscoveryScore(input, new Date("2026-09-29T12:00:00.000Z")).score;
  assert.equal(first, second);
  const rankedA = rankDiscoveryPlaces([input], NOW);
  const rankedB = rankDiscoveryPlaces([input], NOW);
  assert.deepEqual(rankedA, rankedB);
  assert.ok(first >= 0 && first <= 100);
});

test("stars deterministic — boundary thresholds are inclusive and stable", () => {
  assert.equal(discoveryStarsForScore(0), 1);
  assert.equal(discoveryStarsForScore(29), 1);
  assert.equal(discoveryStarsForScore(30), 2);
  assert.equal(discoveryStarsForScore(60), 3);
  assert.equal(discoveryStarsForScore(85), 4);
  assert.equal(discoveryStarsForScore(100), 4);
  // Live-now alone = 40 → ★★, independent of call count.
  const liveInput = makeInput({ id: "live-now", signals: { live: { status: "live", startedAt: NOW.toISOString() } } });
  const once = computeDiscoveryScore(liveInput, NOW).score;
  const twice = computeDiscoveryScore(liveInput, NOW).score;
  assert.equal(once, twice);
  assert.equal(discoveryStarsForScore(once), 2);
});

test("ranking deterministic — full tie resolves through the locked chain", () => {
  const base = { lat: -6.9, lng: 107.6 };
  const quiet = (id: string, claim: "unverified" | "claimed" | "verified") =>
    makeInput({ id, claimStatus: claim, coordinates: base });

  // Identical silent places: only id remains → deterministic alphabetical order.
  const silent = [quiet("toko-aaa", "unverified"), quiet("toko-bbb", "unverified")];
  assert.deepEqual(
    rankDiscoveryPlaces(silent, NOW).map((p) => p.placeId),
    ["toko-aaa", "toko-bbb"],
  );

  // Same score, verified wins the tie-break over unverified.
  const mixed = [quiet("b-unverified", "unverified"), quiet("a-verified", "verified")];
  assert.deepEqual(
    rankDiscoveryPlaces(mixed, NOW).map((p) => p.placeId),
    ["a-verified", "b-unverified"],
  );
});

test("missing optional signal tidak menyebabkan crash (null live, 0 counts, no coordinates)", () => {
  const input = makeInput({ id: "silent-place", coordinates: null });
  assert.equal(evaluateDiscoveryEligibility(input.place), false); // E2: map-first needs coordinates
  const noCoordinates = rankDiscoveryPlaces([input], NOW);
  assert.deepEqual(noCoordinates, []);

  const sparse = rankDiscoveryPlaces(
    [
      makeInput({
        id: "sparse-place",
        signals: { live: null, engagement: {} },
      }),
    ],
    NOW,
  );
  assert.equal(sparse.length, 1);
  assert.equal(sparse[0].score, 0);
  assert.equal(sparse[0].stars, 1);
});

test("minimal 10 eligible Places dipilih penuh saat tersedia ≥10 eligible", () => {
  const inputs = Array.from({ length: 15 }, (_, i) =>
    makeInput({
      id: `p-${String(i).padStart(2, "0")}`,
      signals: {
        live: null,
        engagement: { followers: (15 - i) % 8, visitIntents: i % 4 },
      },
    }),
  );
  const ranked = rankDiscoveryPlaces(inputs, NOW);
  assert.equal(ranked.length, 15);
  assert.ok(ranked.length >= 10);
  const ranks = ranked.map((p) => p.rank);
  assert.deepEqual(ranks, Array.from({ length: 15 }, (_, i) => i + 1));
  const ids = new Set(ranked.map((p) => p.placeId));
  assert.equal(ids.size, 15);
  // Order is strictly non-increasing by score.
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
  // No hardcoded ids and no randomness: repeated calls match exactly.
  assert.deepEqual(rankDiscoveryPlaces(inputs, NOW), ranked);
});

test("tidak ada duplicate Place — duplicated id collapses to one entry", () => {
  const original = makeInput({ id: "dup-place" });
  const copy = makeInput({ id: "dup-place" });
  const ranked = rankDiscoveryPlaces([original, copy, original], NOW);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].placeId, "dup-place");
});

test("Discovery + curated tidak saling meniadakan — engine is curated-blind", () => {
  // The engine's API has no curated parameter at all; adding/omitting any
  // hypothetical curated state outside the engine cannot change its output.
  const input = makeInput({
    id: "both-layers",
    signals: { live: { status: "live", startedAt: NOW.toISOString() }, engagement: { followers: 30 } },
  });
  const withoutCurated = rankDiscoveryPlaces([input], NOW);
  const withCurated = rankDiscoveryPlaces([{ ...input, place: { ...input.place } }], NOW);
  assert.deepEqual(withoutCurated, withCurated);
  assert.equal(withoutCurated[0].placeId, "both-layers");
  assert.ok(withoutCurated[0].stars >= 2);
  // Structural proof: no key of the input types mentions curated state.
  const inputKeys = JSON.stringify(Object.keys(input)) + JSON.stringify(Object.keys(input.signals));
  assert.equal(inputKeys.toLowerCase().includes("curated"), false);
});

test("score components follow the locked formula (sanity anchors)", () => {
  const now = NOW;
  // Live now alone → exactly 40 → ★★.
  const liveNow = makeInput({ id: "anchor-live", signals: { live: { status: "live", startedAt: now.toISOString() } } });
  assert.equal(computeDiscoveryScore(liveNow, now).score, 40);
  // Ended 7 days ago → L=0.5 → 20.
  const ended7 = makeInput({
    id: "anchor-7d",
    signals: { live: { status: "ended", startedAt: "2026-09-22T12:00:00.000Z" } },
  });
  assert.equal(computeDiscoveryScore(ended7, now).score, 20);
  // Followers at saturation → F=1 → 25.
  const followers100 = makeInput({ id: "anchor-follow", signals: { live: null, engagement: { followers: 100 } } });
  assert.equal(computeDiscoveryScore(followers100, now).score, 25);
  // Visit intents at saturation → V=1 → 20.
  const intents50 = makeInput({ id: "anchor-intent", signals: { live: null, engagement: { visitIntents: 50 } } });
  assert.equal(computeDiscoveryScore(intents50, now).score, 20);
  // Two published experiences → experiences term maxed: E = 8/15 → 15*(8/15)=8.
  const twoExp = makeInput({ id: "anchor-exp", signals: { live: null, engagement: { publishedExperiences: 2 } } });
  assert.equal(computeDiscoveryScore(twoExp, now).score, 8);
  // 0 signals → 0 → ★ baseline.
  const zero = makeInput({ id: "anchor-zero" });
  assert.equal(computeDiscoveryScore(zero, now).score, 0);
});
