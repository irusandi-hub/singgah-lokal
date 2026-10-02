import "server-only";

import { requireCreator, type CreatorActor } from "@/lib/auth/creator";
import { recordPlaceAudit, PlaceAuditError } from "@/lib/admin/place-audit";
import { placeAuditSnapshot, type PlaceAuditSnapshot } from "@/lib/place-audit-format";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import { SupabasePlaceManagementRepository } from "@/lib/place-experience-repository";
import type { Place } from "@/lib/places";
import {
  RIYADH_DUMMY_PLACE_IDS,
  decideDeveloperPlaceMutation,
  developerAuditAction,
  developerFlagColumn,
  developerFlagPatch,
  developerRevertPatch,
  normalizeDeveloperReason,
  type DeveloperPlaceOperation,
  type DeveloperPlaceRefusal,
  type DeveloperPlaceTarget,
} from "./dummy-places-core";

/**
 * DEVELOPER AUTHORITY — Dummy Place (Master Dummy Place v1.0).
 *
 * This is the Creator-controlled technical path and the ONLY writer of
 * `places.is_dummy`. It is deliberately NOT an application feature:
 *
 * - There is NO HTTP route, NO client component and NO client import of this
 *   module. It is reached from Creator-controlled tooling only, which is the
 *   posture Authority Master §3 requires for Creator-tier data authority.
 * - `requireCreator()` gates every entry point and fails closed: an
 *   unauthenticated session, an unconfigured environment, or an email outside
 *   the Creator allowlist is denied before any database call.
 * - It never grants, implies, or checks `platform_moderator`. Authority Master
 *   §4 forbids modelling the Creator as a moderation role, and nothing here
 *   reads or writes `users.platform_role`.
 * - It cannot reach the whole table or the whole Place set. `set_curated` is
 *   scoped to `is_dummy = true` rows; `set_dummy` is the only operation that
 *   can establish that scope, and it still records every change.
 * - Migration 0039's `block_place_is_dummy_update` guard refuses an
 *   `is_dummy` change from every writer except `service_role`, so even a
 *   direct client UPDATE cannot promote a Place to Dummy.
 *
 * AUDIT (Master §5): every mutation writes an append-only `place_audit` row
 * with the Creator's own user id, the action key, the reason, and the
 * before/after snapshot. If the audit write fails the flag change is ROLLED
 * BACK to the value the Place held BEFORE the change — never to the requested
 * value — so a change can never outlive its own audit trail, and a failed
 * revert is reported (`place_rollback_failed`) instead of being assumed.
 */

export class DeveloperPlaceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Developer Place operation failed: ${code}`);
    this.code = code;
  }
}

function refuse(error: DeveloperPlaceRefusal): never {
  throw new DeveloperPlaceError(error);
}

async function loadTarget(placeId: string): Promise<Place | undefined> {
  const repository = new SupabasePlaceManagementRepository(createSupabaseServiceClient());
  return repository.getById(placeId);
}

/**
 * One mutation, in the one order the Master allows: decide → write → audit →
 * (roll back the write if the audit fails).
 *
 * `snapshots` are captured from the SAME loaded Place so `before` and `after`
 * differ only by the field this operation changed.
 */
async function runDeveloperMutation(params: {
  operation: DeveloperPlaceOperation;
  placeId: string;
  desiredValue: boolean;
  reason: unknown;
}): Promise<{ place: Place; action: string }> {
  const actor: CreatorActor = await requireCreator();

  const id = params.placeId.trim();
  if (!id) refuse("place_not_found");

  const place = await loadTarget(id);
  if (!place) refuse("place_not_found");
  // The state read BEFORE any write. It is the single source of truth for both
  // the authorization decision and — if the audit fails — the rollback.
  const target: DeveloperPlaceTarget = {
    id: place.id,
    isDummy: place.isDummy,
    isCurated: place.isCurated,
  };
  const decision = decideDeveloperPlaceMutation({
    operation: params.operation,
    target,
    desiredValue: params.desiredValue,
    reason: params.reason,
  });
  // An idempotent no-op is not an error: it returns the Place and writes
  // nothing, matching the Admin curation path's no-op contract.
  if (!decision.ok && decision.reason !== "no_op") refuse(decision.reason);
  if (!decision.ok) return { place, action: "developer_place_noop" };

  const before = placeAuditSnapshot(place);
  const flagColumn = developerFlagColumn(params.operation);
  const after: PlaceAuditSnapshot = { ...before, [flagColumn]: params.desiredValue };
  const action = developerAuditAction({ operation: params.operation, desiredValue: params.desiredValue });
  const reason = normalizeDeveloperReason(params.reason as string);

  const admin = createSupabaseServiceClient();
  // FORWARD: the requested value. The only patch that may carry `desiredValue`.
  const patch = developerFlagPatch(params.operation, params.desiredValue);
  // REVERT: the ORIGINAL value, derived from the pre-write `target`. It is built
  // here, before the write, so the rollback can never reach back for a value
  // that has already been overwritten.
  const revertPatch = developerRevertPatch(params.operation, target);
  const originalFlagValue = revertPatch[flagColumn];

  const { error } = await admin
    .from("places")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new DeveloperPlaceError("place_unavailable");

  try {
    await recordPlaceAudit({
      placeId: id,
      // The Creator's OWN authenticated user id — never the service role, so
      // the actor is a real, attributable person (Master §5).
      actorId: actor.userId,
      action,
      before,
      after,
      detail: { operation: params.operation, reason, developerAuthority: true },
    });
  } catch (error) {
    // Roll back BEFORE surfacing the failure. Never leave an unattributed or
    // un-audited change behind (Master §3).
    //
    // The revert writes `revertPatch` — the value the Place held BEFORE this
    // change — and NOT `patch`, the requested value. Re-applying the requested
    // value here would leave the row in exactly the state the failed audit
    // refused to record, which is the unattributed change Master §5 forbids.
    // The result is read back and compared against the original value, so a
    // revert that silently failed is reported instead of being assumed.
    let rolledBack = false;
    try {
      const { data: reverted, error: revertError } = await admin
        .from("places")
        .update({ ...revertPatch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("is_dummy, is_curated")
        .maybeSingle();
      rolledBack = !revertError && reverted?.[flagColumn] === originalFlagValue;
    } catch {
      // Best-effort revert; `rolledBack` stays false and is reported below.
    }
    if (!rolledBack) throw new DeveloperPlaceError("place_rollback_failed");
    throw error instanceof PlaceAuditError
      ? new DeveloperPlaceError("place_audit_unavailable")
      : error;
  }

  const reloaded = (await loadTarget(id)) ?? place;
  return { place: reloaded, action };
}

/**
 * Mark or unmark a Place as Dummy (migration 0039 flag).
 *
 * This is the operation that establishes the Dummy scope, so it is not itself
 * restricted to Dummy rows — but it is Creator-only, always audited, and
 * never reachable from a client.
 */
export async function setDeveloperPlaceDummy(params: {
  placeId: string;
  isDummy: boolean;
  reason: string;
}): Promise<{ place: Place; action: string }> {
  return runDeveloperMutation({
    operation: "set_dummy",
    placeId: params.placeId,
    desiredValue: params.isDummy,
    reason: params.reason,
  });
}

/**
 * Promote or unpromote a PLACE AS TEMPAT PILIHAN.
 *
 * Refused with `target_not_dummy` unless the Place is a validated Dummy row —
 * this is the scope limit that stops the Developer Authority from reaching
 * into the real curated layer (Master §4).
 */
export async function setDeveloperPlaceCurated(params: {
  placeId: string;
  curated: boolean;
  reason: string;
}): Promise<{ place: Place; action: string }> {
  return runDeveloperMutation({
    operation: "set_curated",
    placeId: params.placeId,
    desiredValue: params.curated,
    reason: params.reason,
  });
}

/**
 * Creator-gated listing of every Dummy Place. The read half of the same
 * authority — a Platform Admin has no equivalent, because a Dummy Place is
 * test data rather than a moderated object.
 */
export async function listDeveloperDummyPlaces(): Promise<Place[]> {
  await requireCreator();
  const repository = new SupabasePlaceManagementRepository(createSupabaseServiceClient());
  return repository.listDummyPlaces();
}

/**
 * DEV acceptance helper: promote the ten Riyadh Dummy fixtures to Tempat
 * Pilihan through the audited Developer path, one decision per Place.
 *
 * Each Place keeps its own `place_audit` row, so a partial failure leaves the
 * already-promoted Places fully attributable rather than rolling back work
 * that was itself recorded.
 */
export async function markRiyadhDummyPlacesCurated(params: { reason: string }): Promise<
  { placeId: string; action: string }[]
> {
  await requireCreator();
  const results: { placeId: string; action: string }[] = [];
  for (const placeId of RIYADH_DUMMY_PLACE_IDS) {
    const { action } = await setDeveloperPlaceCurated({
      placeId,
      curated: true,
      reason: params.reason,
    });
    results.push({ placeId, action });
  }
  return results;
}