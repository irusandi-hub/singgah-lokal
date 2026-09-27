import "server-only";

import {
  type ClaimablePlace,
  type PlaceClaimStatus,
  type PlaceClaimSummary,
  PlaceClaimError,
  normalizePlaceClaimNote,
  validatePlaceClaimEvidence,
} from "@/lib/place-claim";
import {
  createPlaceClaimEvidenceUrl,
  removePlaceClaimEvidence,
  uploadPlaceClaimEvidence,
} from "@/lib/place-claim-storage";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * PLACE CLAIM SERVICE — server-side orchestration for claiming an existing
 * Place.
 *
 * Everything the claim flow needs lives here, behind the API routes, so the
 * browser can never be trusted for any of it:
 * - the claim list is read through a database function that already excludes
 *   every owned Place (not a UI filter);
 * - submitting uploads the proof to the PRIVATE bucket first, then files the
 *   claim, and deletes the object again if the claim is refused — so a refused
 *   claim never leaves an orphaned private file behind;
 * - reading evidence mints a short-lived signed URL, and only for the claim's
 *   own Producer (or a Platform Moderator, via the admin module below).
 *
 * Ownership is never written here. Only `review_place_claim` (Admin path)
 * grants it.
 */

/** DB refusal → stable API-facing code. */
function mapDbError(error: { message?: string } | null): never {
  const message = error?.message ?? "";
  const known = [
    "place_claim_user_required",
    "place_claim_evidence_required",
    "place_not_found",
    "place_already_owned",
    "place_claim_already_active",
    "place_claim_not_pending",
    "place_claim_decision_invalid",
    "place_claim_producer_identity_unavailable",
  ];
  for (const code of known) {
    if (message.includes(code)) throw new PlaceClaimError(code);
  }
  throw new PlaceClaimError("place_claim_unavailable");
}

type ClaimableRow = {
  place_id: string;
  name: string;
  short_description: string;
  category: string;
  type: string;
  area: string;
  publication_status: string;
};

type UserClaimRow = {
  id: string;
  place_id: string;
  place_name: string;
  category: string;
  type: string;
  status: PlaceClaimStatus;
  evidence_path: string;
  evidence_file_name: string | null;
  created_at: string;
  reviewed_at: string | null;
  review_note: string | null;
};

export type PlaceClaimReviewRow = PlaceClaimSummary & {
  userId: string;
  note: string | null;
  evidencePath: string;
};

/**
 * Places that may be claimed: unowned only. The filter runs in the database
 * (migration 0028) — an owned Place is absent from this list even if the
 * caller calls the API directly.
 */
export async function listClaimablePlaces(): Promise<ClaimablePlace[]> {
  const { data, error } = await createSupabaseServiceClient().rpc("list_claimable_places");
  if (error) mapDbError(error);
  if (!Array.isArray(data)) throw new PlaceClaimError("place_claim_unavailable");
  return (data as ClaimableRow[]).map((row) => ({
    id: String(row.place_id),
    name: String(row.name),
    shortDescription: String(row.short_description),
    category: String(row.category),
    type: String(row.type),
    area: String(row.area),
    publicationStatus: String(row.publication_status),
  }));
}

/**
 * File a claim for an EXISTING Place. `userId` is always the authenticated
 * session's id (never request input). The Place is not created, not edited,
 * and not granted: the RPC files a 'pending' row only.
 */
export async function submitPlaceClaim(params: {
  userId: string;
  placeId: string;
  file: File;
  note?: string | null;
}): Promise<string> {
  if (!params.userId.trim()) throw new PlaceClaimError("place_claim_user_required");
  if (!params.placeId.trim()) throw new PlaceClaimError("place_not_found");
  // Proof of ownership is mandatory — validated BEFORE any upload.
  validatePlaceClaimEvidence(params.file);
  const note = normalizePlaceClaimNote(params.note ?? null);

  const evidence = await uploadPlaceClaimEvidence({ placeId: params.placeId, file: params.file });

  let claimId: unknown;
  try {
    const { data, error } = await createSupabaseServiceClient().rpc("submit_place_claim", {
      p_user_id: params.userId,
      p_place_id: params.placeId,
      p_evidence_path: evidence.storagePath,
      p_evidence_file_name: evidence.fileName,
      p_evidence_mime_type: evidence.mimeType,
      p_evidence_size_bytes: evidence.sizeBytes,
      p_note: note,
    });
    if (error) mapDbError(error);
    claimId = data;
  } catch (error) {
    // No partial state: a refused claim must not leave a private object
    // behind (the claim row and the evidence file live and die together).
    await removePlaceClaimEvidence(evidence.storagePath).catch(() => undefined);
    throw error;
  }

  const id = String(claimId ?? "");
  if (!id) {
    await removePlaceClaimEvidence(evidence.storagePath).catch(() => undefined);
    throw new PlaceClaimError("place_claim_unavailable");
  }
  return id;
}

/** This Producer's own claims (status + their own evidence reference). */
export async function listUserPlaceClaims(userId: string): Promise<PlaceClaimSummary[]> {
  const { data, error } = await createSupabaseServiceClient().rpc("list_user_place_claims", {
    p_user_id: userId,
  });
  if (error) mapDbError(error);
  if (!Array.isArray(data)) throw new PlaceClaimError("place_claim_unavailable");
  return (data as UserClaimRow[]).map((row) => ({
    id: String(row.id),
    placeId: String(row.place_id),
    placeName: String(row.place_name),
    category: String(row.category),
    type: String(row.type),
    status: row.status,
    evidenceFileName: row.evidence_file_name === null ? null : String(row.evidence_file_name),
    createdAt: String(row.created_at),
    reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
    reviewNote: row.review_note === null ? null : String(row.review_note),
  }));
}

type OwnedClaimRow = { evidence_path: string };

/**
 * Signed URL for the caller's OWN claim evidence. Scoped twice: the RPC only
 * ever returns this Producer's rows, and the lookup below re-checks the
 * ownership of the claim id, so another Producer's claim id is simply not
 * found.
 */
export async function createUserPlaceClaimEvidenceUrl(
  userId: string,
  claimId: string,
): Promise<string | null> {
  const { data, error } = await createSupabaseServiceClient()
    .from("place_claims")
    .select("evidence_path")
    .eq("id", claimId)
    .eq("user_id", userId)
    .maybeSingle<OwnedClaimRow>();
  if (error) throw new PlaceClaimError("place_claim_unavailable");
  if (!data?.evidence_path) return null;
  return createPlaceClaimEvidenceUrl(String(data.evidence_path));
}

/** Review queue for the Admin Center (Platform Moderator guard runs upstream). */
export async function listPlaceClaimsForReview(): Promise<PlaceClaimReviewRow[]> {
  const { data, error } = await createSupabaseServiceClient().rpc("list_place_claims_for_review", {
    p_status: null,
  });
  if (error) mapDbError(error);
  if (!Array.isArray(data)) throw new PlaceClaimError("place_claim_unavailable");
  return (data as Array<UserClaimRow & { user_id: string; evidence_path: string; note: string | null }>).map(
    (row) => ({
      id: String(row.id),
      placeId: String(row.place_id),
      placeName: String(row.place_name),
      category: String(row.category),
      type: String(row.type),
      status: row.status,
      evidenceFileName: row.evidence_file_name === null ? null : String(row.evidence_file_name),
      evidencePath: String(row.evidence_path),
      createdAt: String(row.created_at),
      reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
      reviewNote: row.review_note === null ? null : String(row.review_note),
      userId: String(row.user_id),
      note: row.note === null ? null : String(row.note),
    }),
  );
}

/**
 * Admin decision. `approved` is the ONLY path that grants ownership, and it
 * grants it through the existing authorization model (a producer_memberships
 * owner row for the claimant's own user_id). `rejected` grants nothing.
 */
export async function reviewPlaceClaim(params: {
  claimId: string;
  decision: "approved" | "rejected";
  reviewNote?: string | null;
}): Promise<void> {
  if (!params.claimId.trim()) throw new PlaceClaimError("place_claim_not_pending");
  const reviewNote = normalizePlaceClaimNote(params.reviewNote ?? null);
  const { error } = await createSupabaseServiceClient().rpc("review_place_claim", {
    p_claim_id: params.claimId,
    p_decision: params.decision,
    p_review_note: reviewNote,
  });
  if (error) mapDbError(error);
}

type ReviewClaimRow = { evidence_path: string };

/** Signed evidence URL for an Admin reviewing a specific claim. */
export async function createReviewedPlaceClaimEvidenceUrl(claimId: string): Promise<string | null> {
  const { data, error } = await createSupabaseServiceClient()
    .from("place_claims")
    .select("evidence_path")
    .eq("id", claimId)
    .maybeSingle<ReviewClaimRow>();
  if (error) throw new PlaceClaimError("place_claim_unavailable");
  if (!data?.evidence_path) return null;
  return createPlaceClaimEvidenceUrl(String(data.evidence_path));
}
