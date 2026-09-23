import { NextResponse } from "next/server";
import { CreatorRequiredError, requireCreator } from "@/lib/auth/creator";
import { checkCreatorSecretAnswer, getCreatorSecretQuestion } from "@/lib/creator/security-settings";
import {
  GateConfigError,
  checkLeaseBeforeGateSteps,
  passCaptchaStep,
  passSecretQuestionStep,
} from "@/lib/creator/gate";

export const dynamic = "force-dynamic";

/**
 * CREATOR SECURITY GATE API (Authority Master §2).
 *
 * Two server-verified steps issue the signed gate cookie:
 *   step "captcha"          → Cloudflare Turnstile siteverify (server-side)
 *   step "secret-question"  → scrypt hash verification of the stored answer
 *
 * requireCreator() runs first on every request: the gate is an additional
 * layer, never a replacement for Creator authorization. Responses never
 * include answer material, and a wrong answer and an unset question are
 * indistinguishable (same generic failure). Completion is a JSON verdict —
 * the client navigates to a fixed destination, so no open redirect exists.
 */

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return undefined;
  return forwarded.split(",")[0]?.trim() || undefined;
}

export async function GET(request: Request) {
  void request;
  try {
    const creator = await requireCreator();

    // Single active session: refuse BEFORE revealing any gate state when the
    // slot is validly held by another Creator. Only a limited, masked
    // identifier of the active holder is returned — never full id/email.
    const leaseCheck = await checkLeaseBeforeGateSteps(creator.userId);
    if (!leaseCheck.proceed) {
      if (leaseCheck.reason === "lease_unavailable") {
        return NextResponse.json(
          { error: "Gate belum tersedia.", code: "lease_unavailable" },
          { status: 503 },
        );
      }
      return NextResponse.json(
        {
          error: "Sesi Creator lain sedang aktif.",
          code: "creator_session_active",
          activeHolderMaskedId: leaseCheck.maskedId ?? null,
          activeExpiresIso: leaseCheck.expiresIso ?? null,
        },
        { status: 423 },
      );
    }

    let captchaConfigured = Boolean(process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY);
    let questionStatus: Awaited<ReturnType<typeof getCreatorSecretQuestion>> | null = null;
    let storageAvailable = true;
    try {
      questionStatus = await getCreatorSecretQuestion(creator.userId);
    } catch (storageError) {
      // Service-role config problems must not leak internals; the gate simply
      // reports fail-closed state to the only user who can fix it (Creator).
      console.error("[creator/gate] status read failed:", storageError);
      storageAvailable = false;
      captchaConfigured = false;
    }

    return NextResponse.json({
      captchaConfigured,
      storageAvailable,
      questionConfigured: questionStatus?.configured === true,
      question: questionStatus?.configured === true ? questionStatus.question : null,
    });
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      return NextResponse.json({ error: "Akses Creator diperlukan.", code: "creator_required" }, { status: 403 });
    }
    console.error("[creator/gate] status failed:", error);
    return NextResponse.json({ error: "Gate belum tersedia.", code: "service_unavailable" }, { status: 503 });
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
    const creatorUserId = creator.userId;

    if (step === "captcha") {
      const token = typeof body.token === "string" ? body.token : "";
      const result = await passCaptchaStep(token, clientIp(request));
      if (!result.ok) {
        if (result.code === "creator_session_active") {
          const leaseCheck = await checkLeaseBeforeGateSteps(creatorUserId);
          return NextResponse.json(
            {
              error: "Sesi Creator lain sedang aktif.",
              code: "creator_session_active",
              activeHolderMaskedId: leaseCheck.proceed ? null : leaseCheck.maskedId ?? null,
              activeExpiresIso: leaseCheck.proceed ? null : leaseCheck.expiresIso ?? null,
            },
            { status: 423 },
          );
        }
        const status = result.code === "captcha_not_configured" ? 503 : 403;
        return NextResponse.json(
          { error: "Verifikasi gagal. Coba lagi.", code: result.code },
          { status },
        );
      }
      return NextResponse.json({ ok: true, next: "secret-question" });
    }

    if (step === "secret-question") {
      const answer = typeof body.answer === "string" ? body.answer : "";
      const result = await passSecretQuestionStep(answer, checkCreatorSecretAnswer);
      if (!result.ok) {
        if (result.code === "creator_session_active") {
          const leaseCheck = await checkLeaseBeforeGateSteps(creatorUserId);
          return NextResponse.json(
            {
              error: "Sesi Creator lain sedang aktif.",
              code: "creator_session_active",
              activeHolderMaskedId: leaseCheck.proceed ? null : leaseCheck.maskedId ?? null,
              activeExpiresIso: leaseCheck.proceed ? null : leaseCheck.expiresIso ?? null,
            },
            { status: 423 },
          );
        }
        const status = result.code === "config_error" ? 503 : 403;
        return NextResponse.json(
          { error: "Verifikasi gagal. Coba lagi.", code: result.code },
          { status },
        );
      }
      return NextResponse.json({ ok: true, next: "complete" });
    }

    return NextResponse.json({ error: "Aksi tidak dikenal.", code: "unknown_action" }, { status: 400 });
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      return NextResponse.json({ error: "Akses Creator diperlukan.", code: "creator_required" }, { status: 403 });
    }
    if (error instanceof GateConfigError) {
      console.error("[creator/gate] config missing:", error.missingVars.join(", "));
      return NextResponse.json(
        {
          error: `Konfigurasi server belum lengkap: ${error.missingVars.join(", ")}`,
          code: "config_error",
          missingVars: error.missingVars,
        },
        { status: 503 },
      );
    }
    console.error("[creator/gate] step failed:", error);
    return NextResponse.json({ error: "Verifikasi gagal. Coba lagi.", code: "service_unavailable" }, { status: 503 });
  }
}
