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

/** Limited info about the currently active Creator session (masked id only). */
type LeaseBlocked = { maskedId: string | null; expiresIso: string | null };

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_CLOUDFLARE_TURNSTILE_SITE_KEY ?? "";
const DEVELOPER_PATH = "/developer";

export default function CreatorGateClient() {
  const router = useRouter();
  const [status, setStatus] = useState<GateStatus | null>(null);
  const [step, setStep] = useState<"captcha" | "secret-question">("captcha");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [submitting, setSubmitting] = useState(false);
  const [answer, setAnswer] = useState("");
  const [leaseBlocked, setLeaseBlocked] = useState<LeaseBlocked | null>(null);

  // Pure fetcher (no setState inside): the mount effect applies state only
  // after await, with a cancelled guard — consistent with project rules.
  const fetchStatus = useCallback(
    async (): Promise<
      | { kind: "status"; status: GateStatus }
      | { kind: "lease-blocked"; blocked: LeaseBlocked }
      | { kind: "unavailable" }
    > => {
      try {
        const response = await fetch("/api/creator/gate");
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          if (
            payload &&
            typeof payload === "object" &&
            "code" in payload &&
            (payload as ApiError).code === "creator_session_active"
          ) {
            const p = payload as { activeHolderMaskedId?: string | null; activeExpiresIso?: string | null };
            return {
              kind: "lease-blocked",
              blocked: { maskedId: p.activeHolderMaskedId ?? null, expiresIso: p.activeExpiresIso ?? null },
            };
          }
          return { kind: "unavailable" };
        }
        if (!payload || typeof payload !== "object" || !("captchaConfigured" in payload)) {
          return { kind: "unavailable" };
        }
        return { kind: "status", status: payload as GateStatus };
      } catch {
        return { kind: "unavailable" };
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchStatus();
      if (cancelled) return;
      if (result.kind === "status") setStatus(result.status);
      else if (result.kind === "lease-blocked") setLeaseBlocked(result.blocked);
      else setStatus(null);
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
          if (code === "creator_session_active") {
            const p = payload as { activeHolderMaskedId?: string | null; activeExpiresIso?: string | null };
            setLeaseBlocked({ maskedId: p.activeHolderMaskedId ?? null, expiresIso: p.activeExpiresIso ?? null });
            return;
          }
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

  // Official Turnstile flow: the widget renders an isolated form with its own
  // "cf-turnstile-response" input inside; reading the submitted FormData
  // (or the Turnstile callback state) is the supported way to get the token.
  // No hand-rolled hidden input is used.
  function onCaptchaSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const token = String(formData.get("cf-turnstile-response") ?? "").trim();
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

  if (leaseBlocked) {
    return (
      <section className="rounded-2xl border border-[#20231f]/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Single Active Session</p>
        <h2 className="mt-2 font-brand text-xl font-black text-[#20231f]">Sesi Creator lain sedang aktif</h2>
        <p className="mt-3 text-sm leading-6 text-[#20231f]/60">
          Slot Creator sedang digunakan oleh sesi lain. Identitas aktif (terbatas):{" "}
          <span className="font-mono font-semibold text-[#20231f]">{leaseBlocked.maskedId ?? "••••"}</span>.
        </p>
        {leaseBlocked.expiresIso ? (
          <p className="mt-2 text-xs leading-5 text-[#20231f]/55">
            Slot berakhir otomatis pada {new Date(leaseBlocked.expiresIso).toLocaleString("id-ID")} — atau lebih cepat
            bila sesi aktif tersebut logout.
          </p>
        ) : null}
        <p className="mt-3 text-xs leading-5 text-[#20231f]/55">
          CAPTCHA dan Pertanyaan Rahasia tidak diminta selama slot masih dipegang sesi lain.
        </p>
        <button
          type="button"
          disabled={submitting}
          onClick={() => {
            void (async () => {
              setSubmitting(true);
              const result = await fetchStatus();
              if (result.kind === "status") {
                setLeaseBlocked(null);
                setStatus(result.status);
              } else if (result.kind === "lease-blocked") {
                setLeaseBlocked(result.blocked);
              }
              setSubmitting(false);
            })();
          }}
          className="mt-4 rounded-xl bg-brand-primary px-4 py-2.5 text-xs font-black text-white transition hover:bg-[#0a5640] disabled:opacity-50"
        >
          Muat ulang status
        </button>
      </section>
    );
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
