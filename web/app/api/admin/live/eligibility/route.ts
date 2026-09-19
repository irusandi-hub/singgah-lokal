import { NextResponse } from "next/server";
import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type GrantBody = {
  producerId?: unknown;
  path?: unknown;
  ratingThreshold?: unknown;
  minRatingCount?: unknown;
};

type RevokeBody = {
  producerId?: unknown;
  path?: unknown;
};

const paths = ["RATING", "CURATED", "EXCLUSIVE", "HISTORY", "ADMIN_APPROVED"] as const;

function errorResponse(error: unknown) {
  if (error instanceof PlatformModeratorRequiredError) {
    return NextResponse.json({ error: "platform_moderator_required" }, { status: 403 });
  }
  return NextResponse.json({ error: "live_eligibility_unavailable" }, { status: 500 });
}

// B2: Platform Admin/Moderator grant path (policy §12.2 #3, §12.2 #5).
// Production grants occur only through this audited, role-gated route.
export async function POST(request: Request) {
  try {
    const actor = await requirePlatformModerator();

    const body = (await request.json()) as GrantBody;
    const producerId = typeof body.producerId === "string" ? body.producerId.trim() : "";
    const path = typeof body.path === "string" ? (body.path as (typeof paths)[number]) : ("" as (typeof paths)[number]);

    if (!producerId || !paths.includes(path)) {
      return NextResponse.json({ error: "live_eligibility_input_invalid" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("grant_live_eligibility", {
      p_producer_id: producerId,
      p_path: path,
      p_rating_threshold: typeof body.ratingThreshold === "number" ? body.ratingThreshold : null,
      p_min_rating_count: typeof body.minRatingCount === "number" ? body.minRatingCount : null,
    });

    if (error) {
      return NextResponse.json({ error: "live_eligibility_grant_failed" }, { status: 400 });
    }

    return NextResponse.json({ granted: true, grantedBy: actor.userId, path });
  } catch (error) {
    return errorResponse(error);
  }
}

// B2: revoke a previously granted path (audited as eligibility_revoked).
export async function DELETE(request: Request) {
  try {
    const actor = await requirePlatformModerator();

    const body = (await request.json()) as RevokeBody;
    const producerId = typeof body.producerId === "string" ? body.producerId.trim() : "";
    const path = typeof body.path === "string" ? (body.path as (typeof paths)[number]) : ("" as (typeof paths)[number]);

    if (!producerId || !paths.includes(path)) {
      return NextResponse.json({ error: "live_eligibility_input_invalid" }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("revoke_live_eligibility", {
      p_producer_id: producerId,
      p_path: path,
    });

    if (error) {
      if (String(error.message).includes("live_eligibility_not_found")) {
        return NextResponse.json({ error: "live_eligibility_not_found" }, { status: 404 });
      }
      return NextResponse.json({ error: "live_eligibility_revoke_failed" }, { status: 400 });
    }

    return NextResponse.json({ revoked: true, revokedBy: actor.userId, path });
  } catch (error) {
    return errorResponse(error);
  }
}
