import { NextResponse } from "next/server";
import {
  AuthenticationRequiredError,
  ProducerAuthorizationRequiredError,
} from "@/lib/auth/server";
import { listProducerLiveAudit } from "@/lib/live/audit-read";

export const dynamic = "force-dynamic";

/**
 * A-11 / P6: read the Live audit trail of ONE Place the caller manages.
 *
 * The place id comes from the request but is never trusted alone: the service
 * re-resolves the caller's ACTIVE owner/manager membership on every call and the
 * RPC re-checks it in the database. Delegated operators and every other account
 * are refused; there is no cross-tenant read and no anon surface.
 */
export async function GET(request: Request) {
  try {
    const placeId = new URL(request.url).searchParams.get("placeId")?.trim() ?? "";
    if (!placeId) {
      return NextResponse.json({ error: "place_id_required" }, { status: 400 });
    }

    const rows = await listProducerLiveAudit(request, placeId);
    return NextResponse.json({ audit: rows });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    return NextResponse.json({ error: "live_audit_unavailable" }, { status: 500 });
  }
}
