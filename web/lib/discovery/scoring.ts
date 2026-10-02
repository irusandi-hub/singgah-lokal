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

/**
 * Canonical score breakdown (contract §3) — every field is a CONTRIBUTION IN
 * POINTS to the locked formula, not an independent 0–100 "quality" rating:
 *
 *   score = 40*L + 25*F + 20*V + 15*E
 *         = 40*(liveNow + recency) + 25*F + 20*V + 8*min(1,exp/2) + 7*media
 *
 * The five contributions therefore sum exactly to the (pre-rounding) score,
 * so any displayed breakdown is traceable arithmetic instead of a parallel
 * heuristic. Nothing outside this module may recompute these values.
 */
export type DiscoveryScoreBreakdown = {
  /** 40 * liveNow — the Place is live right now. */
  liveActivity: number;
  /** 40 * recency — decay of the most recent session (0 while live). */
  liveRecency: number;
  /** 25 * F — follower contribution. */
  followers: number;
  /** 20 * V — visit-intent contribution. */
  visitIntent: number;
  /** 8 * min(1, exp/2) — the experience term of ecosystem richness. */
  experiences: number;
  /** 7 * media — the media/completeness term of ecosystem richness. */
  media: number;
};

/** Contract §3 contributions in points. Additive with `computeDiscoveryScore`. */
export function computeDiscoveryScoreBreakdown(
  input: DiscoveryPlaceInput,
  now: Date,
): DiscoveryScoreBreakdown {
  const { engagement } = input.signals;
  const { liveNow, recency } = liveBranches(input.signals.live, now);
  return {
    liveActivity: LIVE_WEIGHT * liveNow,
    liveRecency: LIVE_WEIGHT * recency,
    followers: FOLLOWER_WEIGHT * followerComponent(engagement.followers),
    visitIntent: VISIT_INTENT_WEIGHT * visitIntentComponent(engagement.visitIntents),
    experiences: ECOSYSTEM_EXPERIENCE_POINTS * experienceComponent(engagement),
    media: ECOSYSTEM_MEDIA_POINTS * mediaComponent(engagement),
  };
}

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
const PHOTO_SATURATION = 3;
const LIVE_WEIGHT = 40;
const FOLLOWER_WEIGHT = 25;
const VISIT_INTENT_WEIGHT = 20;
const MEDIA_COVER_WEIGHT = 0.4;
const MEDIA_PHOTO_WEIGHT = 0.2;
const ECOSYSTEM_EXPERIENCE_POINTS = 8;
const ECOSYSTEM_MEDIA_POINTS = 7;
const ECOSYSTEM_WEIGHT = 15;
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
    isCurated: false,
    // Discovery is deliberately dummy-blind: a Dummy Place is eligible on
    // exactly the same canonical terms as any other Place, so E1+E2 never
    // reads the flag (Master Dummy Place v1.0 §6).
    isDummy: false,
    producer: null,
  });
}

/**
 * Component L (weight 40) — the contract defines it as TWO mutually exclusive
 * branches: `1` while the Place is live, ELSE the 14-day recency decay of the
 * most recent session, ELSE 0. They are returned separately so a
 * human-readable breakdown can show "live now" and "recency" as distinct,
 * non-duplicated contributions; `liveComponent` is their sum and stays the
 * only value the score consumes.
 */
export function liveBranches(
  live: DiscoveryLiveSignal | null,
  now: Date,
): { liveNow: number; recency: number } {
  if (!live) return { liveNow: 0, recency: 0 };
  if (live.status === "live") return { liveNow: 1, recency: 0 };
  if (!live.startedAt) return { liveNow: 0, recency: 0 };
  const startedMs = new Date(live.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return { liveNow: 0, recency: 0 };
  const ageDays = (now.getTime() - startedMs) / 86_400_000;
  if (ageDays < 0 || ageDays >= LIVE_RECENCY_WINDOW_DAYS) return { liveNow: 0, recency: 0 };
  return { liveNow: 0, recency: clamp01(1 - ageDays / LIVE_RECENCY_WINDOW_DAYS) };
}

/** Component L (weight 40): live now = 1; else recency decay over 14 days; else 0. */
export function liveComponent(live: DiscoveryLiveSignal | null, now: Date): number {
  const { liveNow, recency } = liveBranches(live, now);
  return clamp01(liveNow + recency);
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

/**
 * Media richness — contract §3, verbatim:
 * `media = clamp(0.4*[has cover] + 0.2*min(photos,3), 0, 1)`.
 *
 * `min(photos, 3)` is a COUNT cap, not a normalisation: the photo term is
 * already worth the full 0.6 at 3 photos, so cover + 3 photos reaches the
 * full media contribution (0.4 + 0.6 = 1) and more photos add nothing. A
 * cover plus zero photos is 0.4. Never re-normalise this by photo count.
 */
export function mediaComponent(engagement: DiscoveryEngagementSignal): number {
  const photos = Number.isFinite(engagement.photoCount) ? engagement.photoCount : 0;
  return clamp01(
    MEDIA_COVER_WEIGHT * (engagement.hasCoverImage ? 1 : 0) +
      MEDIA_PHOTO_WEIGHT * Math.min(Math.max(photos, 0), PHOTO_SATURATION),
  );
}

/** The published-experience term of component E: `min(1, expCount/2)`. */
export function experienceComponent(engagement: DiscoveryEngagementSignal): number {
  const experiences = Number.isFinite(engagement.publishedExperiences)
    ? engagement.publishedExperiences
    : 0;
  return clamp01(experiences / 2);
}

/** Component E (weight 15): ecosystem richness — experiences (8 pts) + media (7 pts). */
export function ecosystemComponent(engagement: DiscoveryEngagementSignal): number {
  return (
    (ECOSYSTEM_EXPERIENCE_POINTS / ECOSYSTEM_WEIGHT) * experienceComponent(engagement) +
    (ECOSYSTEM_MEDIA_POINTS / ECOSYSTEM_WEIGHT) * mediaComponent(engagement)
  );
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
    LIVE_WEIGHT * liveComponent(input.signals.live, now) +
      FOLLOWER_WEIGHT * followerComponent(input.signals.engagement.followers) +
      VISIT_INTENT_WEIGHT * visitIntentComponent(input.signals.engagement.visitIntents) +
      ECOSYSTEM_WEIGHT * ecosystemComponent(input.signals.engagement),
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
