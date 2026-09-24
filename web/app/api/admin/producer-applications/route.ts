import { NextResponse } from "next/server";
import { requirePlatformModerator } from "@/lib/live/platform";
import {
  ProducerApplicationError,
  approveProducerApplication,
  listPendingProducerApplications,
} from "@/lib/producer/application";

export const dynamic = "force-dynamic";

/**
 * Admin approval for Producer applications (Platform Moderator only).
 *
 * Approval NEVER creates an auth user or credentials: it activates
 * producer_memberships for the applicant's existing user_id via the
 * server-side RPC, so the same account gains Producer access.
 */
export async function GET() {
  try {
    await requirePlatformModerator();
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }
  try {
    const applications = await listPendingProducerApplications();
    return NextResponse.json({ applications });
  } catch (error) {
    console.error("[admin/producer-applications] list failed:", error);
    return NextResponse.json({ error: "Gagal memuat pengajuan.", code: "service_unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await requirePlatformModerator();
  } catch {
    return NextResponse.json({ error: "Akses admin diperlukan.", code: "admin_required" }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const applicationId = typeof body.applicationId === "string" ? body.applicationId : "";
  const producerId = typeof body.producerId === "string" ? body.producerId.trim() : "";
  const placeId = typeof body.placeId === "string" ? body.placeId.trim() : "";
  const role = body.role === "manager" ? "manager" : "owner";

  if (!applicationId || !producerId || !placeId) {
    return NextResponse.json(
      { error: "applicationId, producerId, dan placeId wajib diisi.", code: "invalid_input" },
      { status: 400 },
    );
  }

  try {
    await approveProducerApplication(applicationId, producerId, placeId, role);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ProducerApplicationError) {
      const status = error.code === "application_not_pending" ? 409 : 503;
      return NextResponse.json({ error: error.code, code: error.code }, { status });
    }
    console.error("[admin/producer-applications] approve failed:", error);
    return NextResponse.json({ error: "Approval gagal. Coba lagi.", code: "service_unavailable" }, { status: 503 });
  }
}
