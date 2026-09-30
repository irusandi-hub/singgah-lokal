/**
 * Admin Discovery visibility (Stage 4): the canonical engine's current
 * evaluation of ONE Place, read-only.
 *
 * Pure presentational mapping from the server-built view: the star tier, the
 * engine rank, and the per-component breakdown in the PO vocabulary. Each
 * label is one contract §3 contribution in POINTS, so the row set adds up to
 * the canonical score (no fabricated or duplicated component). No numeric
 * score is ever rendered or shipped (contract §3). This component cannot
 * change anything — every control on this surface lives in the curation
 * component, which touches only the Tempat Pilihan flag.
 */
export function formatDiscoveryStars(stars: number): string {
  return "★".repeat(Math.max(1, Math.min(4, stars)));
}

export const DISCOVERY_BREAKDOWN_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "aktivitas", label: "Aktivitas" },
  { key: "freshness", label: "Freshness" },
  { key: "engagement", label: "Engagement" },
  { key: "pengalaman", label: "Pengalaman" },
  { key: "kelengkapan", label: "Kelengkapan" },
];
