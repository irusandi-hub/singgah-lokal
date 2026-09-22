"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Real logout through the existing backend endpoint; after success the router
// cache is refreshed so every server-rendered surface flips to the
// unauthenticated state.
export default function SignOutButton({ dark = false }: { dark?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST" });
      router.push("/");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className={
        dark
          ? "rounded-full border border-white/20 px-3 py-1.5 text-xs font-bold text-white/80 hover:bg-white/10 disabled:opacity-50"
          : "rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-black text-black/70 hover:bg-black/5 disabled:opacity-50"
      }
    >
      {pending ? "Keluar..." : "Sign out"}
    </button>
  );
}
