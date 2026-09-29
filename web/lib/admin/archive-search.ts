/**
 * The archive search KEY contract — shared by the server page, the results
 * table, and the client search form.
 *
 * This module is deliberately shared and directive-free: it is the one place
 * the key vocabulary lives, so the server page and the client form read the
 * SAME keys from a module importable from both sides. Non-component values
 * must never be imported FROM a client component into a server component — a
 * client module's exports are client references on the server, and using one
 * as a plain array/object throws at render.
 */

export const ARCHIVE_SEARCH_KEYS = ["placeId", "userId", "email", "claimId"] as const;

export type ArchiveSearchKey = (typeof ARCHIVE_SEARCH_KEYS)[number];

export const ARCHIVE_SEARCH_LABELS: Record<ArchiveSearchKey, string> = {
  placeId: "Place ID",
  userId: "Pengelola ID",
  email: "Email",
  claimId: "Claim ID",
};

export function isArchiveSearchKey(value: string): value is ArchiveSearchKey {
  return (ARCHIVE_SEARCH_KEYS as readonly string[]).includes(value);
}
