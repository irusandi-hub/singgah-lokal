"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Creator-only account security panel (Developer Center).
 *
 * All three flows post to /api/creator/security-settings, where every action
 * is re-verified server-side: requireCreator() gates the route, the current
 * password is checked against Supabase Auth, and replacing an existing
 * secret question requires the previous answer (scrypt-verified server-side).
 * This component holds no secrets beyond what the Creator types.
 */

type ApiError = { error: string; code?: string };

type QuestionStatus =
  | { configured: true; question: string; updatedAt: string }
  | { configured: false };

const inputClass =
  "w-full rounded-xl border border-brand-ink/15 bg-white px-4 py-2.5 text-sm text-brand-ink placeholder:text-brand-ink/35 focus:border-brand-primary focus:outline-none";
const labelClass = "block text-xs font-bold uppercase tracking-[0.14em] text-brand-ink/50";
const primaryButtonClass =
  "rounded-xl bg-brand-primary px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-brand-primary-deep disabled:cursor-not-allowed disabled:opacity-50";

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-brand-ink/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
      <h3 className="text-base font-semibold text-brand-ink">{title}</h3>
      <p className="mt-1 text-xs leading-5 text-brand-ink/50">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Feedback({ state }: { state: { kind: "idle" | "ok" | "error"; message: string } }) {
  if (state.kind === "idle") return null;
  const tone =
    state.kind === "ok"
      ? "border-ok/30 bg-ok/10 text-ok"
      : "border-live/30 bg-live/10 text-live";
  return (
    <p role="status" className={`mt-3 rounded-xl border px-3 py-2 text-xs font-semibold ${tone}`}>
      {state.message}
    </p>
  );
}

export default function AccountSecurityManager() {
  const [feedback, setFeedback] = useState<{ kind: "idle" | "ok" | "error"; message: string }>({
    kind: "idle",
    message: "",
  });
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Ganti Email
  const [currentPasswordEmail, setCurrentPasswordEmail] = useState("");
  const [newEmail, setNewEmail] = useState("");

  // Ganti Password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");

  // Pertanyaan Rahasia
  const [questionStatus, setQuestionStatus] = useState<QuestionStatus | null>(null);
  const [oldSecretAnswer, setOldSecretAnswer] = useState("");
  const [newQuestion, setNewQuestion] = useState("");
  const [newAnswer, setNewAnswer] = useState("");
  const [newAnswerConfirmation, setNewAnswerConfirmation] = useState("");

  // Pure fetcher: returns the parsed status, performs no setState, so the
  // mount effect below can consume it without synchronous state updates.
  const fetchQuestionStatus = useCallback(async (): Promise<QuestionStatus | null> => {
    try {
      const response = await fetch("/api/creator/security-settings");
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      const question =
        payload && typeof payload === "object" && "question" in payload
          ? (payload as { question?: unknown }).question
          : null;
      if (
        question &&
        typeof question === "object" &&
        "configured" in question &&
        (question as { configured: boolean }).configured
      ) {
        return question as QuestionStatus;
      }
      return { configured: false };
    } catch {
      return null;
    }
  }, []);

  // Load status once on mount. SetStates run only after the fetch resolves
  // (never synchronously in the effect) with a cancelled guard, consistent
  // with the project's effect rules.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await fetchQuestionStatus();
      if (!cancelled) setQuestionStatus(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchQuestionStatus]);

  async function submit(action: string, fields: Record<string, string>, onSuccess?: () => void) {
    setFeedback({ kind: "idle", message: "" });
    setPendingAction(action);
    try {
      const response = await fetch("/api/creator/security-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...fields }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as ApiError).error)
            : "Permintaan gagal.";
        setFeedback({ kind: "error", message });
        return;
      }
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: string }).message ?? "Berhasil.")
          : "Berhasil.";
      setFeedback({ kind: "ok", message });
      onSuccess?.();
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
    } finally {
      setPendingAction(null);
    }
  }

  function resetFormState(fields: Array<(value: string) => void>) {
    for (const set of fields) set("");
  }

  async function onChangeEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentPasswordEmail || !newEmail) {
      setFeedback({ kind: "error", message: "Lengkapi password saat ini dan email baru." });
      return;
    }
    await submit(
      "change-email",
      { currentPassword: currentPasswordEmail, newEmail },
      () => resetFormState([setCurrentPasswordEmail, setNewEmail]),
    );
  }

  async function onChangePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentPassword || !newPassword || !newPasswordConfirmation) {
      setFeedback({ kind: "error", message: "Lengkapi semua field password." });
      return;
    }
    if (newPassword !== newPasswordConfirmation) {
      setFeedback({ kind: "error", message: "Konfirmasi password baru tidak cocok." });
      return;
    }
    await submit(
      "change-password",
      { currentPassword, newPassword },
      () => resetFormState([setCurrentPassword, setNewPassword, setNewPasswordConfirmation]),
    );
  }

  async function onChangeSecretQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newQuestion || !newAnswer || !newAnswerConfirmation) {
      setFeedback({ kind: "error", message: "Lengkapi pertanyaan, jawaban, dan konfirmasi jawaban." });
      return;
    }
    if (newAnswer !== newAnswerConfirmation) {
      setFeedback({ kind: "error", message: "Konfirmasi jawaban tidak cocok." });
      return;
    }
    const fields: Record<string, string> = { question: newQuestion, answer: newAnswer };
    if (questionStatus?.configured) fields.secretAnswer = oldSecretAnswer;
    await submit(
      "change-secret-question",
      fields,
      () => {
        resetFormState([setNewQuestion, setNewAnswer, setNewAnswerConfirmation, setOldSecretAnswer]);
        void (async () => {
          setQuestionStatus(await fetchQuestionStatus());
        })();
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-brand-ink/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Keamanan Akun</p>
        <h2 className="mt-2 font-brand text-2xl font-semibold text-brand-ink">Pengaturan akun Creator</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-brand-ink/60">
          Semua perubahan diverifikasi server-side. Password saat ini wajib untuk setiap aksi, dan
          pertanyaan rahasia hanya dapat diganti setelah jawaban lama terverifikasi. Jawaban disimpan
          sebagai hash — tidak pernah plaintext.
        </p>
      </div>

      <Feedback state={feedback} />

      <Card
        title="Ganti Email"
        description="Email akun Creator di Supabase Auth. Harus tetap berada dalam allowlist Creator."
      >
        <form className="space-y-3" onSubmit={onChangeEmail}>
          <div>
            <label className={labelClass} htmlFor="creator-current-password-email">
              Password saat ini
            </label>
            <input
              id="creator-current-password-email"
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={currentPasswordEmail}
              onChange={(event) => setCurrentPasswordEmail(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="creator-new-email">
              Email baru
            </label>
            <input
              id="creator-new-email"
              className={inputClass}
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
            />
          </div>
          <button className={primaryButtonClass} type="submit" disabled={pendingAction !== null}>
            {pendingAction === "change-email" ? "Memproses…" : "Ganti Email"}
          </button>
        </form>
      </Card>

      <Card
        title="Ganti Password"
        description="Password akun Creator di Supabase Auth. Minimal 8 karakter."
      >
        <form className="space-y-3" onSubmit={onChangePassword}>
          <div>
            <label className={labelClass} htmlFor="creator-current-password">
              Password saat ini
            </label>
            <input
              id="creator-current-password"
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="creator-new-password">
              Password baru
            </label>
            <input
              id="creator-new-password"
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="creator-new-password-confirmation">
              Konfirmasi password baru
            </label>
            <input
              id="creator-new-password-confirmation"
              className={inputClass}
              type="password"
              autoComplete="new-password"
              value={newPasswordConfirmation}
              onChange={(event) => setNewPasswordConfirmation(event.target.value)}
            />
          </div>
          <button className={primaryButtonClass} type="submit" disabled={pendingAction !== null}>
            {pendingAction === "change-password" ? "Memproses…" : "Ganti Password"}
          </button>
        </form>
      </Card>

      <Card
        title="Ganti Pertanyaan Rahasia"
        description={
          questionStatus === null
            ? "Memuat status pertanyaan rahasia…"
            : questionStatus.configured
              ? "Pertanyaan saat ini terpasang. Menggantinya membutuhkan jawaban lama yang terverifikasi."
              : "Belum ada pertanyaan rahasia. Pertanyaan ini melindungi area Developer."
        }
      >
        <form className="space-y-3" onSubmit={onChangeSecretQuestion}>
          {questionStatus?.configured ? (
            <div>
              <label className={labelClass} htmlFor="creator-old-secret-answer">
                Jawaban lama
              </label>
              <input
                id="creator-old-secret-answer"
                className={inputClass}
                type="password"
                value={oldSecretAnswer}
                onChange={(event) => setOldSecretAnswer(event.target.value)}
              />
            </div>
          ) : null}
          <div>
            <label className={labelClass} htmlFor="creator-new-secret-question">
              Pertanyaan baru
            </label>
            <input
              id="creator-new-secret-question"
              className={inputClass}
              type="text"
              maxLength={200}
              value={newQuestion}
              onChange={(event) => setNewQuestion(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="creator-new-secret-answer">
              Jawaban baru
            </label>
            <input
              id="creator-new-secret-answer"
              className={inputClass}
              type="password"
              maxLength={200}
              value={newAnswer}
              onChange={(event) => setNewAnswer(event.target.value)}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="creator-new-secret-answer-confirmation">
              Konfirmasi jawaban baru
            </label>
            <input
              id="creator-new-secret-answer-confirmation"
              className={inputClass}
              type="password"
              maxLength={200}
              value={newAnswerConfirmation}
              onChange={(event) => setNewAnswerConfirmation(event.target.value)}
            />
          </div>
          <button className={primaryButtonClass} type="submit" disabled={pendingAction !== null}>
            {pendingAction === "change-secret-question" ? "Memproses…" : "Simpan Pertanyaan Rahasia"}
          </button>
        </form>
      </Card>
    </div>
  );
}
