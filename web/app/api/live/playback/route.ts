import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getLiveInputStatus } from "@/lib/live/cloudflare";
import { signPlaybackToken } from "@/lib/live/stream-token";
import { admitLiveViewer, getLiveSession, LiveValidationError } from "@/lib/live/session-service";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";

type PlaybackBody = {
  sessionId?: unknown;
};

/**
 * Viewer playback admission (tech §5 amended, Phase 5).
 *
 * Fail-closed gate order:
 * 1. Session must exist, be `live`, and belong to a published Place.
 * 2. Provider stream must be healthy (input connected) — otherwise
 *    `live_stream_unavailable`.
 * 3. Admission RPC: verified email + content gate + B1 fail-closed age gate
 *    (DENY while the Phase 2.1 mechanism is absent) + 100-concurrent cap.
 * 4. Sign a short-lived RS256 playback token (signing-key mechanism — the
 *    provider /token endpoint does not support Live WebRTC). Failure to sign
 *    ⇒ denial; an unsigned/raw WHEP URL is NEVER returned.
 *
 * The client builds the WHEP URL itself by replacing the input UID position
 * with the token (token-in-place-of-id, provider-documented). The token is
 * minted only after every gate passes and expires in seconds.
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

    // Stream health gate: unknown status fails closed.
    const health = session.live_input_id ? await getLiveInputStatus(session.live_input_id) : null;
    if (!health || !health.connected) {
      return NextResponse.json({ error: "live_stream_unavailable" }, { status: 503 });
    }

    // Admission gate: verified email + content gate + B1 age gate
    // (DENY-all while absent) + 100-concurrent cap. Raises when denied.
    await admitLiveViewer({ sessionId, userId: userData.user.id });

    // Gates passed: sign a short-lived token (never expose the raw WHEP URL).
    const token = await signPlaybackToken(session.live_input_id ?? "");
    if (!token) {
      // Fail closed: without a configured signing key (or on crypto failure)
      // playback is denied — no unsigned URL is ever issued.
      return NextResponse.json({ error: "live_playback_unavailable" }, { status: 503 });
    }

    return NextResponse.json({ token, ttlSeconds: 60 });
  } catch (error) {
    if (error instanceof LiveValidationError) {
      const status = error.message === "live_capacity_full" ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "live_playback_unavailable" }, { status: 500 });
  }
}
