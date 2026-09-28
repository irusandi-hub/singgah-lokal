import "server-only";

import { SupabasePlaceManagementRepository } from "@/lib/place-experience-repository";
import { derivePlaceIdFromName, parsePlaceMutation, PlaceInputError } from "@/lib/place-management";
import {
  canAdminTransitionPlaceStatus,
  isPlacePublicationReady,
  type Place,
  type PublicationStatus,
} from "@/lib/places";
import { requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * ADMIN PLACE WORKSPACE — Platform Admin operational authority over Place
 * (Authority Master §5: Admin has operational authority over Place, and
 * over moderation/enforcement).
 *
 * Audit notes that shaped this module — nothing here is a re-implementation:
 * - `places.producer_id` is ALREADY nullable (migration 0001: `producer_id
 *   text references public.producers(id)`), so an Admin-created Place without
 *   a Producer needs no schema change.
 * - Ownership is defined ONCE in the database as `place_has_active_ownership`
 *   (migration 0028: a producer_memberships row OR a non-null producer_id).
 *   An Admin-created Place satisfies neither, so it is claimable through the
 *   EXISTING claim system with no extra wiring.
 * - The claim flow (place_claims + `submit_place_claim` / `review_place_claim`)
 *   never creates or edits a Place. This module therefore has no claim path at
 *   all: reviewing a claim stays entirely inside /api/admin/place-claims.
 * - `parsePlaceMutation` (lib/place-management) is the ONE Place input
 *   validator, and it already refuses a `producerId` in the payload — so the
 *   Admin can never set an owner by editing fields, and the Place concept
 *   stays owned-by-claim only.
 * - `SupabasePlaceManagementRepository` (lib/place-experience-repository)
 *   remains the canonical read/update mapping; it is reused, not rebuilt.
 *
 * Two invariants this module enforces beyond the shared library:
 * 1. NO hard delete. A Place can hold Experience, Visit Intent, claim,
 *    membership, Live, and history; removal is never an admin operation
 *    (Master 09 §8/§15: preserve state transitions, keep historical
 *    integrity). There is deliberately no delete function here.
 * 2. Every function re-verifies `requirePlatformModerator()` server-side
 *    from the session — never from client input (Master 09 §3: "Role
 *    permissions must be enforced server-side. UI-level access hiding is not
 *    sufficient.").
 */

export const ADMIN_PUBLICATION_STATUSES: readonly PublicationStatus[] = [
  "draft",
  "published",
  "paused",
  "archived",
];

/** Stable API-facing error codes for the Admin Place workspace. */
export class AdminPlaceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export function adminPlaceErrorStatus(code: string): number {
  if (code === "place_not_found") return 404;
  if (code === "place_id_taken") return 409;
  return 400;
}

/** Operator-facing message; never leaks an internal detail. */
export function adminPlaceErrorMessage(code: string): string {
  switch (code) {
    case "place_not_found":
      return "Tempat tidak ditemukan.";
    case "place_id_taken":
      return "Tempat dengan nama itu sudah ada. Gunakan nama lain.";
    case "place_status_transition_invalid":
      return "Perubahan status tidak diizinkan dari status saat ini.";
    case "place_publication_not_ready":
      return "Lengkapi alamat dan koordinat sebelum menerbitkan.";
    case "place_input_invalid":
      return "Data Tempat tidak valid.";
    case "place_required_field_invalid":
      return "Lengkapi semua kolom wajib.";
    case "place_type_or_category_invalid":
      return "Kategori atau tipe Tempat tidak valid.";
    case "place_coordinates_invalid":
      return "Koordinat tidak valid.";
    case "place_cover_image_invalid":
      return "URL cover image tidak valid.";
    case "place_status_invalid":
      return "Status publikasi tidak dikenal.";
    case "place_unavailable":
      return "Tempat tidak dapat diproses. Coba lagi.";
    default:
      return "Tempat tidak dapat diproses. Coba lagi.";
  }
}

export type AdminPlaceClaimRow = {
  id: string;
  userId: string;
  status: string;
  note: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

export type AdminPlaceMembershipRow = {
  userId: string;
  producerId: string;
  role: string;
  createdAt: string;
};

export type AdminPlaceDetail = {
  place: Place;
  producerName: string | null;
  memberships: AdminPlaceMembershipRow[];
  claims: AdminPlaceClaimRow[];
  experienceCount: number;
  visitIntentCount: number;
  liveSessionCount: number;
  createdAt: string;
  updatedAt: string;
};

function adminPlaceRepository() {
  return new SupabasePlaceManagementRepository(createSupabaseServiceClient());
}

/**
 * Full Admin workspace view for one Place. Returns undefined when the Place
 * does not exist. Includes the claim history for the Place so the Admin can
 * see, on one screen, that ownership came (or did not come) from a claim.
 */
export async function getAdminPlaceDetail(placeId: string): Promise<AdminPlaceDetail | undefined> {
  await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) return undefined;

  const admin = createSupabaseServiceClient();
  const repository = adminPlaceRepository();
  const place = await repository.getById(id);
  if (!place) return undefined;

  const [memberships, claims, experiences, visitIntents, liveSessions, meta] = await Promise.all([
    admin
      .from("producer_memberships")
      .select("user_id, producer_id, role, created_at")
      .eq("place_id", id)
      .order("created_at", { ascending: true }),
    admin
      .from("place_claims")
      .select("id, user_id, status, note, review_note, created_at, reviewed_at")
      .eq("place_id", id)
      .order("created_at", { ascending: false }),
    admin.from("experiences").select("id", { count: "exact", head: true }).eq("place_id", id),
    admin.from("visit_intents").select("id", { count: "exact", head: true }).eq("place_id", id),
    admin.from("live_sessions").select("id", { count: "exact", head: true }).eq("place_id", id),
    admin.from("places").select("created_at, updated_at").eq("id", id).maybeSingle(),
  ]);

  for (const result of [memberships, claims, experiences, visitIntents, liveSessions, meta]) {
    if (result.error) throw result.error;
  }

  const producerName = place.producer
    ? ((await admin.from("producers").select("display_name").eq("id", place.producer.id).maybeSingle()).data
        ?.display_name ?? null)
    : null;

  return {
    place,
    producerName: producerName === null ? null : String(producerName),
    memberships: (memberships.data ?? []).map((row) => ({
      userId: String(row.user_id),
      producerId: String(row.producer_id),
      role: String(row.role),
      createdAt: String(row.created_at),
    })),
    claims: (claims.data ?? []).map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      status: String(row.status),
      note: row.note === null ? null : String(row.note),
      reviewNote: row.review_note === null ? null : String(row.review_note),
      createdAt: String(row.created_at),
      reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at),
    })),
    experienceCount: experiences.count ?? 0,
    visitIntentCount: visitIntents.count ?? 0,
    liveSessionCount: liveSessions.count ?? 0,
    createdAt: String(meta.data?.created_at ?? ""),
    updatedAt: String(meta.data?.updated_at ?? ""),
  };
}

/**
 * Create a Place WITHOUT a Producer.
 *
 * `producer_id` is written as NULL and `claim_status` as the canonical
 * 'unverified' — a Place the Admin enters into the world, which the rightful
 * owner can later claim through the existing claim flow. `publication_status`
 * starts at 'draft': publication is a separate, explicit moderation act.
 *
 * This function is the ONLY Place-creating path in the Admin area. It is never
 * called from the claim review path: approving a claim grants ownership on an
 * existing Place and must never mint a second Place.
 */
export async function createAdminPlace(raw: unknown): Promise<Place> {
  await requirePlatformModerator();

  let mutation;
  try {
    mutation = parsePlaceMutation(raw);
  } catch (error) {
    if (error instanceof PlaceInputError) throw new AdminPlaceError(error.message);
    throw error;
  }

  const repository = adminPlaceRepository();
  const admin = createSupabaseServiceClient();

  // Same system-generated id rule the Producer path uses (PO, 2026-09-26):
  // a latin slug of the name, a random fallback for non-latin names, and a
  // uniqueness check so the UI never shows a half-created Place.
  let id = mutation.id;
  if (!id) {
    const base = derivePlaceIdFromName(mutation.name);
    id = base || `place-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    if (await repository.getById(id)) throw new AdminPlaceError("place_id_taken");
  }

  const { error: insertError } = await admin.from("places").insert({
    id,
    name: mutation.name,
    short_description: mutation.shortDescription,
    category: mutation.category,
    type: mutation.type,
    area: mutation.area,
    address: mutation.address,
    contact_information: mutation.contactInformation,
    timezone: mutation.timezone,
    currency: mutation.currency,
    latitude: mutation.latitude,
    longitude: mutation.longitude,
    cover_image_url: mutation.coverImageUrl,
    producer_id: null,
    claim_status: "unverified",
    publication_status: "draft",
  });
  if (insertError) {
    if (insertError.code === "23505") throw new AdminPlaceError("place_id_taken");
    throw new AdminPlaceError("place_unavailable");
  }

  const created = await repository.getById(id);
  if (!created) throw new AdminPlaceError("place_unavailable");
  return created;
}

/**
 * Edit Place information. Reuses the canonical mutation validator and the
 * canonical repository update, so the Admin cannot write `producer_id`,
 * `claim_status`, or `publication_status` through this path — ownership stays
 * claim-driven and publication stays an explicit moderation act.
 */
export async function updateAdminPlace(placeId: string, raw: unknown): Promise<Place> {
  await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) throw new AdminPlaceError("place_not_found");

  const repository = adminPlaceRepository();
  const existing = await repository.getById(id);
  if (!existing) throw new AdminPlaceError("place_not_found");

  let mutation;
  try {
    mutation = parsePlaceMutation(raw, id);
  } catch (error) {
    if (error instanceof PlaceInputError) throw new AdminPlaceError(error.message);
    throw error;
  }
  // `update` ignores the id field and writes only the canonical Place
  // columns, so passing the validated mutation straight through is safe.
  return repository.update(id, mutation);
}

/**
 * Moderation: Terbitkan / Jeda / Arsipkan / Pulihkan dari arsip.
 *
 * Uses the existing status set (draft / published / paused / archived) and the
 * shared transition + readiness rules from lib/places — `canAdminTransitionPlaceStatus`
 * (restore from archive, per Master 09 §5/§8) and `isPlacePublicationReady`
 * (revalidation before anything becomes public). A Place can only be published
 * when its canonical data is complete. There is no delete: archiving is the
 * removal path, and the row plus its Experience, Visit Intent, claim,
 * membership, Live, and history stay intact.
 */
export async function setAdminPlacePublicationStatus(
  placeId: string,
  next: unknown,
): Promise<Place> {
  await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) throw new AdminPlaceError("place_not_found");
  if (!ADMIN_PUBLICATION_STATUSES.includes(next as PublicationStatus)) {
    throw new AdminPlaceError("place_status_invalid");
  }
  const nextStatus = next as PublicationStatus;

  const repository = adminPlaceRepository();
  const place = await repository.getById(id);
  if (!place) throw new AdminPlaceError("place_not_found");
  if (!canAdminTransitionPlaceStatus(place.publicationStatus, nextStatus)) {
    throw new AdminPlaceError("place_status_transition_invalid");
  }
  if (nextStatus === "published" && !isPlacePublicationReady(place)) {
    throw new AdminPlaceError("place_publication_not_ready");
  }
  return repository.updatePublicationStatus(id, nextStatus);
}
