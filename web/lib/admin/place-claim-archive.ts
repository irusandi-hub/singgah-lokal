import "server-only";

import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * PLACE CLAIM ARCHIVE — internal search (MASTER_DATA_RETENTION_ARCHIVE_POLICY
 * v1.0 §5, §16.1).
 *
 * Searchable by Place ID, claimant (Pengelola) ID, claimant account email,
 * or claim ID. The search runs through the `search_place_claim_archives`
 * RPC, which re-verifies the session's `platform_role = 'platform_moderator'`
 * inside the database on EVERY call and fails closed — the server-side client
 * here never bypasses that guard, it only carries the session context the RPC
 * itself re-checks.
 *
 * This module exists ONLY for the internal Admin API route. It is mounted on
 * NO Dashboard page: the archive never renders as normal history (MASTER §4).
 * Emails never enter `public` tables and never appear in the archive search
 * result — the result carries claim metadata only; evidence bytes stay in the
 * private bucket and are never returned by search.
 */

export type PlaceClaimArchiveRow = {
  id: string;
  placeId: string;
  userId: string;
  status: string;
  evidenceFileName: string | null;
  note: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  archivedAt: string;
};

type ArchiveRpcRow = {
  id: string;
  place_id: string;
  user_id: string;
  status: string;
  evidence_file_name: string | null;
  note: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  archived_at: string;
};

function normalize(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

export async function searchPlaceClaimArchives(filters: {
  placeId?: string | null;
  userId?: string | null;
  email?: string | null;
  claimId?: string | null;
}): Promise<PlaceClaimArchiveRow[]> {
  // The session-derived moderator guard runs HERE first, so the caller's
  // identity is established before any archive read, and again INSIDE the RPC
  // (fail closed, every call). The service-role client carries no session of
  // its own — the RPC's auth.uid() check is independent of this guard.
  await requirePlatformModerator();

  const { data, error } = await createSupabaseServiceClient()
    .rpc("search_place_claim_archives", {
      p_place_id: normalize(filters.placeId),
      p_user_id: normalize(filters.userId),
      p_email: normalize(filters.email),
      p_claim_id: normalize(filters.claimId),
    });
  if (error) {
    // The RPC's own moderator refusal surfaces as the SAME error type the
    // layout guard uses, so a mid-session revocation renders the 403 surface,
    // never a fabricated empty result.
    if (error.message.includes("platform_moderator_required")) {
      throw new PlatformModeratorRequiredError();
    }
    console.error("[admin/place-claim-archive] RPC search failed:", error.message);
    throw new Error("place_claim_archive_search_failed");
  }

  return ((data ?? []) as ArchiveRpcRow[]).map((row) => ({
    id: String(row.id),
    placeId: String(row.place_id),
    userId: String(row.user_id),
    status: String(row.status),
    evidenceFileName: row.evidence_file_name === null ? null : String(row.evidence_file_name),
    note: row.note === null ? null : String(row.note),
    reviewNote: row.review_note === null ? null : String(row.review_note),
    reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
    createdAt: String(row.created_at),
    archivedAt: String(row.archived_at),
  }));
}
