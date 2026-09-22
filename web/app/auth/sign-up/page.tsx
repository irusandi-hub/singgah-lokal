"use client";

import { FormEvent, Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { validateSignUpInput } from "@/lib/auth/sign-up";

const validationMessages: Record<string, string> = {
  fields_required: "Semua field wajib diisi.",
  email_invalid: "Format email tidak valid.",
  password_mismatch: "Password dan konfirmasi password harus sama.",
  password_too_short: "Password minimal 8 karakter.",
};

function SignUpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = form; otherwise the sign-up outcome shown as a clear status.
  const [created, setCreated] = useState<{ authenticated: boolean; needsEmailConfirmation: boolean } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    const input = { name, email, password, passwordConfirmation };
    const validationError = validateSignUpInput(input);
    if (validationError) {
      setError(validationMessages[validationError] ?? "Data pendaftaran belum benar.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, passwordConfirmation }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok || result?.created !== true) {
        setError(
          typeof result?.error === "string" && result.error in validationMessages
            ? validationMessages[result.error]
            : "Pendaftaran gagal. Coba lagi nanti.",
        );
        return;
      }

      setCreated({
        authenticated: Boolean(result.authenticated),
        needsEmailConfirmation: Boolean(result.needsEmailConfirmation),
      });
    } catch {
      setError("Pendaftaran gagal. Periksa koneksi dan coba lagi.");
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-[#f7f5ef] px-5 py-10 text-[#20231f]">
        <div className="w-full max-w-md">
          <Link className="text-sm font-bold text-[#7b5b38]" href="/">
            ← Beranda
          </Link>
          <div className="mt-8 rounded-2xl border border-[#7b5b38]/25 bg-[#fffaf0] p-6">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Akun dibuat</p>
            <h1 className="mt-2 text-2xl font-black tracking-tight">Pendaftaran berhasil.</h1>

            {created.needsEmailConfirmation ? (
              <p className="mt-3 text-sm leading-6 text-black/70">
                Kami mengirim email verifikasi ke <strong>{email.trim()}</strong>. Buka email tersebut
                untuk mengaktifkan akun, lalu masuk lewat halaman Masuk.
              </p>
            ) : (
              <p className="mt-3 text-sm leading-6 text-black/70">
                Akun sudah aktif dan dapat langsung dipakai masuk.
              </p>
            )}

            {/* Role boundary: a new account is a normal user. Producer access
                is provisioned by the platform (producer_memberships), never
                granted from this form. */}
            <div className="mt-4 rounded-xl bg-white p-4 text-sm leading-6 text-black/70">
              <p className="font-bold">Ingin jadi Producer?</p>
              <p className="mt-1">
                Akses Producer tidak otomatis. Hubungi admin platform untuk verifikasi Place dan
                pemberian membership Producer. Setelah membership aktif, area Producer muncul
                otomatis saat kamu masuk.
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                router.push(returnTo === "/" ? "/auth" : `/auth?returnTo=${encodeURIComponent(returnTo)}`);
                router.refresh();
              }}
              className="mt-5 w-full rounded-2xl bg-[#20231f] py-3.5 text-sm font-bold text-white"
            >
              Lanjut ke halaman Masuk
            </button>
            <Link href="/" className="mt-3 block text-center text-xs font-bold text-black/55">
              Kembali ke beranda
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#f7f5ef] px-5 py-10 text-[#20231f]">
      <div className="w-full max-w-md">
        <Link className="text-sm font-bold text-[#7b5b38]" href="/">
          ← Beranda
        </Link>

        <header className="mt-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">SINGGAH LOKAL</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">Daftar akun</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Buat akun untuk mengirim Visit Intent ke Producer. Akses Producer diberikan terpisah
            oleh admin platform.
          </p>
        </header>

        <form
          className="mt-8 rounded-2xl border border-[#7b5b38]/25 bg-[#fffaf0] p-6"
          onSubmit={handleSubmit}
        >
          <label className="block text-sm font-semibold" htmlFor="name">
            Nama
            <input
              className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal"
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="mt-4 block text-sm font-semibold" htmlFor="email">
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
            <input
              className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal"
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>

          <label className="mt-4 block text-sm font-semibold" htmlFor="passwordConfirmation">
            Konfirmasi password
            <input
              className="mt-1 w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-normal"
              id="passwordConfirmation"
              name="passwordConfirmation"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={passwordConfirmation}
              onChange={(event) => setPasswordConfirmation(event.target.value)}
            />
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
            {submitting ? "Memproses…" : "Daftar"}
          </button>

          <p className="mt-4 text-center text-xs leading-5 text-black/55">
            Sudah punya akun?{" "}
            <Link className="font-bold text-[#7b5b38] underline-offset-2 hover:underline" href="/auth">
              Masuk di sini
            </Link>
          </p>
        </form>
      </div>
    </main>
  );
}

export default function SignUpPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[#f7f5ef] text-[#20231f]">
          <p className="text-sm font-semibold text-black/60">Memuat…</p>
        </main>
      }
    >
      <SignUpForm />
    </Suspense>
  );
}
