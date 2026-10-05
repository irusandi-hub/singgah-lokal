"use client";

import type { MouseEvent } from "react";
import { useState } from "react";

/**
 * Google OAuth entry point shared by the Masuk and Daftar pages.
 *
 * Starts the EXISTING Supabase Auth Google provider flow via
 * /api/auth/oauth/google (same SSR client / session cookies as email+password
 * login — no parallel account system). It stays selectable beside the
 * email/password form and only changes its own label.
 *
 * Duplicate-submit safety: a click is ignored while a request is in flight,
 * the button is disabled, and the parent is told it is busy so the
 * email/password submit is disabled too.
 */
export type GoogleAuthButtonProps = {
  label: string;
  returnTo: string;
  disabled?: boolean;
  onError: (message: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
};

function GoogleGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 18 18" width="18" height="18" className="shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

export default function GoogleAuthButton({
  label,
  returnTo,
  disabled = false,
  onError,
  onPendingChange,
}: GoogleAuthButtonProps) {
  const [pending, setPending] = useState(false);

  function setBusy(next: boolean) {
    setPending(next);
    onPendingChange?.(next);
  }

  async function startGoogle(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (pending || disabled) return;
    onError(null);
    setBusy(true);

    try {
      const response = await fetch("/api/auth/oauth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok || typeof result?.url !== "string" || !result.url.startsWith("https://")) {
        onError("Layanan masuk dengan Google sedang tidak tersedia. Coba lagi nanti.");
        setBusy(false);
        return;
      }

      // Hand off to Google; the browser returns to /auth/callback.
      window.location.assign(result.url);
    } catch {
      onError("Tidak bisa memulai masuk dengan Google. Periksa koneksi dan coba lagi.");
      setBusy(false);
    }
  }

  const blocked = pending || disabled;

  return (
    <button
      type="button"
      onClick={startGoogle}
      disabled={blocked}
      aria-busy={pending}
      className="flex w-full items-center justify-center gap-3 rounded-2xl border border-black/12 bg-white py-3.5 text-sm font-bold text-brand-ink transition hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <GoogleGlyph />
      <span>{pending ? "Menghubungkan ke Google…" : label}</span>
    </button>
  );
}
