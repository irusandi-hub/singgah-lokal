import {
  rankDiscoveryPlaces,
  type DiscoveryPlaceInput,
  type DiscoveryRankedPlace,
} from "./scoring";

/**
 * DISCOVERY VIEW MODEL — pure mapping from the locked engine's output to the
 * public Home shape. No I/O, no clock, no Supabase: plain-Node testable.
 *
 * The numeric score NEVER passes through here (contract §3) — stars and rank
 * only. Layers are passed through independently: the Tempat Pilihan ids and
 * the Discovery ranking are never intersected, deduplicated, or re-sorted —
 * one Place may appear in BOTH layers (Stage 3 OVERLAP rule).
 */

/** Public view of one Discovery Place — stars + rank only, no numeric score. */
export type DiscoveryPublicPlace = DiscoveryRankedPlace;

/** Server-built view model handed to the Home UI. */
export type DiscoveryViewModel = {
  /**
   * Ranked Discovery entries (engine order, never re-sorted client-side).
   * Home joins the full Place card data from `initialPlaces` by id.
   */
  discovery: DiscoveryPublicPlace[];
  /** Ids of published Places carrying the Tempat Pilihan flag (0035). */
  curatedPlaceIds: string[];
};

export function buildDiscoveryViewModel(
  inputs: readonly DiscoveryPlaceInput[],
  curatedPlaceIds: ReadonlySet<string>,
  now: Date,
): DiscoveryViewModel {
  const ranked = rankDiscoveryPlaces(inputs, now).map(({ placeId, stars, rank }) => ({
    placeId,
    stars,
    rank,
  }));
  return {
    discovery: ranked,
    curatedPlaceIds: [...curatedPlaceIds],
  };
}
