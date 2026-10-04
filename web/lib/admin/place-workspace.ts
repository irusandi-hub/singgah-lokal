import "server-only";

import { computeDiscoveryScoreBreakdown, discoveryStarsForScore, evaluateDiscoveryEligibility, rankDiscoveryPlaces } from "@/lib/discovery/scoring";
import { PlaceAuditError, recordPlaceAudit } from "@/lib/admin/place-audit";
import { PLACE_AUDIT_ACTIONS, placeAuditSnapshot, type PlaceAuditAction } from "@/lib/place-audit-format";
import { SupabasePlaceManagementRepository } from "@/lib/place-experience-repository";
import { derivePlaceIdFromName, resolvePlaceMutation, PlaceInputError } from "@/lib/place-management";
import {
  canAdminTransitionPlaceStatus,
  isPlacePublicationReady,
  type Place,
  type PublicationStatus,
} from "@/lib/places";
import { requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import { getPublicPlaceExperienceRepository } from "@/lib/place-experience-repository";

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
 * - `resolvePlaceMutation` (lib/place-management) wraps the ONE Place input
 *   validator and the ONE server-side timezone resolver, and it already
 *   refuses a `producerId` in the payload — so the Admin can never set an
 *   owner by editing fields, and the Place concept stays owned-by-claim only.
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
 * 3. Every write here is recorded in the append-only `place_audit` trail
 *    (migration 0031) against the AUTHENTICATED ADMIN's own user id — never
 *    the service role. The actor comes from the guard's return value, never
 *    from the request. If the entry cannot be written, the Place write is
 *    rolled back, because a change with no attributable trail is exactly what
 *    Master 09 §2/§13 forbids (see lib/admin/place-audit.ts).
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
    case "place_currency_invalid":
      return "Currency hanya menerima IDR, USD, atau SAR.";
    case "place_timezone_unavailable":
      return "Timezone tidak dapat ditentukan dari koordinat. Periksa koneksi koordinat lalu simpan lagi.";
    case "place_timezone_unresolved":
      return "Pilih koordinat Tempat pada peta terlebih dahulu — timezone dihitung otomatis dari koordinat.";
    case "place_cover_image_invalid":
      return "URL cover image tidak valid.";
    case "place_status_invalid":
      return "Status publikasi tidak dikenal.";
    case "place_curated_flag_invalid":
      return "Keputusan Tempat Pilihan tidak valid.";
    case "place_audit_unavailable":
      return "Riwayat tindakan tidak dapat dicatat, jadi perubahan tidak disimpan. Coba lagi.";
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

export type AdminPlaceLiveSessionRow = {
  id: string;
  status: string;
  stageId: string;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  viewerPeak: number;
};

export type AdminPlaceLiveReportRow = {
  id: string;
  category: string;
  note: string | null;
  createdAt: string;
};

export type AdminPlaceDetail = {
  place: Place;
  producerName: string | null;
  memberships: AdminPlaceMembershipRow[];
  claims: AdminPlaceClaimRow[];
  liveSessions: AdminPlaceLiveSessionRow[];
  liveReports: AdminPlaceLiveReportRow[];
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

  const [memberships, claims, experiences, visitIntents, liveSessions, liveSessionCount, meta] = await Promise.all([
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
    admin
      .from("live_sessions")
      .select("id, status, stage_id, started_at, ended_at, ended_reason, viewer_peak")
      .eq("place_id", id)
      .order("started_at", { ascending: false })
      .limit(50),
    admin.from("live_sessions").select("id", { count: "exact", head: true }).eq("place_id", id),
    admin.from("places").select("created_at, updated_at").eq("id", id).maybeSingle(),
  ]);

  for (const result of [memberships, claims, experiences, visitIntents, liveSessions, liveSessionCount, meta]) {
    if (result.error) throw result.error;
  }

  // Live reports belong to a session, and a report is only about a Place
  // through the session it was filed against — so the report read is scoped
  // to THIS Place's sessions. Empty session list means no reports, without a
  // query that would match every report on the platform.
  const sessionIds = (liveSessions.data ?? []).map((row) => String(row.id));
  const liveReports = sessionIds.length
    ? await admin
        .from("live_reports")
        .select("id, category, note, created_at")
        .in("live_session_id", sessionIds)
        .order("created_at", { ascending: false })
        .limit(50)
    : { data: [] as Array<Record<string, unknown>>, error: null };
  if (liveReports.error) throw liveReports.error;

  const producerName = place.producer
    ? ((await admin.from("producers").select("display_name").eq("id", place.producer.id).maybeSingle()).data
        ?.display_name ?? null)
    : null;

  return {
    place,
    producerName: producerName === null ? null : String(producerName),
    liveSessions: (liveSessions.data ?? []).map((row) => ({
      id: String(row.id),
      status: String(row.status),
      stageId: String(row.stage_id),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
      endedReason: row.ended_reason === null ? null : String(row.ended_reason),
      viewerPeak: Number(row.viewer_peak ?? 0),
    })),
    liveReports: (liveReports.data ?? []).map((row) => ({
      id: String(row.id),
      category: String(row.category),
      note: row.note === null ? null : String(row.note),
      createdAt: String(row.created_at),
    })),
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
    liveSessionCount: liveSessionCount.count ?? 0,
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
  const actor = await requirePlatformModerator();

  // The Admin path uses the SAME server-owned timezone rule as the Producer
  // path (PO, 2026-09-28): coordinates are the source of truth, the zone is
  // resolved from them on every save, and a Place without coordinates cannot
  // be created because there is nothing to resolve from and no default would
  // be honest. A client-sent timezone is always discarded.
  let mutation;
  try {
    mutation = await resolvePlaceMutation(raw);
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

  // MASTER 09 §2: the action must be recorded and attributable. If the trail
  // cannot be written the Place must not survive as an unattributed row, so
  // the row created in THIS request is removed again — the same "no partial
  // state" rule `SupabasePlaceManagementRepository.create` already applies
  // when an ownership grant fails. Nothing pre-existing is touched.
  try {
    await recordPlaceAudit({
      placeId: created.id,
      actorId: actor.userId,
      action: PLACE_AUDIT_ACTIONS.created,
      before: null,
      after: placeAuditSnapshot(created),
    });
  } catch (error) {
    await admin.from("places").delete().eq("id", id);
    throw error instanceof PlaceAuditError
      ? new AdminPlaceError("place_audit_unavailable")
      : error;
  }

  return created;
}

/**
 * Edit Place information. Reuses the canonical mutation validator and the
 * canonical repository update, so the Admin cannot write `producer_id`,
 * `claim_status`, or `publication_status` through this path — ownership stays
 * claim-driven and publication stays an explicit moderation act.
 */
export async function updateAdminPlace(placeId: string, raw: unknown): Promise<Place> {
  const actor = await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) throw new AdminPlaceError("place_not_found");

  const repository = adminPlaceRepository();
  const existing = await repository.getById(id);
  if (!existing) throw new AdminPlaceError("place_not_found");

  // Same timezone rule as create: the zone is RECOMPUTED from the (possibly
  // changed) coordinates on every save, so an edit that moves the Place
  // across a zone boundary updates the stored timezone. The existing Place's
  // zone is the fallback only for a legacy row whose coordinates are absent —
  // never a client-supplied value.
  let mutation;
  try {
    mutation = await resolvePlaceMutation(raw, id, { fallbackTimezone: existing.timezone });
  } catch (error) {
    if (error instanceof PlaceInputError) throw new AdminPlaceError(error.message);
    throw error;
  }
  // `update` ignores the id field and writes only the canonical Place
  // columns, so passing the validated mutation straight through is safe.
  const updated = await repository.update(id, mutation);

  try {
    await recordPlaceAudit({
      placeId: id,
      actorId: actor.userId,
      action: PLACE_AUDIT_ACTIONS.updated,
      before: placeAuditSnapshot(existing),
      after: placeAuditSnapshot(updated),
    });
  } catch (error) {
    // Revert to the pre-edit state rather than leave a change with no trail.
    await repository
      .update(id, {
        name: existing.name,
        shortDescription: existing.shortDescription,
        category: existing.category,
        type: existing.type,
        area: existing.area,
        countryCode: existing.countryCode,
        regionName: existing.regionName,
        address: existing.address,
        contactInformation: existing.contactInformation,
        timezone: existing.timezone,
        currency: existing.currency,
        latitude: existing.latitude,
        longitude: existing.longitude,
        coverImageUrl: existing.coverImageUrl,
      })
      .catch(() => undefined);
    throw error instanceof PlaceAuditError
      ? new AdminPlaceError("place_audit_unavailable")
      : error;
  }

  return updated;
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
  const actor = await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) throw new AdminPlaceError("place_not_found");
  if (!ADMIN_PUBLICATION_STATUSES.includes(next as PublicationStatus)) {
    throw new AdminPlaceError("place_status_invalid");
  }
  const nextStatus = next as PublicationStatus;

  const repository = adminPlaceRepository();
  const place = await repository.getById(id);
  if (!place) throw new AdminPlaceError("place_not_found");
  // Re-submitting the status the Place already has is a RETRY, not a
  // moderation decision: nothing changes, so nothing is written and — the
  // part that matters here — nothing is recorded. Without this guard, the
  // "Arsipkan" control on an already-archived Place was labelled a RESTORE
  // (`from === "archived"` matched before the target was considered), so a
  // false entry went into an append-only trail that can never be corrected
  // (Master 09 §13). Returning the Place unchanged also keeps the operation
  // idempotent when a submit is retried (AGENTS.md).
  if (place.publicationStatus === nextStatus) return place;
  if (!canAdminTransitionPlaceStatus(place.publicationStatus, nextStatus)) {
    throw new AdminPlaceError("place_status_transition_invalid");
  }
  if (nextStatus === "published" && !isPlacePublicationReady(place)) {
    throw new AdminPlaceError("place_publication_not_ready");
  }

  const updated = await repository.updatePublicationStatus(id, nextStatus);

  // One audit action per moderation decision, so "restore" is distinguishable
  // from "publish" even though both may land on 'published'.
  try {
    await recordPlaceAudit({
      placeId: id,
      actorId: actor.userId,
      action: moderationAction(place.publicationStatus, nextStatus),
      before: placeAuditSnapshot(place),
      after: placeAuditSnapshot(updated),
      detail: { fromStatus: place.publicationStatus, toStatus: nextStatus },
    });
  } catch (error) {
    await repository.updatePublicationStatus(id, place.publicationStatus).catch(() => undefined);
    throw error instanceof PlaceAuditError
      ? new AdminPlaceError("place_audit_unavailable")
      : error;
  }

  return updated;
}

/**
 * Which moderation action a transition represents. A restore is recorded as a
 * restore even when the target status is 'published', because "bringing an
 * archived Place back" is the decision an operator would want to find later.
 */
function moderationAction(from: PublicationStatus, to: PublicationStatus): PlaceAuditAction {
  // A restore is a Place LEAVING the archive. `to !== "archived"` keeps an
  // archive-on-archive from ever being recorded as a restore, independently of
  // the caller's no-op guard above.
  if (from === "archived" && to !== "archived") return PLACE_AUDIT_ACTIONS.restored;
  if (to === "published") return PLACE_AUDIT_ACTIONS.published;
  if (to === "paused") return PLACE_AUDIT_ACTIONS.paused;
  if (to === "archived") return PLACE_AUDIT_ACTIONS.archived;
  return PLACE_AUDIT_ACTIONS.updated;
}

/**
 * TEMPAT PILIHAN PROMOTION (Stage 4, PO): "Jadikan Tempat Pilihan" /
 * "Cabut Promosi".
 *
 * This is a LAYER decision and nothing else. It is deliberately separate
 * from Discovery — the canonical engine (lib/discovery/scoring.ts) computes
 * eligibility/score/stars from canonical signals and NEVER reads the flag, so
 * promoting or revoking cannot create, remove, or alter any Discovery value.
 * The Admin cannot and must not be able to: change a Discovery score, set
 * stars, force a Place into Discovery, or change publication/claim/ownership
 * through promotion — none of those paths exist in this function.
 *
 * Mechanics (the exact workspace invariants):
 * - `requirePlatformModerator()` is re-verified server-side from the session;
 *   the actor is the guard's return value, never client input.
 * - The flag flips through the service role — the ONLY writer of
 *   `places.is_curated` (migration 0036 refuses the change from any session
 *   role, so a client can never set it through the generic update paths).
 * - Every decision lands in the append-only place_audit trail as
 *   `admin_place_curated` / `admin_place_uncurated` against the ADMIN's own
 *   user id. If the audit write fails, the flag is ROLLED BACK first — a
 *   promotion with no attributable trail is exactly what Master 09 §2/§13
 *   forbids.
 * - No-op retries (same flag value) return the Place unchanged and record
 *   nothing — the same idempotency rule as the publication moderation above.
 */
export async function setAdminPlaceCurated(placeId: string, curated: unknown): Promise<Place> {
  const actor = await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) throw new AdminPlaceError("place_not_found");
  if (typeof curated !== "boolean") {
    throw new AdminPlaceError("place_curated_flag_invalid");
  }

  const repository = adminPlaceRepository();
  const place = await repository.getById(id);
  if (!place) throw new AdminPlaceError("place_not_found");

  // Idempotent no-op: the desired state already holds.
  if (place.isCurated === curated) return place;

  const admin = createSupabaseServiceClient();
  const { error } = await admin
    .from("places")
    .update({ is_curated: curated, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new AdminPlaceError("place_unavailable");

  try {
    await recordPlaceAudit({
      placeId: id,
      actorId: actor.userId,
      action: curated ? PLACE_AUDIT_ACTIONS.curated : PLACE_AUDIT_ACTIONS.uncurated,
      before: placeAuditSnapshot(place),
      after: placeAuditSnapshot({ ...place, isCurated: curated }),
      detail: { isCurated: curated },
    });
  } catch (error) {
    // Rollback BEFORE surfacing the failure: never leave an unattributed
    // promotion behind (same no-partial-state rule as create/update above).
    try {
      await admin
        .from("places")
        .update({ is_curated: place.isCurated, updated_at: new Date().toISOString() })
        .eq("id", id);
    } catch {
      // Best-effort revert; the original audit failure is surfaced regardless.
    }
    throw error instanceof PlaceAuditError
      ? new AdminPlaceError("place_audit_unavailable")
      : error;
  }

  return { ...place, isCurated: curated };
}

/**
 * DISCOVERY VISIBILITY for the Admin workspace (read-only, computed):
 * the canonical engine's current evaluation of ONE Place — the star tier,
 * the rank it currently holds in the platform-wide engine order, and the
 * per-component breakdown that drives it. Every value comes from the engine
 * through the canonical signal assembly; nothing here can be written, and
 * the numeric score never leaves the server.
 */
export type AdminPlaceDiscoveryView = {
  /** The engine's current star tier (contract §4). */
  stars: 1 | 2 | 3 | 4;
  /** Position in the engine's platform-wide ranking, or null when ineligible. */
  rank: number | null;
  /** True when the Place passes the engine's eligibility rules. */
  eligible: boolean;
  breakdown: {
    /** Points earned by having a session live RIGHT NOW (contract L, 40 pts). */
    aktivitas: number;
    /** Points earned by recency decay of the latest session (contract L, 40 pts). */
    freshness: number;
    /** Follower + visit-intent points together (contract F 25 + V 20 = 45 pts). */
    engagement: number;
    /** Published-experience points (first half of contract E, 8 pts). */
    pengalaman: number;
    /** Media-completeness points (second half of contract E, 7 pts). */
    kelengkapan: number;
  };
};

/**
 * Breakdown mapping (Stage 4 PO vocabulary → contract §3 contributions).
 *
 * Every value is a CONTRIBUTION IN POINTS read straight from the engine's
 * `computeDiscoveryScoreBreakdown`, so the five displayed components are
 * exactly the five terms of the locked formula and their sum reconstructs
 * the score. This is NOT a second scoring path and it never invents a
 * component:
 *
 *   aktivitas   40 * liveNow          contract L, live branch
 *   freshness   40 * recency          contract L, decay branch (0 while live)
 *   engagement  25 * F + 20 * V       contract followers + visit intent
 *   pengalaman    8 * min(1, exp/2)    contract E, experiences term
 *   kelengkapan  7 * media            contract E, media term
 *
 * A "relevance" component was removed deliberately: the contract weights no
 * geographic/viewer signal (contract §1 explicitly excludes viewer position),
 * so a coordinates 0/100 proxy contributed nothing to the score while
 * duplicating the `eligible` flag that already reports the coordinate
 * requirement. Publication readiness stays an eligibility gate (E2), not a
 * displayed score component.
 */
export async function getAdminPlaceDiscoveryView(placeId: string): Promise<AdminPlaceDiscoveryView | undefined> {
  await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) return undefined;

  const publicRepository = await getPublicPlaceExperienceRepository();
  const inputs = await publicRepository.listDiscoveryInputs(new Date());
  const input = inputs.find((candidate) => candidate.place.id === id);
  if (!input) return undefined;

  const now = new Date();
  const ranked = rankDiscoveryPlaces(inputs, now);
  const scoreEntry = ranked.find((entry) => entry.placeId === id);
  const contributions = computeDiscoveryScoreBreakdown(input, now);

  return {
    stars: scoreEntry ? discoveryStarsForScore(scoreEntry.score) : 1,
    rank: scoreEntry?.rank ?? null,
    eligible: evaluateDiscoveryEligibility(input.place),
    breakdown: {
      aktivitas: Math.round(contributions.liveActivity),
      freshness: Math.round(contributions.liveRecency),
      engagement: Math.round(contributions.followers + contributions.visitIntent),
      pengalaman: Math.round(contributions.experiences),
      kelengkapan: Math.round(contributions.media),
    },
    // The integer score stays server-side; it is intentionally absent from
    // this view (contract §3: only stars/rank ever reach a client).
  };
}
