import { NextResponse } from "next/server";
import { requireProducerAccess } from "@/lib/auth/server";
import { getLiveInputPublishUrl } from "@/lib/live/cloudflare";
import { getLiveSession, LiveValidationError } from "@/lib/live/session-service";

/**
 * WHIP publish-URL re-issuance (tech §5, PO item 1): the Producer client can
 * re-fetch the secret-bearing WHIP URL for its own live session (e.g. after a
 * page reload mid-broadcast). Authorization is server-side and derived from
 * the authenticated user's memberships — never from a client-supplied
 * producerId. Fail closed: any error ⇒ 4xx without a URL.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    const session = await getLiveSession(sessionId);

    if (!session || session.status !== "live") {
      return NextResponse.json({ error: "live_session_not_live" }, { status: 400 });
    }

    // Producer must be owner/manager of the broadcasting Place — server-side
    // check against memberships, not client input.
    await requireProducerAccess(_request, session.place_id, ["owner", "manager"]);

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
