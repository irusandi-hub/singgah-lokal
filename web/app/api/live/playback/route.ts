import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getLiveInputStatus } from "@/lib/live/cloudflare";
import { admitLiveViewer, getLiveSession, LiveValidationError } from "@/lib/live/session-service";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";

type PlaybackBody = {
  sessionId?: unknown;
};

/**
 * Viewer playback admission (PO items 2, 3, 8; tech §5/§7).
 *
 * Fail-closed gate order:
 * 1. Session must exist, be `live`, and belong to a published Place.
 * 2. Provider stream must be healthy (input connected) — otherwise
 *    `live_stream_unavailable` (PO item 4: no playback without a stream).
 * 3. Viewer admission RPC: verified email + B1 fail-closed age gate (DENY
 *    while the Phase 2.1 mechanism is absent) + 100-concurrent cap.
 *
 * The WHEP playback URL is issued ONLY after every gate passes — never
 * persisted, never exposed before admission.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as PlaybackBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

    if (!sessionId) {
      return NextResponse.json({ error: "session_id_required" }, { status: 400 });
    }

    const session = await getLiveSession(sessionId);
    if (!session || session.status !== "live") {
      return NextResponse.json({ error: "live_session_not_live" }, { status: 400 });
    }

    // Published Place only (fail-closed visibility, same as viewer page).
    const place = await (await getServerPlaceExperienceRepository()).getPublishedPlaceById(session.place_id);
    if (!place) {
      return NextResponse.json({ error: "live_session_not_live" }, { status: 400 });
    }

    // Stream health gate (PO item 4): unknown status fails closed.
    const health = session.live_input_id ? await getLiveInputStatus(session.live_input_id) : null;
    if (!health || !health.connected) {
      return NextResponse.json({ error: "live_stream_unavailable" }, { status: 503 });
    }

    // Admission gate: verified email + B1 age gate (DENY-all while absent) +
    // 100-concurrent cap (PO item 8). Raises LiveValidationError when denied.
    await admitLiveViewer({ sessionId, userId: (await requireUser()).id });

    return NextResponse.json({ admitted: true });
  } catch (error) {
    if (error instanceof LiveValidationError) {
      const status = error.message === "live_capacity_full" ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "live_playback_unavailable" }, { status: 500 });
  }
}

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new LiveValidationError("authentication_required");
  }
  return data.user;
}
