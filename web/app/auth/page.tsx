"use client";

import { FormEvent, Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { sanitizeReturnTo } from "@/lib/auth/return-to";

/**
 * Auth page for the existing backend (backend auth already exists:
 * /api/auth/sign-in + /api/auth/sign-out). No new auth system is introduced.
 *
 * returnTo is validated before navigation via lib/auth/return-to (unit-tested
 * open-redirect guard): only same-origin, single-hop, absolute-path
 * destinations are accepted; everything else falls back to Home.
 *
 * This page only signs users in. Registration/role provisioning is a separate
 * operational flow and is intentionally out of scope here (no invented flows).
 */

function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the validated destination reachable for the flow tests.
  useEffect(() => {
    if (returnTo !== "/") {
      window.sessionStorage.setItem("singgah_returnTo", returnTo);
    }
  }, [returnTo]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (!email.trim() || !password) {
      setError("Email dan password wajib diisi.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        if (response.status === 401) {
          setError("Email atau password salah.");
        } else if (response.status === 503) {
          setError("Layanan autentikasi sedang tidak tersedia. Coba lagi nanti.");
        } else {
          setError("Login gagal. Silakan coba lagi.");
        }
        return;
      }

      if (result?.authenticated !== true) {
        setError("Login gagal. Silakan coba lagi.");
        return;
      }

      // Session cookie is set by the API route (Supabase SSR helper).
      router.replace(returnTo);
      router.refresh();
    } catch {
      setError("Login gagal. Periksa koneksi dan coba lagi.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#f7f5ef] px-5 py-10 text-[#20231f]">
      <div className="w-full max-w-md">
        <Link className="text-sm font-bold text-[#7b5b38]" href="/">
          ← Beranda
        </Link>

        <header className="mt-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">SINGGAH LOKAL</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">Masuk</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Masuk untuk mengirim Visit Intent atau mengelola Place-mu. Niat berkunjung
            dikirim ke Producer — bukan pembayaran.
          </p>
        </header>

        <form
          className="mt-8 rounded-2xl border border-[#7b5b38]/25 bg-[#fffaf0] p-6"
          onSubmit={handleSubmit}
        >
          <label className="block text-sm font-semibold" htmlFor="email">
            Email
            <input
              className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal"
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>

          <label className="mt-4 block text-sm font-semibold" htmlFor="password">
            Password
            <span className="relative mt-1 block">
              <input
                className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 pr-11 font-normal"
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                aria-label={showPassword ? "Sembunyikan password" : "Tampilkan password"}
                aria-pressed={showPassword}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-black/45 transition hover:bg-black/5 hover:text-black/70"
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
              >
                <svg aria-hidden fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
                  {showPassword ? (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" x2="23" y1="1" y2="23" />
                    </>
                  ) : (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
              </button>
            </span>
          </label>

          {error ? (
            <p className="mt-4 text-sm font-semibold text-red-700" role="alert">
              {error}
            </p>
          ) : null}

          <button
            className="mt-6 w-full rounded-2xl bg-[#20231f] py-4 text-sm font-bold text-white disabled:opacity-60"
            disabled={submitting}
            type="submit"
          >
            {submitting ? "Memproses…" : "Masuk"}
          </button>

          <p className="mt-4 text-center text-xs leading-5 text-black/55">
            Belum punya akun?{" "}
            <Link className="font-bold text-[#7b5b38] underline-offset-2 hover:underline" href="/auth/sign-up">
              Daftar di sini
            </Link>
          </p>
          <p className="mt-2 text-center text-xs leading-5 text-black/45">
            Akses Producer tidak otomatis — setelah mendaftar, admin platform memberikan
            membership Producer. Area Producer muncul sendiri saat membership aktif.{" "}
            <Link className="font-bold text-[#7b5b38] underline underline-offset-2" href="/producer/onboarding">
              Ajukan menjadi Producer
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={
      <main className="flex min-h-screen items-center justify-center bg-[#f7f5ef] text-[#20231f]">
        <p className="text-sm font-semibold text-black/60">Memuat…</p>
      </main>
    }>
      <AuthForm />
    </Suspense>
  );
}
