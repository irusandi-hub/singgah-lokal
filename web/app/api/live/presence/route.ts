import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { LiveValidationError, touchLiveViewerPresence } from "@/lib/live/session-service";

type PresenceBody = {
  sessionId?: unknown;
};

/**
 * Viewer presence heartbeat (A-04, migration 0053).
 *
 * The 100-concurrent cap counts ACTIVE PRESENCE (tech §6: "admission gate
 * counts active presence, not live_viewers ledger rows"), with a server-side
 * lease that expires inside the TUNABLE 5-minute grace window. The viewer calls
 * this while it is watching, so a viewer that stays longer than the grace
 * window keeps counting (and keeps its private-channel access) — the defect the
 * audit recorded as A-04.
 *
 * Fail-closed order: authentication (401) → session must still be live (400) →
 * the caller must ALREADY hold an admitted ledger row for this session (403).
 * The server derives the actor from the session cookie; no user id is accepted
 * from the client, and this route can never admit a new viewer.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as PresenceBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) {
      return NextResponse.json({ error: "session_id_required" }, { status: 400 });
    }

    await touchLiveViewerPresence({ sessionId });
    return NextResponse.json({ present: true });
  } catch (error) {
    if (error instanceof LiveValidationError) {
      if (error.message === "live_session_not_live") {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      if (error.message === "live_viewer_denied") {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "live_presence_unavailable" }, { status: 503 });
  }
}
