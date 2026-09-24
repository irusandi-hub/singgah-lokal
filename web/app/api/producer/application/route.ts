import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  ProducerApplicationError,
  fileProducerApplication,
  getProducerApplicationStatus,
} from "@/lib/producer/application";

export const dynamic = "force-dynamic";

/**
 * Producer application API (identity locked to the authenticated account).
 *
 * GET  → the caller's own application status.
 * POST → files an application for the SIGNED-IN account. The user id and
 *        email are taken from the Supabase session — a client-supplied email
 *        is ignored entirely, so no separate Producer identity can exist.
 */
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ authenticated: false, application: { status: "none" } }, { status: 401 });
    }
    const application = await getProducerApplicationStatus(userData.user.id);
    return NextResponse.json({
      authenticated: true,
      accountEmail: userData.user.email ?? null,
      application,
    });
  } catch (error) {
    if (error instanceof ProducerApplicationError && error.code === "service_unavailable") {
      console.error("[producer/application] status read failed:", error);
      return NextResponse.json({ error: "Layanan pengajuan belum tersedia.", code: "service_unavailable" }, { status: 503 });
    }
    console.error("[producer/application] status failed:", error);
    return NextResponse.json({ error: "Gagal memuat status pengajuan.", code: "service_unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  let note: string | null = null;
  try {
    const body: unknown = await request.json().catch(() => null);
    if (body && typeof body === "object" && "note" in body) {
      const raw = (body as { note?: unknown }).note;
      if (typeof raw === "string" && raw.trim().length > 0) {
        note = raw.trim().slice(0, 1000);
      }
    }
  } catch {
    note = null;
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user?.email) {
      return NextResponse.json(
        { error: "Masuk terlebih dahulu untuk mengajukan.", code: "authentication_required" },
        { status: 401 },
      );
    }

    // Identity comes ONLY from the session. The client cannot nominate a
    // different email or user — the snapshot email is the authenticated one.
    await fileProducerApplication(userData.user.id, userData.user.email, note);
    return NextResponse.json({ ok: true, status: "pending" }, { status: 201 });
  } catch (error) {
    if (error instanceof ProducerApplicationError) {
      if (error.code === "application_already_active") {
        return NextResponse.json(
          { error: "Pengajuan Producer sudah ada untuk akun ini.", code: error.code },
          { status: 409 },
        );
      }
      console.error("[producer/application] submit failed:", error);
      return NextResponse.json({ error: "Layanan pengajuan belum tersedia.", code: "service_unavailable" }, { status: 503 });
    }
    console.error("[producer/application] submit error:", error);
    return NextResponse.json({ error: "Pengajuan gagal. Coba lagi.", code: "service_unavailable" }, { status: 503 });
  }
}
