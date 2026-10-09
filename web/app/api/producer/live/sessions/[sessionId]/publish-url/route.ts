import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getLiveInputPublishUrl } from "@/lib/live/cloudflare";
import { getLiveSession, LiveValidationError } from "@/lib/live/session-service";
import { canOperateLiveForPlace } from "@/lib/live/operator-authorization";

/**
 * WHIP publish-URL re-issuance (tech §5, PO item 1): the account that operates
 * a live session can re-fetch its secret-bearing WHIP URL (e.g. after a page
 * reload mid-broadcast).
 *
 * Authorization is server-side and derived from the SESSION's own Place —
 * never from a client-supplied place/producer id. Two authorities may operate
 * a Place's Live and neither implies the other:
 *   - the Place's owner/manager (producer_memberships), and
 *   - a delegated Operator Live with an ACTIVE assignment for that EXACT Place.
 * A revoked assignment, a membership of another Place, and an unrelated
 * account all fail closed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 },
      );
    }

    const { sessionId } = await params;
    const session = await getLiveSession(sessionId);

    if (!session || session.status !== "live") {
      return NextResponse.json({ error: "live_session_not_live" }, { status: 400 });
    }

    const allowed = await canOperateLiveForPlace(
      supabase,
      userData.user.id,
      session.place_id,
    );
    if (!allowed) {
      return NextResponse.json(
        { error: "producer_authorization_required" },
        { status: 403 },
      );
    }

    const publishUrl = await getLiveInputPublishUrl(session.live_input_id ?? "");
    if (!publishUrl) {
      // Fail closed: no URL without a working provider boundary (B4).
      return NextResponse.json({ error: "live_boundary_unavailable" }, { status: 503 });
    }

    return NextResponse.json({ publishUrl });
  } catch (error) {
    if (error instanceof LiveValidationError) {
      const status = error.message === "producer_authorization_required" ? 403 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "live_publish_url_unavailable" }, { status: 500 });
  }
}
