"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Creator-only account security panel (Developer Center).
 *
 * The three flows are fully independent: each has its own idle/loading/
 * success/error feedback rendered directly above its own form, its own
 * pending state, and submitting or loading one menu never disables or
 * re-renders the feedback of the others.
 *
 * Server-side contract (all actions re-verify requireCreator()):
 * - change-email and change-password require the current password
 *   (Supabase Auth re-verification) and never touch the secret question;
 * - change-secret-question never uses the account password: replacing an
 *   existing question requires the previous answer, verified server-side
 *   against the stored scrypt hash/salt; an unconfigured question may be
 *   created without an old answer.
 * This component holds no secrets beyond what the Creator types.
 */

type ApiError = { error: string; code?: string };

type QuestionStatus =
  | { configured: true; question: string; updatedAt: string }
  | { configured: false };

/** Per-menu async state: exactly one of idle/loading/success/error. */
type MenuState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

const IDLE: MenuState = { status: "idle" };

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

/** Success/error feedback rendered directly ABOVE its own menu's form. */
function Feedback({ state }: { state: MenuState }) {
  if (state.status === "idle" || state.status === "loading") return null;
  const tone =
    state.status === "success"
      ? "border-ok/30 bg-ok/10 text-ok"
      : "border-live/30 bg-live/10 text-live";
  return (
    <p role="status" className={`mb-3 rounded-xl border px-3 py-2 text-xs font-semibold ${tone}`}>
      {state.message}
    </p>
  );
}

function LoadingLine({ state }: { state: MenuState }) {
  if (state.status !== "loading") return null;
  return (
    <p role="status" className="mb-3 text-xs font-semibold text-brand-ink/50">
      Memproses…
    </p>
  );
}

export default function AccountSecurityManager() {
  // Independent per-menu state — one update never touches the others.
  const [emailState, setEmailState] = useState<MenuState>(IDLE);
  const [passwordState, setPasswordState] = useState<MenuState>(IDLE);
  const [secretState, setSecretState] = useState<MenuState>(IDLE);

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

  /**
   * Per-menu submit. Only the caller's own state setter is touched — a
   * failure in one menu can never alter another menu's feedback, and each
   * button's disabled flag is bound to its own menu's loading state.
   */
  async function submit(
    action: string,
    fields: Record<string, string>,
    setState: React.Dispatch<React.SetStateAction<MenuState>>,
    onSuccess?: () => void,
  ) {
    setState({ status: "loading" });
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
        setState({ status: "error", message });
        return;
      }
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: string }).message ?? "Berhasil.")
          : "Berhasil.";
      setState({ status: "success", message });
      onSuccess?.();
    } catch {
      setState({ status: "error", message: "Tidak dapat menghubungi server." });
    }
  }

  function resetFormState(fields: Array<(value: string) => void>) {
    for (const set of fields) set("");
  }

  async function onChangeEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentPasswordEmail || !newEmail) {
      setEmailState({ status: "error", message: "Lengkapi password saat ini dan email baru." });
      return;
    }
    if (emailState.status === "loading") return;
    await submit(
      "change-email",
      { currentPassword: currentPasswordEmail, newEmail },
      setEmailState,
      () => resetFormState([setCurrentPasswordEmail, setNewEmail]),
    );
  }

  async function onChangePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (passwordState.status === "loading") return;
    if (!currentPassword || !newPassword || !newPasswordConfirmation) {
      setPasswordState({ status: "error", message: "Lengkapi semua field password." });
      return;
    }
    if (newPassword !== newPasswordConfirmation) {
      setPasswordState({ status: "error", message: "Konfirmasi password baru tidak cocok." });
      return;
    }
    await submit(
      "change-password",
      { currentPassword, newPassword },
      setPasswordState,
      () => resetFormState([setCurrentPassword, setNewPassword, setNewPasswordConfirmation]),
    );
  }

  async function onChangeSecretQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (secretState.status === "loading") return;
    if (!newQuestion || !newAnswer || !newAnswerConfirmation) {
      setSecretState({
        status: "error",
        message: "Lengkapi pertanyaan, jawaban, dan konfirmasi jawaban.",
      });
      return;
    }
    if (questionStatus?.configured && !oldSecretAnswer) {
      setSecretState({ status: "error", message: "Jawaban lama wajib diisi." });
      return;
    }
    if (newAnswer !== newAnswerConfirmation) {
      setSecretState({ status: "error", message: "Konfirmasi jawaban tidak cocok." });
      return;
    }
    const fields: Record<string, string> = { question: newQuestion, answer: newAnswer };
    if (questionStatus?.configured) fields.secretAnswer = oldSecretAnswer;
    await submit(
      "change-secret-question",
      fields,
      setSecretState,
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
          Semua perubahan diverifikasi server-side. Ganti email dan password mengonfirmasi password
          saat ini; pertanyaan rahasia tidak memakai password akun — menggantinya membutuhkan jawaban
          lama yang terverifikasi server-side. Jawaban disimpan sebagai hash — tidak pernah plaintext.
        </p>
      </div>

      <Card
        title="Ganti Email"
        description="Email akun Creator di Supabase Auth. Harus tetap berada dalam allowlist Creator."
      >
        <Feedback state={emailState} />
        <LoadingLine state={emailState} />
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
          <button
            className={primaryButtonClass}
            type="submit"
            disabled={emailState.status === "loading"}
          >
            {emailState.status === "loading" ? "Memproses…" : "Ganti Email"}
          </button>
        </form>
      </Card>

      <Card
        title="Ganti Password"
        description="Password akun Creator di Supabase Auth. Minimal 8 karakter."
      >
        <Feedback state={passwordState} />
        <LoadingLine state={passwordState} />
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
          <button
            className={primaryButtonClass}
            type="submit"
            disabled={passwordState.status === "loading"}
          >
            {passwordState.status === "loading" ? "Memproses…" : "Ganti Password"}
          </button>
        </form>
      </Card>

      <Card
        title="Ganti Pertanyaan Rahasia"
        description={
          questionStatus === null
            ? "Memuat status pertanyaan rahasia…"
            : questionStatus.configured
              ? "Pertanyaan saat ini terpasang. Menggantinya membutuhkan jawaban lama — bukan password akun."
              : "Belum ada pertanyaan rahasia. Pertanyaan pertama dapat dibuat tanpa jawaban lama."
        }
      >
        <Feedback state={secretState} />
        <LoadingLine state={secretState} />
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
          <button
            className={primaryButtonClass}
            type="submit"
            disabled={secretState.status === "loading"}
          >
            {secretState.status === "loading" ? "Memproses…" : "Simpan Pertanyaan Rahasia"}
          </button>
        </form>
      </Card>
    </div>
  );
}
