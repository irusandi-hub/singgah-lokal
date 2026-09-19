import { NextResponse } from "next/server";
import { AuthenticationRequiredError, ProducerAuthorizationRequiredError, requireProducerAccess } from "@/lib/auth/server";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { LiveReportCategory } from "@/lib/live/types";

const categories: LiveReportCategory[] = [
  "sexual_content",
  "graphic_violence",
  "illegal_activity",
  "prohibited_product",
  "smoking",
  "unsafe_activity",
  "minor_as_subject",
  "private_data",
  "other",
];

type ReportBody = {
  sessionId?: unknown;
  category?: unknown;
  note?: unknown;
  commentRef?: unknown;
};

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationRequiredError || error instanceof PlatformModeratorRequiredError) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }
  if (error instanceof ProducerAuthorizationRequiredError) {
    return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
  }
  return NextResponse.json({ error: "live_reports_unavailable" }, { status: 500 });
}

// Viewer report submission (policy §5.2). Anonymous reporting is prohibited.
export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = (await request.json()) as ReportBody;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const category = typeof body.category === "string" ? (body.category as LiveReportCategory) : ("" as LiveReportCategory);
    const note = typeof body.note === "string" ? body.note : undefined;
    const commentRef = typeof body.commentRef === "string" ? body.commentRef : undefined;

    if (!sessionId || !categories.includes(category)) {
      return NextResponse.json({ error: "live_report_category_invalid" }, { status: 400 });
    }
    if (note && note.length > 500) {
      return NextResponse.json({ error: "live_report_note_too_long" }, { status: 400 });
    }

    const { data, error } = await supabase.rpc("submit_live_report", {
      p_session_id: sessionId,
      p_category: category,
      p_note: note ?? null,
      p_comment_ref: commentRef ?? null,
    });

    if (error) {
      return NextResponse.json({ error: "live_report_failed" }, { status: 400 });
    }

    return NextResponse.json({ id: data });
  } catch (error) {
    return errorResponse(error);
  }
}

// Producer (owner/manager of the Place) reads reports for moderation triage.
// Platform moderators read via service access (not exposed on this route).
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (!sessionId) {
      return NextResponse.json({ error: "session_id_required" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const { data: session } = await supabase
      .from("live_sessions")
      .select("place_id")
      .eq("id", sessionId)
      .maybeSingle();
    if (!session) {
      return NextResponse.json({ error: "live_session_not_found" }, { status: 404 });
    }

    await requireProducerAccess(request, session.place_id, ["owner", "manager"]);

    const { data: reports, error } = await supabase
      .from("live_reports")
      .select("*")
      .eq("live_session_id", sessionId)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "live_reports_unavailable" }, { status: 500 });
    }

    return NextResponse.json({ reports });
  } catch (error) {
    if (error instanceof ProducerAuthorizationRequiredError) {
      return NextResponse.json({ error: "producer_authorization_required" }, { status: 403 });
    }
    return errorResponse(error);
  }
}
