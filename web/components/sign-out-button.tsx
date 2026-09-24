"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Real logout through the existing backend endpoint; after success the router
// cache is refreshed so every server-rendered surface flips to the
// unauthenticated state. Rendered inside the main app header next to the
// account email and Kelola Akun.
export default function SignOutButton() {
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
      className="rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-semibold text-black/70 hover:bg-black/5 disabled:opacity-50"
    >
      {pending ? "Keluar…" : "Keluar"}
    </button>
  );
}
