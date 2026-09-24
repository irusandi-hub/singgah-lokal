"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Creator gate client. Authentication, lease ownership, secret-question
 * verification, and cookie issuance all happen on the server. This component
 * only renders a server response and submits the answer.
 */

export type GateState =
  | "loading"
  | "ready"
  | "creator_session_active"
  | "secret_question_missing"
  | "error";

export type GatePayload = {
  state: GateState;
  question?: string | null;
  error?: string;
  code?: string;
};

type Feedback = { kind: "error"; message: string } | null;

function isGatePayload(value: unknown): value is GatePayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      "state" in value &&
      typeof (value as { state?: unknown }).state === "string",
  );
}

function terminalError(): GatePayload {
  return {
    state: "error",
    code: "service_unavailable",
    error: "Layanan Creator sedang tidak tersedia. Coba lagi nanti.",
  };
}

export default function CreatorGateClient({ initialStatus }: { initialStatus?: GatePayload }) {
  const router = useRouter();
  const [status, setStatus] = useState<GatePayload>(initialStatus ?? { state: "loading" });
  const [answer, setAnswer] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const fetchStatus = useCallback(async (): Promise<GatePayload> => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/creator/gate", {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!isGatePayload(payload)) {
        return response.ok ? terminalError() : {
          state: "error",
          code: "service_unavailable",
          error: "Respons gate tidak valid. Coba lagi nanti.",
        };
      }
      if (!response.ok && payload.state === "loading") return terminalError();
      return payload;
    } catch {
      return terminalError();
    } finally {
      window.clearTimeout(timeoutId);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchStatus().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  async function submitAnswer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!answer.trim()) {
      setFeedback({ kind: "error", message: "Masukkan jawaban rahasia." });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/creator/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: "secret-question", answer: answer.trim() }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!isGatePayload(payload) && response.ok) {
        setStatus(terminalError());
        return;
      }
      const result = isGatePayload(payload) ? payload : null;
      if (!response.ok || !result) {
        if (result?.state === "creator_session_active" || result?.code === "creator_session_active") {
          setStatus({
            state: "creator_session_active",
            code: "creator_session_active",
            error: "Sesi Creator lain sedang aktif. Tunggu hingga lease berakhir.",
          });
          return;
        }
        if (result?.state === "secret_question_missing" || result?.code === "secret_question_missing") {
          setStatus({
            state: "secret_question_missing",
            code: "secret_question_missing",
            error: "Pertanyaan rahasia belum dikonfigurasi.",
          });
          return;
        }
        setFeedback({ kind: "error", message: result?.error ?? "Verifikasi gagal. Coba lagi." });
        return;
      }

      router.replace("/developer");
      router.refresh();
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
    } finally {
      setSubmitting(false);
    }
  }

  function retry() {
    setFeedback(null);
    setStatus({ state: "loading" });
    void fetchStatus().then(setStatus);
  }

  if (status.state === "loading") {
    return (
      <p className="text-sm font-semibold text-brand-ink/60" role="status">
        Memuat gate…
      </p>
    );
  }

  if (status.state === "creator_session_active") {
    return (
      <section className="rounded-2xl border border-live/30 bg-live/10 p-6" role="alert">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-live">Sesi aktif</p>
        <h2 className="mt-2 font-brand text-xl font-semibold text-brand-ink">Creator lain sedang menggunakan Developer Center</h2>
        <p className="mt-3 text-sm leading-6 text-brand-ink/65">
          {status.error ?? "Sesi Creator lain sedang aktif. Tunggu hingga lease berakhir."}
        </p>
        <p className="mt-2 text-xs text-brand-ink/45">Identitas Creator aktif tidak ditampilkan.</p>
        <button
          type="button"
          onClick={retry}
          className="mt-5 rounded-xl border border-brand-ink/15 bg-white px-4 py-2.5 text-xs font-semibold text-brand-ink"
        >
          Periksa lagi
        </button>
      </section>
    );
  }

  if (status.state === "secret_question_missing") {
    return (
      <section className="rounded-2xl border border-live/30 bg-live/10 p-6" role="alert">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-live">Konfigurasi belum selesai</p>
        <h2 className="mt-2 font-brand text-xl font-semibold text-brand-ink">Pertanyaan rahasia belum tersedia</h2>
        <p className="mt-3 text-sm leading-6 text-brand-ink/65">
          {status.error ?? "Pertanyaan rahasia belum dikonfigurasi. Gate tetap ditutup."}
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-5 rounded-xl border border-brand-ink/15 bg-white px-4 py-2.5 text-xs font-semibold text-brand-ink"
        >
          Periksa lagi
        </button>
      </section>
    );
  }

  if (status.state === "error" || !status.question) {
    return (
      <section className="rounded-2xl border border-live/30 bg-live/10 p-6" role="alert">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-live">Gate tidak tersedia</p>
        <h2 className="mt-2 font-brand text-xl font-semibold text-brand-ink">Verifikasi tidak dapat dilanjutkan</h2>
        <p className="mt-3 text-sm leading-6 text-brand-ink/65">
          {status.error ?? "Layanan Creator sedang tidak tersedia. Coba lagi nanti."}
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-5 rounded-xl border border-brand-ink/15 bg-white px-4 py-2.5 text-xs font-semibold text-brand-ink"
        >
          Coba lagi
        </button>
      </section>
    );
  }

  const inputClass =
    "w-full rounded-xl border border-brand-ink/15 bg-white px-4 py-2.5 text-sm text-brand-ink focus:border-brand-primary focus:outline-none";

  return (
    <section className="rounded-2xl border border-brand-ink/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Verifikasi Creator</p>
      <h2 className="mt-2 font-brand text-xl font-semibold text-brand-ink">Jawab pertanyaan rahasia</h2>
      <p className="mt-3 text-sm font-semibold text-brand-ink">{status.question}</p>
      <form className="mt-5 space-y-4" onSubmit={submitAnswer}>
        <div>
          <label className="block text-xs font-bold uppercase tracking-[0.14em] text-brand-ink/50" htmlFor="gate-secret-answer">
            Jawaban
          </label>
          <input
            id="gate-secret-answer"
            className={inputClass}
            type="password"
            autoComplete="off"
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </div>
        {feedback ? (
          <p className="rounded-xl border border-live/30 bg-live/10 px-3 py-2 text-xs font-semibold text-live" role="alert">
            {feedback.message}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-xl bg-brand-primary px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-brand-primary-deep disabled:opacity-50"
        >
          {submitting ? "Memverifikasi…" : "Buka Developer Center"}
        </button>
      </form>
      <p className="mt-3 text-xs leading-5 text-brand-ink/50">
        Jawaban diverifikasi server-side. Data verifikasi tidak pernah dikirim ke browser.
      </p>
    </section>
  );
}
