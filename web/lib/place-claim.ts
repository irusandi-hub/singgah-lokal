/**
 * PLACE CLAIM — the claim contract for claiming an EXISTING Place.
 *
 * Mirrors the place-media split (lib/place-media.ts holds the limits, the
 * storage module holds the access): this module owns the proof-of-ownership
 * contract, so the Producer form and the server validate the SAME rules and
 * the client can never widen them.
 *
 * Locked rules encoded here:
 * - Claiming never creates or edits a Place. There is no category/type field
 *   in this contract on purpose: the canonical Place decides both.
 * - Proof of ownership is REQUIRED. `place_claim_evidence_required` is a real
 *   rejection path, not a soft warning.
 * - The file is stored in a PRIVATE Supabase Storage bucket and is never
 *   addressed by a public URL. Only the storage reference is kept.
 */

export const PLACE_CLAIM_EVIDENCE_BUCKET = "place-claim-evidence";

/** Server-side upload limit (fail-closed; mirrored in the Producer form). */
export const PLACE_CLAIM_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export const PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "application/pdf",
] as const;

export type PlaceClaimStatus = "pending" | "approved" | "rejected";

export type ClaimablePlace = {
  id: string;
  name: string;
  shortDescription: string;
  category: string;
  type: string;
  area: string;
  publicationStatus: string;
};

export type PlaceClaimSummary = {
  id: string;
  placeId: string;
  placeName: string;
  category: string;
  type: string;
  status: PlaceClaimStatus;
  /** Private storage reference. Never rendered as a URL. */
  evidenceFileName: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
};

export class PlaceClaimError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** HTTP status for a claim refusal, shared by the Producer and Admin APIs. */
export function placeClaimErrorStatus(code: string): number {
  // A Place that already has an owner, a second active claim, and a review of
  // a non-pending claim are all state conflicts, not malformed input.
  if (code === "place_already_owned" || code === "place_claim_already_active" || code === "place_claim_not_pending") {
    return 409;
  }
  return 400;
}

/** Operator-facing message for a claim refusal (no internal detail leaked). */
export function placeClaimErrorMessage(code: string): string {
  switch (code) {
    case "place_claim_evidence_required":
      return "Bukti kepemilikan wajib diunggah.";
    case "place_claim_evidence_type_invalid":
      return "Format bukti tidak didukung. Gunakan JPG, PNG, WebP, AVIF, atau PDF.";
    case "place_claim_evidence_size_invalid":
      return "Ukuran bukti melebihi batas 5 MB.";
    case "place_claim_evidence_file_required":
      return "Bukti kepemilikan wajib diunggah.";
    case "place_already_owned":
      return "Place ini sudah memiliki pemilik dan tidak dapat diklaim.";
    case "place_claim_already_active":
      return "Kamu sudah memiliki klaim yang sedang diproses.";
    case "place_claim_not_pending":
      return "Klaim ini sudah diproses.";
    case "place_claim_producer_identity_unavailable":
      return "Identitas Producer belum tersedia untuk Place ini.";
    case "place_not_found":
      return "Place tidak ditemukan.";
    case "place_claim_note_invalid":
      return "Catatan terlalu panjang.";
    default:
      return "Klaim gagal diproses. Coba lagi.";
  }
}

/** File-type + size gate for the proof of ownership (server-side). */
export function validatePlaceClaimEvidence(file: { type?: unknown; size?: unknown }): void {
  if (
    typeof file.type !== "string" ||
    !(PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES as readonly string[]).includes(file.type)
  ) {
    throw new PlaceClaimError("place_claim_evidence_type_invalid");
  }
  if (
    typeof file.size !== "number" ||
    !Number.isFinite(file.size) ||
    file.size <= 0 ||
    file.size > PLACE_CLAIM_EVIDENCE_MAX_BYTES
  ) {
    throw new PlaceClaimError("place_claim_evidence_size_invalid");
  }
}

/** Bounded, optional free text (Producer note / Admin review note). */
export function normalizePlaceClaimNote(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new PlaceClaimError("place_claim_note_invalid");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 1000) throw new PlaceClaimError("place_claim_note_invalid");
  return trimmed;
}
