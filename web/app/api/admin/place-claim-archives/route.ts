import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import { searchPlaceClaimArchives } from "@/lib/admin/place-claim-archive";

export const dynamic = "force-dynamic";

/**
 * INTERNAL claim-archive search (Platform Moderator only) — MASTER §5/§16.1.
 *
 * Reachable by direct API call with a live Platform Admin session; mounted on
 * NO Dashboard page (MASTER §4: the archive never appears as normal history).
 * Search keys: Place ID, Pengelola (user) ID, claimant email, claim ID.
 * Failures never fabricate rows; an unauthorized caller gets 403 and no
 * information about whether the archive exists.
 */
export async function GET(request: Request) {
  try {
    await requirePlatformModerator();
  } catch {
    return NextResponse.json(
      { error: "Akses admin diperlukan.", code: "admin_required" },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  try {
    const archives = await searchPlaceClaimArchives({
      placeId: url.searchParams.get("placeId"),
      userId: url.searchParams.get("userId"),
      email: url.searchParams.get("email"),
      claimId: url.searchParams.get("claimId"),
    });
    return NextResponse.json({ archives });
  } catch (error) {
    console.error("[admin/place-claim-archives] search failed:", error);
    return NextResponse.json(
      { error: "Arsip tidak dapat dimuat.", code: "service_unavailable" },
      { status: 503 },
    );
  }
}
