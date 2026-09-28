import "server-only";

import { requirePlatformModerator } from "@/lib/live/platform";
import type { PlaceAuditAction, PlaceAuditSnapshot } from "@/lib/place-audit-format";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * PLACE AUDIT — the append-only trail of Platform Admin action on a Place
 * (MASTER 09 §2 "Administrative action must be attributable to an authenticated
 * admin identity and recorded in an audit trail"; §13 actor / action / target /
 * timestamp / result / reason).
 *
 * The table itself is migration 0031. The vocabulary, snapshot, and diff live
 * in the pure lib/place-audit-format module; this file is the only writer and
 * the only reader:
 * - RLS is on with zero policies and the table is revoked from `public`,
 *   `anon` and `authenticated`, so no client — Producer, User, or anonymous —
 *   can reach it. Everything goes through the service role AFTER a fresh
 *   `requirePlatformModerator()` check.
 * - `actor_id` is ALWAYS the authenticated Admin's own `users.id`, passed in
 *   by the caller from the session guard. It is never the service role, never
 *   a client-supplied value, and never a fallback. An unattributable action is
 *   not written at all: `recordPlaceAudit` throws, and the caller rolls the
 *   Place write back rather than leaving a change with no trail.
 * - Only the canonical Place columns are snapshotted. No user email, no
 *   credential, and no infrastructure value is ever written here.
 *
 * Append-only is enforced in the database (0031's `place_audit_block_mutation`
 * trigger refuses UPDATE and DELETE for every writer, service role included),
 * so this module deliberately offers no update and no delete.
 */

export type { PlaceAuditAction, PlaceAuditSnapshot };

export type PlaceAuditRow = {
  id: number;
  placeId: string;
  actorId: string;
  action: PlaceAuditAction;
  before: PlaceAuditSnapshot | null;
  after: PlaceAuditSnapshot | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export class PlaceAuditError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Append one entry. Throws when the entry cannot be written — the caller must
 * NOT swallow this, because a Place change without a trail is the exact
 * failure MASTER 09 §2/§13 exists to prevent.
 */
export async function recordPlaceAudit(params: {
  placeId: string;
  /** The authenticated Admin's own user id. Never the service role. */
  actorId: string;
  action: PlaceAuditAction;
  before?: PlaceAuditSnapshot | null;
  after?: PlaceAuditSnapshot | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const placeId = params.placeId.trim();
  const actorId = params.actorId.trim();
  if (!placeId || !actorId) throw new PlaceAuditError("place_audit_actor_required");

  const { error } = await createSupabaseServiceClient().from("place_audit").insert({
    place_id: placeId,
    actor_id: actorId,
    action: params.action,
    before_data: params.before ?? null,
    after_data: params.after ?? null,
    detail: params.detail ?? {},
  });
  if (error) throw new PlaceAuditError("place_audit_write_failed");
}

/**
 * The Riwayat read for one Place, newest first. Platform Admin only; there is
 * no Producer, User, or public reader of this table.
 */
export async function listPlaceAudit(placeId: string): Promise<PlaceAuditRow[]> {
  await requirePlatformModerator();
  const id = placeId.trim();
  if (!id) return [];

  const { data, error } = await createSupabaseServiceClient()
    .from("place_audit")
    .select("id, actor_id, action, before_data, after_data, detail, created_at")
    .eq("place_id", id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(200);
  if (error) throw new PlaceAuditError("place_audit_read_failed");

  return (data ?? []).map((row) => ({
    id: Number(row.id),
    placeId: id,
    actorId: String(row.actor_id),
    action: String(row.action) as PlaceAuditAction,
    before: (row.before_data ?? null) as PlaceAuditSnapshot | null,
    after: (row.after_data ?? null) as PlaceAuditSnapshot | null,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    createdAt: String(row.created_at),
  }));
}
