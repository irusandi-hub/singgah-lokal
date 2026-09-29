import {
  isPlacePublicationReady,
  type ClaimStatus,
  type PublicationStatus,
} from "../places";

/**
 * DISCOVERY ENGINE — single source of truth.
 * Contract: docs/DISCOVERY_CONTRACT_v1.0.md (Stage 1, LOCKED).
 *
 * One implementation only. No other module may compute eligibility, score,
 * stars, or ranking; Home and Admin must CALL this engine, never recompute
 * (Stage 2 instruction). All functions are pure and deterministic: the same
 * inputs (including the explicit `now`) always produce the same output.
 *
 * Locked product rules (AGENTS.md + contract §0):
 * - Discovery is computed by the system; it is never a manual status and
 *   Admin never selects it (no write path exists for any output here).
 * - Publication is the base requirement; draft/paused/archived never enter.
 * - Tempat Pilihan is a separate admin-promoted layer; a Place may be in
 *   both layers. Nothing here reads or writes any curated state, so the
 *   layers cannot cancel each other out.
 * - No hardcoded Place ids, no randomness, no clock reads inside the
 *   functions (`now` is always an explicit argument).
 * - Only canonical signals are consumed (contract §1). No rating (none
 *   exists), no page analytics, no payment data, no cache/search index.
 */

/** Minimal Place facts the engine reads. Publication/claim fields mirror `lib/places.ts`. */
export type DiscoveryPlaceBase = {
  id: string;
  name: string;
  shortDescription: string;
  area: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  claimStatus: ClaimStatus;
  publicationStatus: PublicationStatus;
};

/** Canonical live-session facts for one Place (from `live_sessions`). */
export type DiscoveryLiveSignal = {
  status: "scheduled" | "live" | "ended";
  /** ISO timestamp; session must have started to contribute. */
  startedAt: string | null;
};

/** Canonical follower/visit/experience counts for one Place. */
export type DiscoveryEngagementSignal = {
  /** Row count in `place_follows` for this Place (migration 0023). */
  followers: number;
  /** Row count in `visit_intents` for this Place (migration 0001). */
  visitIntents: number;
  /** Count of `experiences` rows with status='published' AND publication_status='published'. */
  publishedExperiences: number;
  /** Non-null when `places.cover_image_url` exists (migration 0018). */
  hasCoverImage: boolean;
  /** Row count in `place_photos` for this Place (migration 0021). */
  photoCount: number;
};

/** `null` when the Place has no live session at all. */
export type DiscoverySignalSet = {
  live: DiscoveryLiveSignal | null;
  engagement: DiscoveryEngagementSignal;
};

/** A Place fully prepared for engine evaluation. */
export type DiscoveryPlaceInput = {
  place: DiscoveryPlaceBase;
  signals: DiscoverySignalSet;
};

/** A Place that passed eligibility. `star` is derived, never stored. */
export type DiscoveryEligibility = {
  placeId: string;
  eligible: true;
};

/** The integer 0–100 score per contract §3. Never exposed to the public client. */
export type DiscoveryScore = {
  placeId: string;
  score: number;
};

/** Exactly the four contract tiers. Baseline ★ is guaranteed by eligibility. */
export type DiscoveryStars = 1 | 2 | 3 | 4;

/** Ranked, star-labelled Discovery entry. Numeric score is internal only. */
export type DiscoveryRankedPlace = {
  placeId: string;
  stars: DiscoveryStars;
  /** Position in the deterministic contract §5 ordering, starting at 1. */
  rank: number;
};

const LIVE_RECENCY_WINDOW_DAYS = 14;
const FOLLOWER_SATURATION = 100;
const VISIT_INTENT_SATURATION = 50;
const SCORE_STAR_2 = 30;
const SCORE_STAR_3 = 60;
const SCORE_STAR_4 = 85;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Contract E1+E2 — the ONLY eligibility predicate.
 * E1: publication_status must be `published` (draft/paused/archived never).
 * E2: the existing `isPlacePublicationReady` (name/short/area/address +
 * canonical finite lat/lng) — reused verbatim, never reimplemented.
 */
export function evaluateDiscoveryEligibility(place: DiscoveryPlaceBase): boolean {
  if (place.publicationStatus !== "published") return false;
  return isPlacePublicationReady({
    ...place,
    category: "Sumber Daya Alam",
    type: "production",
    contactInformation: "",
    timezone: "Asia/Jakarta",
    currency: "IDR",
    countryCode: null,
    regionName: null,
    coverImageUrl: null,
    producer: null,
  });
}

/** Component L (weight 40): live now = 1; recency decay over 14 days; else 0. */
export function liveComponent(
  live: DiscoveryLiveSignal | null,
  now: Date,
): number {
  if (!live) return 0;
  if (live.status === "live") return 1;
  if (!live.startedAt) return 0;
  const startedMs = new Date(live.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return 0;
  const ageDays = (now.getTime() - startedMs) / 86_400_000;
  if (ageDays < 0 || ageDays >= LIVE_RECENCY_WINDOW_DAYS) return 0;
  return clamp01(1 - ageDays / LIVE_RECENCY_WINDOW_DAYS);
}

/** Component F (weight 25): log-scaled follower count saturated at 100. */
export function followerComponent(followers: number): number {
  if (!Number.isFinite(followers) || followers <= 0) return 0;
  return clamp01(Math.log1p(followers) / Math.log1p(FOLLOWER_SATURATION));
}

/** Component V (weight 20): log-scaled visit-intent count saturated at 50. */
export function visitIntentComponent(visitIntents: number): number {
  if (!Number.isFinite(visitIntents) || visitIntents <= 0) return 0;
  return clamp01(Math.log1p(visitIntents) / Math.log1p(VISIT_INTENT_SATURATION));
}

/** Component E (weight 15): ecosystem richness — experiences (8) + media (7). */
export function ecosystemComponent(engagement: DiscoveryEngagementSignal): number {
  const experiences = clamp01(
    (Number.isFinite(engagement.publishedExperiences) ? engagement.publishedExperiences : 0) / 2,
  );
  const photos = clamp01(
    (Number.isFinite(engagement.photoCount) ? engagement.photoCount : 0) / 3,
  );
  const media = clamp01(0.4 * (engagement.hasCoverImage ? 1 : 0) + 0.2 * photos);
  return (8 / 15) * experiences + (7 / 15) * media;
}

/**
 * Contract §3 formula — LOCKED. `score = round(40L + 25F + 20V + 15E)`.
 * Do not change this formula here; the contract is the only authority.
 */
export function computeDiscoveryScore(
  input: DiscoveryPlaceInput,
  now: Date,
): DiscoveryScore {
  const score = Math.round(
    40 * liveComponent(input.signals.live, now) +
      25 * followerComponent(input.signals.engagement.followers) +
      20 * visitIntentComponent(input.signals.engagement.visitIntents) +
      15 * ecosystemComponent(input.signals.engagement),
  );
  return { placeId: input.place.id, score: Math.max(0, Math.min(100, score)) };
}

/** Contract §4 thresholds — inclusive. Eligible places are always ≥ ★. */
export function discoveryStarsForScore(score: number): DiscoveryStars {
  if (score >= SCORE_STAR_4) return 4;
  if (score >= SCORE_STAR_3) return 3;
  if (score >= SCORE_STAR_2) return 2;
  return 1;
}

/** Full tie-break chain of contract §5 (deterministic, viewer-independent). */
export function compareRankedDiscovery(
  a: { input: DiscoveryPlaceInput; score: number },
  b: { input: DiscoveryPlaceInput; score: number },
): number {
  if (b.score !== a.score) return b.score - a.score;
  const aVerified = a.input.place.claimStatus === "verified" ? 1 : 0;
  const bVerified = b.input.place.claimStatus === "verified" ? 1 : 0;
  if (bVerified !== aVerified) return bVerified - aVerified;
  const aFollowers = a.input.signals.engagement.followers;
  const bFollowers = b.input.signals.engagement.followers;
  if (bFollowers !== aFollowers) return bFollowers - aFollowers;
  const aIntents = a.input.signals.engagement.visitIntents;
  const bIntents = b.input.signals.engagement.visitIntents;
  if (bIntents !== aIntents) return bIntents - aIntents;
  const aRecency = latestLiveStartedAtMs(a.input.signals.live);
  const bRecency = latestLiveStartedAtMs(b.input.signals.live);
  if (aRecency !== bRecency) {
    if (aRecency === null) return 1;
    if (bRecency === null) return -1;
    return bRecency - aRecency;
  }
  return a.input.place.id < b.input.place.id ? -1 : a.input.place.id > b.input.place.id ? 1 : 0;
}

function latestLiveStartedAtMs(live: DiscoveryLiveSignal | null): number | null {
  if (!live?.startedAt) return null;
  const ms = new Date(live.startedAt).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Eligible → score → stars → deterministic rank, in one pass.
 * Returns ONLY eligible places, each exactly once (input ids are deduped;
 * a duplicated id can never produce duplicate entries). The numeric score
 * never leaves this module's richer return — the public mapping layer maps
 * to `DiscoveryRankedPlace` (stars + rank only).
 */
export function rankDiscoveryPlaces(
  inputs: readonly DiscoveryPlaceInput[],
  now: Date,
): Array<{ placeId: string; stars: DiscoveryStars; rank: number; score: number }> {
  const seen = new Set<string>();
  const evaluated: Array<{ input: DiscoveryPlaceInput; score: number }> = [];
  for (const input of inputs) {
    if (seen.has(input.place.id)) continue;
    seen.add(input.place.id);
    if (!evaluateDiscoveryEligibility(input.place)) continue;
    evaluated.push({ input, score: computeDiscoveryScore(input, now).score });
  }
  evaluated.sort(compareRankedDiscovery);
  return evaluated.map((entry, index) => ({
    placeId: entry.input.place.id,
    stars: discoveryStarsForScore(entry.score),
    rank: index + 1,
    score: entry.score,
  }));
}
