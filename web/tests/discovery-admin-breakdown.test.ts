import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  computeDiscoveryScore,
  computeDiscoveryScoreBreakdown,
  rankDiscoveryPlaces,
  type DiscoveryEngagementSignal,
  type DiscoveryLiveSignal,
  type DiscoveryPlaceInput,
} from "../lib/discovery/scoring";
import { DISCOVERY_BREAKDOWN_LABELS } from "../lib/admin/discovery-view";

/**
 * ADMIN DISCOVERY BREAKDOWN INTEGRITY (contract §3/§4).
 *
 * The Admin Place workspace shows HOW the locked formula weighs a Place. Each
 * displayed row must be a real contribution in points from the canonical
 * engine, so the row set reconstructs the score. Fabricated proxies
 * (publication readiness 0/100, coordinates 0/100) and duplicated components
 * (two rows reading the same live component) are the failure modes guarded
 * here.
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
  id: string,
  signals: { live?: DiscoveryLiveSignal | null; engagement?: Partial<DiscoveryEngagementSignal> } = {},
): DiscoveryPlaceInput {
  return {
    place: {
      id,
      name: `Place ${id}`,
      shortDescription: "Deskripsi singkat.",
      area: "Bandung",
      address: "Jl. Contoh 123",
      latitude: -6.9,
      longitude: 107.6,
      claimStatus: "unverified",
      publicationStatus: "published",
    },
    signals: {
      live: signals.live === undefined ? null : signals.live,
      engagement: { ...ZERO_ENGAGEMENT, ...(signals.engagement ?? {}) },
    },
  };
}

/** The five displayed rows, mapped exactly like the Admin workspace maps them. */
function displayedBreakdown(input: DiscoveryPlaceInput): Record<string, number> {
  const contributions = computeDiscoveryScoreBreakdown(input, NOW);
  const values: Record<string, number> = {
    aktivitas: Math.round(contributions.liveActivity),
    freshness: Math.round(contributions.liveRecency),
    engagement: Math.round(contributions.followers + contributions.visitIntent),
    pengalaman: Math.round(contributions.experiences),
    kelengkapan: Math.round(contributions.media),
  };
  return values;
}

test("every displayed row is a canonical contribution and the rows sum to the score", () => {
  const fixtures = [
    makeInput("quiet"),
    makeInput("live-now", { live: { status: "live", startedAt: NOW.toISOString() } }),
    makeInput("ended-7d", { live: { status: "ended", startedAt: "2026-09-22T12:00:00.000Z" } }),
    makeInput("ended-13d", { live: { status: "ended", startedAt: "2026-09-16T12:00:00.000Z" } }),
    makeInput("followers-only", { engagement: { followers: 100 } }),
    makeInput("intents-only", { engagement: { visitIntents: 50 } }),
    makeInput("experiences-only", { engagement: { publishedExperiences: 2 } }),
    makeInput("media-only", { engagement: { hasCoverImage: true, photoCount: 3 } }),
    makeInput("everything", {
      live: { status: "live", startedAt: NOW.toISOString() },
      engagement: {
        followers: 100,
        visitIntents: 50,
        publishedExperiences: 2,
        hasCoverImage: true,
        photoCount: 3,
      },
    }),
  ];
  for (const input of fixtures) {
    const breakdown = displayedBreakdown(input);
    const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
    assert.equal(
      Math.round(total),
      computeDiscoveryScore(input, NOW).score,
      `breakdown for ${input.place.id} must reconstruct the canonical score`,
    );
    // No row can carry weight it does not have in contract §3.
    assert.ok(breakdown.aktivitas <= 40, "aktivitas ≤ 40 (live component weight)");
    assert.ok(breakdown.freshness <= 40, "freshness ≤ 40 (live component weight)");
    assert.ok(breakdown.engagement <= 45, "engagement ≤ 45 (followers 25 + visit intent 20)");
    assert.ok(breakdown.pengalaman <= 8, "pengalaman ≤ 8 (experience term of E)");
    assert.ok(breakdown.kelengkapan <= 7, "kelengkapan ≤ 7 (media term of E)");
  }
});

test("aktivitas and freshness are distinct branches of one component, never duplicates", () => {
  // Live right now → the whole live component is activity, freshness is zero.
  const live = displayedBreakdown(makeInput("live-now", { live: { status: "live", startedAt: NOW.toISOString() } }));
  assert.equal(live.aktivitas, 40);
  assert.equal(live.freshness, 0);
  // Ended 7 days ago → activity zero, freshness carries the decay.
  const ended = displayedBreakdown(makeInput("ended-7d", { live: { status: "ended", startedAt: "2026-09-22T12:00:00.000Z" } }));
  assert.equal(ended.aktivitas, 0);
  assert.equal(ended.freshness, 20);
  // No session at all → neither branch fires.
  const silent = displayedBreakdown(makeInput("quiet"));
  assert.equal(silent.aktivitas, 0);
  assert.equal(silent.freshness, 0);
});

test("the breakdown carries no fabricated proxy component", () => {
  const code = readFileSync(new URL("../lib/admin/place-workspace.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  const fn = code.slice(code.indexOf("export async function getAdminPlaceDiscoveryView"));

  // The breakdown reads the engine's contributions — it never recomputes
  // eligibility/score pieces inline (that would be a second scoring path).
  assert.match(fn, /computeDiscoveryScoreBreakdown\(input, now\)/);
  assert.doesNotMatch(fn, /liveComponent\(|followerComponent\(|visitIntentComponent\(|ecosystemComponent\(/);

  // The two rejected proxies are gone: coordinates as a "relevance" score and
  // publication readiness as a "completeness" score. Readiness stays an
  // eligibility gate, never a displayed 0/100 component.
  assert.equal(fn.includes("relevansi"), false, "no coordinates proxy in the breakdown");
  assert.equal(
    /kelengkapan:\s*isPlacePublicationReady/.test(fn),
    false,
    "kelengkapan must come from the media contribution, not publication readiness",
  );
  // No duplicate reading of the live component.
  assert.equal(
    (fn.match(/liveComponent\(/g) ?? []).length,
    0,
    "aktivitas and freshness must not both read the same live component",
  );
  // The numeric score still never reaches the Admin client payload.
  assert.equal(/^\s*score:\s/m.test(fn), false, "the integer score stays server-side");
});

test("the displayed label set matches the canonical contribution set exactly", () => {
  assert.deepEqual(
    DISCOVERY_BREAKDOWN_LABELS.map(({ key }) => key).slice().sort(),
    ["aktivitas", "engagement", "freshness", "kelengkapan", "pengalaman"],
  );
  // Every label has a real contributor; no label renders a constant.
  const breakdown = displayedBreakdown(
    makeInput("media-heavy", { engagement: { hasCoverImage: true, photoCount: 3 } }),
  );
  for (const { key } of DISCOVERY_BREAKDOWN_LABELS) {
    assert.equal(typeof breakdown[key], "number", `${key} must be backed by a computed value`);
  }
  assert.equal(breakdown.kelengkapan, 7);
  // Stars remain the only Discovery value rendered from the tier; the ranked
  // engine output still supplies stars and rank for the same Place.
  const ranked = rankDiscoveryPlaces(
    [
      makeInput("media-heavy", { engagement: { hasCoverImage: true, photoCount: 3 } }),
      makeInput("quiet-2"),
    ],
    NOW,
  );
  assert.equal(ranked[0].placeId, "media-heavy");
});