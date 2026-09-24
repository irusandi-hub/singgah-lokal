import { NextResponse } from "next/server";

import { CreatorRequiredError, requireCreator } from "@/lib/auth/creator";
import {
  CreatorLeaseError,
  acquireCreatorLease,
} from "@/lib/creator/session-lease";
import {
  checkCreatorSecretAnswer,
  getCreatorSecretQuestion,
} from "@/lib/creator/security-settings";
import {
  GateConfigError,
  isCreatorGateConfigured,
  passSecretQuestionStep,
} from "@/lib/creator/gate";

export const dynamic = "force-dynamic";

const ACTIVE_SESSION_ERROR = "Sesi Creator lain sedang aktif. Tunggu hingga lease berakhir.";
const SERVICE_ERROR = "Layanan Creator sedang tidak tersedia. Coba lagi nanti.";

function jsonError(status: number, code: string, error: string) {
  return NextResponse.json({ ok: false, state: "error", code, error }, { status });
}

function activeSessionResponse() {
  return NextResponse.json(
    { ok: false, state: "creator_session_active", code: "creator_session_active", error: ACTIVE_SESSION_ERROR },
    { status: 409 },
  );
}

function missingQuestionResponse() {
  return NextResponse.json(
    {
      ok: false,
      state: "secret_question_missing",
      code: "secret_question_missing",
      error: "Pertanyaan rahasia belum dikonfigurasi. Hubungi Creator yang mengelola akun ini.",
    },
    { status: 503 },
  );
}

function handleServiceError(error: unknown) {
  if (error instanceof CreatorRequiredError) {
    return NextResponse.json(
      { ok: false, state: "error", error: "Akses Creator diperlukan.", code: "creator_required" },
      { status: 403 },
    );
  }
  if (error instanceof GateConfigError) {
    console.error("[creator/gate] configuration missing:", error.missingVars.join(", "));
    return jsonError(503, "gate_not_configured", SERVICE_ERROR);
  }
  if (error instanceof CreatorLeaseError) {
    console.error("[creator/gate] lease unavailable:", error.code);
    return jsonError(503, "lease_unavailable", SERVICE_ERROR);
  }
  console.error("[creator/gate] service failure:", error);
  return jsonError(503, "service_unavailable", SERVICE_ERROR);
}

/** GET always returns a terminal, explicit state; it never leaves the UI loading. */
export async function GET() {
  try {
    const creator = await requireCreator();
    if (!isCreatorGateConfigured()) {
      return jsonError(503, "gate_not_configured", SERVICE_ERROR);
    }

    const acquired = await acquireCreatorLease(creator.userId);
    if (!acquired) return activeSessionResponse();

    const questionStatus = await getCreatorSecretQuestion(creator.userId);
    if (!questionStatus.configured) return missingQuestionResponse();

    return NextResponse.json({
      ok: true,
      state: "ready",
      questionConfigured: true,
      question: questionStatus.question,
    });
  } catch (error) {
    return handleServiceError(error);
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }

  const step = typeof body.step === "string" ? body.step : "";

  try {
    const creator = await requireCreator();
    if (!isCreatorGateConfigured()) {
      return jsonError(503, "gate_not_configured", SERVICE_ERROR);
    }

    if (step === "heartbeat") {
      const acquired = await acquireCreatorLease(creator.userId);
      if (!acquired) return activeSessionResponse();
      return NextResponse.json({ ok: true, state: "ready" });
    }

    if (step !== "secret-question") {
      return jsonError(400, "unknown_action", "Aksi tidak dikenal.");
    }

    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    if (!answer) {
      return jsonError(400, "answer_required", "Masukkan jawaban rahasia.");
    }

    // Re-check the lease before loading/using the secret-question data. The
    // pass function repeats this check immediately before issuing the cookie.
    const acquired = await acquireCreatorLease(creator.userId);
    if (!acquired) return activeSessionResponse();

    const questionStatus = await getCreatorSecretQuestion(creator.userId);
    if (!questionStatus.configured) return missingQuestionResponse();

    const result = await passSecretQuestionStep(answer, checkCreatorSecretAnswer);
    if (!result.ok) {
      if (result.code === "creator_session_active") return activeSessionResponse();
      if (result.code === "invalid_secret_answer") {
        return NextResponse.json(
          { ok: false, state: "secret_question", code: "invalid_secret_answer", error: "Verifikasi gagal. Coba lagi." },
          { status: 403 },
        );
      }
      return jsonError(503, "gate_not_configured", SERVICE_ERROR);
    }

    return NextResponse.json({ ok: true, state: "complete", next: "developer" });
  } catch (error) {
    return handleServiceError(error);
  }
}
