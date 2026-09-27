import "server-only";

import { PLACE_CLAIM_EVIDENCE_BUCKET } from "@/lib/place-claim";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * PLACE CLAIM EVIDENCE STORAGE — Supabase Storage access for proof of
 * ownership.
 *
 * The bucket (`place-claim-evidence`) is PRIVATE (created by migration 0028
 * with `public = false`) and has NO storage.objects policy, so anon and
 * authenticated clients can neither read nor write any object. Every read is
 * minted HERE, server-side, after the API layer has checked that the caller is
 * either the Producer who filed the claim or a Platform Moderator.
 *
 * There is deliberately no `publicUrlFor` here — the place-media module has one
 * because those photos render publicly with the Place; ownership documents must
 * never be addressable that way. Access is a short-lived signed URL, scoped to
 * one object, handed to an authorized caller only.
 *
 * Object layout: place-claims/<placeId>/<random>.<ext> — the Place id keeps
 * objects addressable per Place for deterministic cleanup; the random suffix
 * keeps the claimant's uploaded file name out of the path.
 */

const PLACE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUFFIX_BYTES = 12;
/** Signed evidence links are short-lived: an Admin reads the file, nothing more. */
export const PLACE_CLAIM_EVIDENCE_URL_TTL_SECONDS = 300;

function fileExtension(fileName: string, mimeType: string): string {
  const guess = fileName.includes(".") ? (fileName.split(".").pop() ?? "") : "";
  const ext = guess.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "pdf") return "pdf";
  if (ext === "png") return "png";
  if (ext === "webp") return "webp";
  if (ext === "avif") return "avif";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/avif") return "avif";
  if (mimeType === "application/pdf") return "pdf";
  throw new Error("place_claim_evidence_type_invalid");
}

function assertPlaceId(placeId: string): string {
  if (!PLACE_ID_PATTERN.test(placeId)) throw new Error("place_input_invalid");
  return placeId;
}

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Display name only — path separators and control characters are stripped. */
function safeDisplayName(fileName: string): string {
  return (fileName ?? "").replace(/[^\w.\- ]+/g, "_").slice(0, 255);
}

export type PlaceClaimEvidenceObject = {
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Upload one proof-of-ownership file into the PRIVATE bucket. The returned
 * `storagePath` is the only reference stored on the claim row.
 */
export async function uploadPlaceClaimEvidence(params: {
  placeId: string;
  file: File;
}): Promise<PlaceClaimEvidenceObject> {
  const placeId = assertPlaceId(params.placeId);
  const ext = fileExtension(params.file.name ?? "", params.file.type);
  const storagePath = `place-claims/${placeId}/${randomSuffix()}.${ext}`;
  const { error } = await createSupabaseServiceClient()
    .storage.from(PLACE_CLAIM_EVIDENCE_BUCKET)
    .upload(storagePath, params.file, {
      contentType: params.file.type,
      // Evidence is personal documentation: never cached by any shared proxy.
      cacheControl: "0",
      upsert: false,
    });
  if (error) {
    if (error.message === "Bucket not found") throw new Error("place_claim_evidence_bucket_missing");
    throw new Error("place_claim_evidence_upload_failed");
  }
  return {
    storagePath,
    fileName: safeDisplayName(params.file.name ?? ""),
    mimeType: params.file.type,
    sizeBytes: params.file.size,
  };
}

/**
 * Best-effort cleanup when the claim itself is refused (e.g. the Place turned
 * out to be owned). A claim row must never be left pointing at an orphaned
 * private object.
 */
export async function removePlaceClaimEvidence(storagePath: string): Promise<void> {
  if (!storagePath) return;
  await createSupabaseServiceClient()
    .storage.from(PLACE_CLAIM_EVIDENCE_BUCKET)
    .remove([storagePath]);
}

/**
 * Short-lived signed URL for ONE evidence object. Callers must have already
 * established that the requester is the claim's owner or a Platform
 * Moderator — this function performs no authorization of its own.
 */
export async function createPlaceClaimEvidenceUrl(storagePath: string): Promise<string> {
  const { data, error } = await createSupabaseServiceClient()
    .storage.from(PLACE_CLAIM_EVIDENCE_BUCKET)
    .createSignedUrl(storagePath, PLACE_CLAIM_EVIDENCE_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) throw new Error("place_claim_evidence_unavailable");
  return data.signedUrl;
}
