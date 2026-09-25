"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { broadcastSessionChanged } from "@/lib/session-events";

/**
 * Real logout through the existing backend endpoint. After the server
 * confirms the session is gone, feedback is shown ("Berhasil keluar."), the
 * router cache is refreshed so every server-rendered surface flips to the
 * unauthenticated state, and the user lands on Home already signed out.
 * Variants: header pill and account-menu item — same mechanism, no new auth.
 */
export default function SignOutButton({ variant = "header" }: { variant?: "header" | "menu-item" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setSuccess(false);
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) {
        setSuccess(false);
        setPending(false);
        return;
      }
      // Server confirmed sign-out (unauthenticated session). Show feedback,
      // notify every live auth-state surface (header included) to re-probe,
      // and only then leave the authenticated view.
      setSuccess(true);
      broadcastSessionChanged();
      router.push("/");
      router.refresh();
    } catch {
      setSuccess(false);
      setPending(false);
      return;
    }
  }

  if (variant === "menu-item") {
    return (
      <button
        type="button"
        role="menuitem"
        onClick={signOut}
        disabled={pending}
        aria-live="polite"
        className="w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-brand-ink hover:bg-brand-cream disabled:opacity-50"
      >
        {pending ? "Keluar…" : success ? "Berhasil keluar." : "Sign Out"}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2" aria-live="polite">
      {success ? (
        <span className="text-xs font-semibold text-brand-primary" role="status">
          Berhasil keluar.
        </span>
      ) : null}
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black/70 hover:bg-black/5 disabled:opacity-50"
      >
        {pending ? "Keluar…" : "Keluar"}
      </button>
    </span>
  );
}
