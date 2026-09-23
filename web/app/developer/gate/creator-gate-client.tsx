"use client";

import { useCallback, useEffect, useState } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";

/**
 * Creator security gate UI (Authority Master §2).
 *
 * Renders the two-step verification for the one account type that reaches
 * it: step 1 renders the real Cloudflare Turnstile widget (token verified
 * server-side via siteverify), step 2 posts the secret answer for scrypt
 * verification against the stored hash. This component holds no secret
 * material — the server owns verification and issues the signed gate cookie.
 */

type ApiError = { error?: string; code?: string; missingVars?: string[] };

type GateStatus = {
  captchaConfigured: boolean;
  storageAvailable: boolean;
  questionConfigured: boolean;
  question: string | null;
};

type Feedback = { kind: "ok" | "error"; message: string } | null;

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY ?? "";
const DEVELOPER_PATH = "/developer";

export default function CreatorGateClient() {
  const router = useRouter();
  const [status, setStatus] = useState<GateStatus | null>(null);
  const [step, setStep] = useState<"captcha" | "secret-question">("captcha");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const [answer, setAnswer] = useState("");

  // Pure fetcher (no setState inside): the mount effect applies state only
  // after await, with a cancelled guard — consistent with project rules.
  const fetchStatus = useCallback(async (): Promise<GateStatus | null> => {
    try {
      const response = await fetch("/api/creator/gate");
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("captchaConfigured" in payload)) return null;
      return payload as GateStatus;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await fetchStatus();
      if (!cancelled) setStatus(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchStatus]);

  const submit = useCallback(
    async (fields: Record<string, string>, onSuccess: () => void) => {
      setSubmitting(true);
      setFeedback(null);
      try {
        const response = await fetch("/api/creator/gate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fields),
        });
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const code = payload && typeof payload === "object" && "code" in payload ? String((payload as ApiError).code) : "";
          const missingVars =
            payload && typeof payload === "object" && "missingVars" in payload
              ? ((payload as ApiError).missingVars ?? [])
              : [];
          const base =
            payload && typeof payload === "object" && "error" in payload
              ? String((payload as ApiError).error)
              : "Verifikasi gagal. Coba lagi.";
          const detail = code === "captcha_not_configured" || missingVars.length > 0
            ? ` (${missingVars.length > 0 ? missingVars.join(", ") : "CLOUDFLARE_TURNSTILE_SECRET_KEY"} belum diatur)`
            : "";
          setFeedback({ kind: "error", message: `${base}${detail}` });
          return;
        }
        onSuccess();
      } catch {
        setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  function onCaptchaSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = document.getElementById("cf-turnstile-response") as HTMLInputElement | null;
    const token = input?.value ?? "";
    if (!token) {
      setFeedback({ kind: "error", message: "Selesaikan verifikasi Bukan robot terlebih dahulu." });
      return;
    }
    void submit({ step: "captcha", token }, () => {
      setStep("secret-question");
      setFeedback(null);
    });
  }

  function onSecretSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!answer.trim()) {
      setFeedback({ kind: "error", message: "Masukkan jawaban." });
      return;
    }
    void submit({ step: "secret-question", answer: answer.trim() }, () => {
      router.push(DEVELOPER_PATH);
      router.refresh();
    });
  }

  if (status === null) {
    return (
      <p className="text-sm font-semibold text-[#20231f]/60" role="status">
        Memuat gate…
      </p>
    );
  }

  if (!status.storageAvailable) {
    return (
      <p className="text-sm font-semibold text-[#b3261e]" role="alert">
        Gate belum dapat memverifikasi pertanyaan rahasia (konfigurasi server belum lengkap). Hubungi pengelola
        lingkungan.
      </p>
    );
  }

  const inputClass =
    "w-full rounded-xl border border-[#20231f]/15 bg-white px-4 py-2.5 text-sm text-[#20231f] focus:border-brand-primary focus:outline-none";

  return (
    <div className="space-y-6">
      {step === "captcha" ? (
        <section className="rounded-2xl border border-[#20231f]/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Langkah 1 dari 2</p>
          <h2 className="mt-2 font-brand text-xl font-black text-[#20231f]">Bukan robot</h2>
          {status.captchaConfigured && TURNSTILE_SITE_KEY ? (
            <>
              <Script
                src="https://challenges.cloudflare.com/turnstile/v0/api.js"
                strategy="afterInteractive"
              />
              <form className="mt-4 space-y-4" onSubmit={onCaptchaSubmit}>
                <div
                  className="cf-turnstile"
                  data-sitekey={TURNSTILE_SITE_KEY}
                  data-theme="light"
                />
                <input type="hidden" id="cf-turnstile-response" name="cf-turnstile-response" />
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-xl bg-brand-primary px-4 py-2.5 text-xs font-black text-white transition hover:bg-[#0a5640] disabled:opacity-50"
                >
                  {submitting ? "Memverifikasi…" : "Verifikasi"}
                </button>
              </form>
              <p className="mt-3 text-xs leading-5 text-[#20231f]/50">
                Verifikasi dilakukan server-side melalui Cloudflare Turnstile. Checkbox palsu tidak diterima.
              </p>
            </>
          ) : (
            <div className="mt-4 rounded-xl border border-[#b3261e]/30 bg-[#b3261e]/10 px-4 py-3">
              <p className="text-sm font-semibold text-[#b3261e]">
                CAPTCHA belum terkonfigurasi — gate berstatus gagal-aman (tidak dapat dilanjutkan).
              </p>
              <p className="mt-2 text-xs leading-5 text-[#20231f]/60">
                Variabel yang diperlukan (server-only):{" "}
                <span className="font-mono">CLOUDFLARE_TURNSTILE_SECRET_KEY</span> dan{" "}
                <span className="font-mono">NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY</span> (site key,
                bukan secret). Tambahkan di Vercel → Settings → Environment Variables, lalu deploy ulang.
              </p>
            </div>
          )}
          {feedback ? (
            <p
              role="status"
              className={`mt-4 rounded-xl border px-3 py-2 text-xs font-semibold ${
                feedback.kind === "ok"
                  ? "border-[#1f6b3f]/30 bg-[#1f6b3f]/10 text-[#1f6b3f]"
                  : "border-[#b3261e]/30 bg-[#b3261e]/10 text-[#b3261e]"
              }`}
            >
              {feedback.message}
            </p>
          ) : null}
        </section>
      ) : (
        <section className="rounded-2xl border border-[#20231f]/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Langkah 2 dari 2</p>
          <h2 className="mt-2 font-brand text-xl font-black text-[#20231f]">Pertanyaan Rahasia</h2>
          {status.questionConfigured ? (
            <>
              <p className="mt-3 text-sm font-semibold text-[#20231f]">{status.question}</p>
              <form className="mt-4 space-y-3" onSubmit={onSecretSubmit}>
                <div>
                  <label className="block text-xs font-bold uppercase tracking-[0.14em] text-[#20231f]/50" htmlFor="gate-secret-answer">
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
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-xl bg-brand-primary px-4 py-2.5 text-xs font-black text-white transition hover:bg-[#0a5640] disabled:opacity-50"
                >
                  {submitting ? "Memverifikasi…" : "Buka Developer Center"}
                </button>
              </form>
              <p className="mt-3 text-xs leading-5 text-[#20231f]/50">
                Jawaban diverifikasi server-side terhadap hash tersimpan. Jawaban salah membuat Anda tetap di gate.
              </p>
            </>
          ) : (
            <div className="mt-4 rounded-xl border border-[#b3261e]/30 bg-[#b3261e]/10 px-4 py-3">
              <p className="text-sm font-semibold text-[#b3261e]">
                Pertanyaan rahasia belum diatur — gate berstatus gagal-aman (tidak dapat dilanjutkan).
              </p>
              <p className="mt-2 text-xs leading-5 text-[#20231f]/60">
                Atur melalui Developer Center → Keamanan Akun → Ganti Pertanyaan Rahasia setelah gate dapat
                dibuka, atau perbarui baris{" "}
                <span className="font-mono">creator_secret_question</span> melalui service tooling Creator.
              </p>
            </div>
          )}
          {feedback ? (
            <p
              role="status"
              className={`mt-4 rounded-xl border px-3 py-2 text-xs font-semibold ${
                feedback.kind === "ok"
                  ? "border-[#1f6b3f]/30 bg-[#1f6b3f]/10 text-[#1f6b3f]"
                  : "border-[#b3261e]/30 bg-[#b3261e]/10 text-[#b3261e]"
              }`}
            >
              {feedback.message}
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
