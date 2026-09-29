/**
 * Admin Discovery visibility (Stage 4): the canonical engine's current
 * evaluation of ONE Place, read-only.
 *
 * Pure presentational mapping from the server-built view: the star tier, the
 * engine rank, and the per-component breakdown in the PO vocabulary
 * (Kelengkapan / Pengalaman / Aktivitas / Engagement / Freshness / Relevansi).
 * No numeric score is ever rendered or shipped (contract §3). This component
 * cannot change anything — every control on this surface lives in the
 * curation component, which touches only the Tempat Pilihan flag.
 */
export function formatDiscoveryStars(stars: number): string {
  return "★".repeat(Math.max(1, Math.min(4, stars)));
}

export const DISCOVERY_BREAKDOWN_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "kelengkapan", label: "Kelengkapan" },
  { key: "pengalaman", label: "Pengalaman" },
  { key: "aktivitas", label: "Aktivitas" },
  { key: "engagement", label: "Engagement" },
  { key: "freshness", label: "Freshness" },
  { key: "relevansi", label: "Relevansi" },
];
