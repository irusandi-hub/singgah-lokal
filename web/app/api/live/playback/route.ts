import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getLiveInputStatus } from "@/lib/live/cloudflare";
import { admitLiveViewer, getLiveSession, LiveValidationError } from "@/lib/live/session-service";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";

type PlaybackBody = {
  sessionId?: unknown;
};

/**
 * Viewer playback admission (PO items 2, 3, 8; tech §5 amended).
 *
 * Fail-closed gate order:
 * 1. Session must exist, be `live`, and belong to a published Place.
 * 2. Provider stream must be healthy (input connected) — otherwise
 *    `live_stream_unavailable` (PO item 4: no playback without a stream).
 * 3. Admission RPC: verified email + content gate + B1 fail-closed age gate
 *    (DENY while the Phase 2.1 mechanism is absent) + 100-concurrent cap.
 *
 * The WHEP playback URL is issued ONLY in this response, only after every
 * gate passes — never persisted, never exposed before admission. The B1 gate
 * denies everyone today, so no URL can leak before Phase 2.1 by construction.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const body = (await request.json()) as PlaybackBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";

    if (!sessionId) {
      return NextResponse.json({ error: "session_id_required" }, { status: 400 });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
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

    // Admission gate (PO item 8): verified email + content gate + B1 age gate
    // (DENY-all while absent) + 100-concurrent cap. Raises when denied.
    await admitLiveViewer({ sessionId, userId: userData.user.id });

    // Gates passed: issue the WHEP URL for THIS admitted viewer only.
    // Requires `webRTCPlayback.requireSignedURLs` semantics to hold — the
    // input was created with requireSignedURLs; per-viewer token scoping is
    // the Phase 2.1 verification step (B4-adjacent, needs credentials).
    const { getLiveInputPlaybackUrl } = await import("@/lib/live/cloudflare");
    const whepUrl = await getLiveInputPlaybackUrl(session.live_input_id ?? "");
    if (!whepUrl) {
      return NextResponse.json({ error: "live_stream_unavailable" }, { status: 503 });
    }

    return NextResponse.json({ whepUrl });
  } catch (error) {
    if (error instanceof LiveValidationError) {
      const status = error.message === "live_capacity_full" ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "live_playback_unavailable" }, { status: 500 });
  }
}
