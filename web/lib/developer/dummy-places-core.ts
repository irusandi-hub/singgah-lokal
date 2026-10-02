/**
 * Dummy Place / Developer Authority — the PURE half, kept free of
 * "server-only" so the authorization rules can be executed directly by the
 * unit tests. The server-only boundary module (`dummy-places.ts`) wraps this
 * and owns the database writes; production callers must import from
 * `dummy-places.ts`, never from here.
 *
 * These rules are deliberately small and total: the set of things the
 * Developer Authority may do is closed, and each rule below is a pure
 * function so it can be proven rather than asserted.
 *
 * Master: MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0.
 */

/**
 * The ten Riyadh DEV fixtures seeded by migration 0040.
 *
 * Kept in the PURE module so the dataset contract is executable by the tests
 * without importing the server-only boundary, and so the acceptance helper and
 * the migration cannot drift apart silently.
 */
export const RIYADH_DUMMY_PLACE_IDS = [
  "dummy-riyadh-olaya",
  "dummy-riyadh-king-fahd",
  "dummy-riyadh-malaz",
  "dummy-riyadh-nakheel",
  "dummy-riyadh-kafd",
  "dummy-riyadh-yasmin",
  "dummy-riyadh-sulaymaniyah",
  "dummy-riyadh-umm-al-hamam",
  "dummy-riyadh-al-izza",
  "dummy-riyadh-tahlia",
] as const;

/** The ONLY operations the Developer Authority is permitted to perform. */
export const DEVELOPER_PLACE_OPERATIONS = ["set_dummy", "set_curated"] as const;
export type DeveloperPlaceOperation = (typeof DEVELOPER_PLACE_OPERATIONS)[number];

/**
 * Audit action keys, appended to 0031's vocabulary by migration 0039. They are
 * deliberately DISTINCT from the `admin_place_curated` / `admin_place_uncurated`
 * keys, so the trail always records whether a decision came from the Developer
 * Authority or from a Platform Admin — never an ambiguous blend of the two.
 */
export const DEVELOPER_PLACE_AUDIT_ACTIONS = {
  dummy_marked: "developer_place_dummy_marked",
  dummy_cleared: "developer_place_dummy_cleared",
  curated: "developer_place_curated",
  uncurated: "developer_place_uncurated",
} as const;

/** Result codes — the closed set of ways an operation may be refused. */
export const DEVELOPER_PLACE_REFUSALS = {
  place_not_found: "place_not_found",
  operation_not_permitted: "operation_not_permitted",
  target_not_dummy: "target_not_dummy",
  reason_required: "reason_required",
  no_op: "no_op",
} as const;

export type DeveloperPlaceRefusal = (typeof DEVELOPER_PLACE_REFUSALS)[keyof typeof DEVELOPER_PLACE_REFUSALS];

export type DeveloperPlaceDecision =
  | { ok: true }
  | { ok: false; reason: DeveloperPlaceRefusal };

/** The minimum a target must expose for a decision to be made. */
export type DeveloperAuditAction =
  | "developer_place_dummy_marked"
  | "developer_place_dummy_cleared"
  | "developer_place_curated"
  | "developer_place_uncurated";

export type DeveloperPlaceTarget = {
  id: string;
  isDummy: boolean;
  isCurated: boolean;
};

const ok: DeveloperPlaceDecision = { ok: true };
const refuse = (reason: DeveloperPlaceRefusal): DeveloperPlaceDecision => ({ ok: false, reason });

/** Longest reason recorded in the audit trail; longer input is refused, not truncated. */
export const MAX_DEVELOPER_REASON_LENGTH = 500;

/**
 * Is the requested operation one the Developer Authority may perform at all?
 *
 * This is a CLOSED allowlist over a value the caller supplies internally. It is
 * never derived from client input: the boundary module passes a literal
 * operation constant, and anything outside the list is refused before a
 * database call is made.
 */
export function isPermittedOperation(operation: unknown): operation is DeveloperPlaceOperation {
  return (
    typeof operation === "string" &&
    (DEVELOPER_PLACE_OPERATIONS as readonly string[]).includes(operation)
  );
}

/**
 * A reason is mandatory for every Developer Authority change.
 *
 * Master §5: every change records actor, reason, target and the before/after
 * state. Without a reason the audit row would be incomplete, so the operation
 * is refused rather than written with a blank reason. A blank/whitespace-only
 * or over-long reason is refused — never silently trimmed or truncated into
 * something that reads differently from what was asked for.
 */
export function isValidDeveloperReason(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  const trimmed = reason.trim();
  if (!trimmed) return false;
  return trimmed.length <= MAX_DEVELOPER_REASON_LENGTH;
}

/**
 * Marking or unmarking Dummy is the operation that establishes the flag
 * itself, so it is allowed against ANY Place the Creator can see — the flag is
 * how a Place becomes a valid target in the first place.
 *
 * The guard that matters is `isDummy`, and it applies to the SECOND operation
 * (Tempat Pilihan promotion), where allowing a non-Dummy Place would let the
 * Developer Authority reach into the real curated layer.
 */
export function canDeveloperMutateTarget(input: {
  operation: DeveloperPlaceOperation;
  target: DeveloperPlaceTarget | null;
}): DeveloperPlaceDecision {
  if (!isPermittedOperation(input.operation)) return refuse(DEVELOPER_PLACE_REFUSALS.operation_not_permitted);
  if (!input.target) return refuse(DEVELOPER_PLACE_REFUSALS.place_not_found);
  // §4 SCOPE LIMIT: curation authority exists ONLY over validated Dummy data.
  if (input.operation === "set_curated" && !input.target.isDummy) {
    return refuse(DEVELOPER_PLACE_REFUSALS.target_not_dummy);
  }
  return ok;
}

/**
 * Full pre-flight decision for one Developer Authority mutation.
 *
 * Order matters and is part of the contract: identity/operation → existence →
 * Dummy scope → reason → idempotent no-op. Refusing an out-of-scope target
 * BEFORE looking at the reason keeps the refusal reason itself from becoming a
 * way to probe which Places exist.
 */
export function decideDeveloperPlaceMutation(input: {
  operation: DeveloperPlaceOperation;
  target: DeveloperPlaceTarget | null;
  desiredValue: unknown;
  reason: unknown;
}): DeveloperPlaceDecision {
  const scope = canDeveloperMutateTarget(input);
  if (!scope.ok) return scope;
  if (typeof input.desiredValue !== "boolean") {
    return refuse(DEVELOPER_PLACE_REFUSALS.operation_not_permitted);
  }
  if (!isValidDeveloperReason(input.reason)) return refuse(DEVELOPER_PLACE_REFUSALS.reason_required);
  // Idempotency (AGENTS.md): a no-op change writes nothing and records nothing.
  const current = input.operation === "set_dummy" ? input.target!.isDummy : input.target!.isCurated;
  if (current === input.desiredValue) return refuse(DEVELOPER_PLACE_REFUSALS.no_op);
  return ok;
}

/**
 * The audit action key for a decision — never derived from client input.
 * Returned as the canonical `PlaceAuditAction` union so the audit vocabulary
 * stays closed: an operation that is not in `DEVELOPER_PLACE_OPERATIONS` cannot
 * produce a key the `place_audit` CHECK would reject.
 */
export function developerAuditAction(input: {
  operation: DeveloperPlaceOperation;
  desiredValue: boolean;
}): DeveloperAuditAction {
  if (input.operation === "set_dummy") {
    return input.desiredValue
      ? DEVELOPER_PLACE_AUDIT_ACTIONS.dummy_marked
      : DEVELOPER_PLACE_AUDIT_ACTIONS.dummy_cleared;
  }
  return input.desiredValue
    ? DEVELOPER_PLACE_AUDIT_ACTIONS.curated
    : DEVELOPER_PLACE_AUDIT_ACTIONS.uncurated;
}

/**
 * The normalized reason actually written to the audit trail — trimmed, so the
 * stored text is what was validated (and length-checked) above.
 */
export function normalizeDeveloperReason(reason: string): string {
  return reason.trim();
}