"use client";

import type { MouseEvent } from "react";
import { useState } from "react";

/**
 * Apple OAuth entry point shared by the Masuk and Daftar pages.
 *
 * Starts the existing Supabase Auth Apple provider flow via
 * /api/auth/oauth/apple (same SSR client / session cookies as email+password
 * and Google — no parallel account system). It stays selectable beside Google
 * and the email/password form and only changes its own label.
 *
 * Duplicate-submit safety: a click is ignored while a request is in flight,
 * the button is disabled, and the parent is told it is busy so the other auth
 * options are disabled too.
 */
export type AppleAuthButtonProps = {
  label: string;
  returnTo: string;
  disabled?: boolean;
  onError: (message: string | null) => void;
  onPendingChange?: (pending: boolean) => void;
};

function AppleGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" className="shrink-0">
      <path
        fill="currentColor"
        d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"
      />
    </svg>
  );
}

export default function AppleAuthButton({
  label,
  returnTo,
  disabled = false,
  onError,
  onPendingChange,
}: AppleAuthButtonProps) {
  const [pending, setPending] = useState(false);

  function setBusy(next: boolean) {
    setPending(next);
    onPendingChange?.(next);
  }

  async function startApple(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (pending || disabled) return;
    onError(null);
    setBusy(true);

    try {
      const response = await fetch("/api/auth/oauth/apple", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnTo }),
      });
      const result = await response.json().catch(() => null);

      if (!response.ok || typeof result?.url !== "string" || !result.url.startsWith("https://")) {
        onError("Layanan masuk dengan Apple sedang tidak tersedia. Coba lagi nanti.");
        setBusy(false);
        return;
      }

      // Hand off to Apple; the browser returns to /auth/callback (which
      // carries the provider through for provider-correct error copy).
      window.location.assign(result.url);
    } catch {
      onError("Tidak bisa memulai masuk dengan Apple. Periksa koneksi dan coba lagi.");
      setBusy(false);
    }
  }

  const blocked = pending || disabled;

  return (
    <button
      type="button"
      onClick={startApple}
      disabled={blocked}
      aria-busy={pending}
      className="flex w-full items-center justify-center gap-3 rounded-2xl border border-black/12 bg-white py-3.5 text-sm font-bold text-brand-ink transition hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <AppleGlyph />
      <span>{pending ? "Menghubungkan ke Apple…" : label}</span>
    </button>
  );
}
