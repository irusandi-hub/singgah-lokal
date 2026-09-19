import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { admitLiveViewer, getLiveSession, postLiveComment } from "@/lib/live/session-service";
import { LiveValidationError } from "@/lib/live/session-service";
import { nextLiveCommentSequence } from "@/lib/live/sequence";

type CommentBody = {
  sessionId?: unknown;
  body?: unknown;
};

function errorResponse(error: unknown) {
  if (error instanceof LiveValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ error: "live_comments_unavailable" }, { status: 500 });
}

// Admit an eligible viewer to a live session's channel (fail closed; B1 keeps
// this denied for everyone until the verified-age mechanism lands in Phase 2.1).
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = (await request.json()) as CommentBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const comment = typeof body.body === "string" ? body.body : "";

    if (!sessionId) {
      return NextResponse.json({ error: "session_id_required" }, { status: 400 });
    }

    const session = await getLiveSession(sessionId);
    if (!session || session.status !== "live") {
      return NextResponse.json({ error: "live_session_not_live" }, { status: 400 });
    }

    await admitLiveViewer({ sessionId, userId: userData.user.id });
    await postLiveComment({ sessionId, userId: userData.user.id, body: comment });

    // Ephemeral comment delivery: Realtime broadcast only, nothing persisted
    // (policy §12.1 item 6; tech §6). Channel: live_session:{id}. Sequence is
    // server-issued and monotonic per session (tech §6).
    const channel = supabase.channel(`live_session:${sessionId}`);
    await channel.send({
      type: "broadcast",
      event: "comment",
      payload: {
        sequence: nextLiveCommentSequence(sessionId),
        body: comment,
        authorId: userData.user.id,
      },
    });
    await channel.unsubscribe();

    return NextResponse.json({ delivered: true });
  } catch (error) {
    return errorResponse(error);
  }
}
