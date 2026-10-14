import "server-only";

import {
  ProducerAuthorizationRequiredError,
  requireAuthenticatedActor,
} from "@/lib/auth/server";
import { resolvePlaceManagerAuthority } from "@/lib/live/operator-authorization";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * A-11 / P6: the producer-scoped Live audit reader.
 *
 * A Pengelola Tempat (ACTIVE owner/manager of the EXACT Place) may read the Live
 * audit trail of that Place and no other. Two independent layers enforce it:
 *  - server: `resolvePlaceManagerAuthority` is re-evaluated on every call, so a
 *    revoked membership loses access immediately and a client-supplied place id
 *    is never trusted on its own;
 *  - database: `list_place_live_audit` (migration 0056) re-checks the same
 *    membership server-side, so the RPC is safe even if called directly.
 *
 * Delegated operators are deliberately NOT readers: the audit of a Place belongs
 * to its Pengelola. `live_audit` keeps NO direct SELECT grant for any client role
 * (MASTER_LIVE_TECH §3); this RPC is the only producer surface.
 */
export type ProducerLiveAuditRow = {
  id: number;
  liveSessionId: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

export async function listProducerLiveAudit(
  request: Request,
  placeId: string,
): Promise<ProducerLiveAuditRow[]> {
  const actor = await requireAuthenticatedActor(request);
  if (!placeId) {
    throw new ProducerAuthorizationRequiredError();
  }

  const supabase = await createSupabaseServerClient();
  const authority = await resolvePlaceManagerAuthority(supabase, actor.userId, placeId);
  if (!authority) {
    throw new ProducerAuthorizationRequiredError();
  }

  const { data, error } = await supabase.rpc("list_place_live_audit", {
    p_place_id: placeId,
  });

  if (error) {
    if (String(error.message).includes("producer_authorization_required")) {
      throw new ProducerAuthorizationRequiredError();
    }
    throw new Error("live_audit_unavailable");
  }

  const rows = (data ?? []) as Array<{
    id: number | string;
    live_session_id: string | null;
    action: string;
    detail: Record<string, unknown> | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: Number(row.id),
    liveSessionId: row.live_session_id,
    action: row.action,
    detail: row.detail ?? {},
    createdAt: row.created_at,
  }));
}
