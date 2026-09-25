import { NextResponse } from "next/server";
import {
  checkCreatorSecretAnswer,
  getCreatorSecretQuestion,
  SecretQuestionValidationError,
  setCreatorSecretQuestion,
} from "@/lib/creator/security-settings";
import { CreatorRequiredError, isCreatorEmail, requireCreator } from "@/lib/auth/creator";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * CREATOR ACCOUNT SECURITY API (Authority Master §2).
 *
 * requireCreator() is the first check on every request and on every storage
 * operation. Email/password changes prove session ownership by re-verifying
 * the current password against Supabase Auth; the secret-question flow does
 * NOT use the account password — replacing an existing question requires the
 * previous answer, verified server-side against the stored scrypt hash/salt
 * (an unconfigured question may be created without an old answer). The
 * service-role key is never used here and never leaves the server; responses
 * never include answer material.
 */

type ErrorBody = { error: string; code?: string };

function jsonError(status: number, body: ErrorBody) {
  return NextResponse.json(body, { status });
}

export async function GET() {
  try {
    const creator = await requireCreator();
    const status = await getCreatorSecretQuestion(creator.userId);
    return NextResponse.json({ question: status });
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      return jsonError(403, { error: "Akses Creator diperlukan.", code: "creator_required" });
    }
    console.error("[creator/security-settings] read failed:", error);
    return jsonError(503, { error: "Layanan belum tersedia.", code: "service_unavailable" });
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

  const action = typeof body.action === "string" ? body.action : "";
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const secretAnswer = typeof body.secretAnswer === "string" ? body.secretAnswer : "";

  try {
    const creator = await requireCreator();

    if (action === "change-email") {
      // Prove session ownership with the current password before anything
      // changes (email/password flows only — never the secret-question flow).
      const supabase = await createSupabaseServerClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: creator.email,
        password: currentPassword,
      });
      if (signInError) {
        return jsonError(403, { error: "Password saat ini salah.", code: "invalid_current_password" });
      }
      const newEmail = typeof body.newEmail === "string" ? body.newEmail.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return jsonError(400, { error: "Format email baru tidak valid.", code: "invalid_email" });
      }
      // Anti-lockout guard: a Creator must never be able to rename their way
      // out of the allowlist.
      if (!isCreatorEmail(newEmail)) {
        return jsonError(
          400,
          { error: "Email baru harus termasuk dalam allowlist Creator.", code: "email_not_allowed" },
        );
      }
      const { error } = await supabase.auth.updateUser({ email: newEmail });
      if (error) {
        return jsonError(400, { error: error.message, code: "email_update_failed" });
      }
      return NextResponse.json({
        ok: true,
        message: "Perubahan email diproses. Konfirmasi dikirim ke email lama dan baru bila diaktifkan.",
      });
    }

    if (action === "change-password") {
      const supabase = await createSupabaseServerClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: creator.email,
        password: currentPassword,
      });
      if (signInError) {
        return jsonError(403, { error: "Password saat ini salah.", code: "invalid_current_password" });
      }
      const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
      if (newPassword.length < 8) {
        return jsonError(400, { error: "Password baru minimal 8 karakter.", code: "weak_password" });
      }
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) {
        return jsonError(400, { error: error.message, code: "password_update_failed" });
      }
      return NextResponse.json({ ok: true, message: "Password berhasil diubah." });
    }

    if (action === "change-secret-question") {
      const question = typeof body.question === "string" ? body.question : "";
      const answer = typeof body.answer === "string" ? body.answer : "";

      // This flow never uses the account password. If a question is already
      // configured, the previous answer is verified server-side against the
      // stored hash/salt before it can be replaced. An unconfigured question
      // may be created without an old answer (initial setup).
      const status = await getCreatorSecretQuestion(creator.userId);
      if (status.configured) {
        if (!secretAnswer) {
          return jsonError(
            400,
            { error: "Jawaban lama wajib diisi untuk mengganti pertanyaan.", code: "old_answer_required" },
          );
        }
        const verified = await checkCreatorSecretAnswer(creator.userId, secretAnswer);
        if (!verified) {
          return jsonError(403, { error: "Jawaban lama salah.", code: "invalid_secret_answer" });
        }
      }

      try {
        await setCreatorSecretQuestion(creator.userId, question, answer);
      } catch (error) {
        if (error instanceof SecretQuestionValidationError) {
          return jsonError(400, { error: error.message, code: "invalid_secret_question" });
        }
        throw error;
      }
      return NextResponse.json({ ok: true, message: "Pertanyaan rahasia diperbarui." });
    }

    return jsonError(400, { error: "Aksi tidak dikenal.", code: "unknown_action" });
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      return jsonError(403, { error: "Akses Creator diperlukan.", code: "creator_required" });
    }
    console.error("[creator/security-settings] request failed:", error);
    return jsonError(503, { error: "Layanan belum tersedia.", code: "service_unavailable" });
  }
}
