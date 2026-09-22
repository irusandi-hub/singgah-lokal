"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { isActiveNavSection } from "@/lib/navigation";
import ProducerNav from "./producer-nav";
import SignOutButton from "./sign-out-button";

type SiteNavProps = {
  // Optional server-derived auth state. When omitted the header probes
  // /api/auth/session itself, so any page can render <SiteNav /> and the
  // state stays correct after login, logout, refresh, and direct URLs.
  authenticated?: boolean;
};

const linkBase = "rounded-full px-3.5 py-1.5 text-xs font-bold transition";

// Tab active state derives from the current URL (usePathname), so it is
// correct on refresh, direct URLs, and back/forward — never click state.
export default function SiteNav({ authenticated: authenticatedProp }: SiteNavProps) {
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState<boolean | null>(authenticatedProp ?? null);

  useEffect(() => {
    if (authenticatedProp !== undefined) return;
    let cancelled = false;
    fetch("/api/auth/session")
      .then((response) => (response.ok ? response.json() : { authenticated: false }))
      .then((payload: { authenticated?: boolean }) => {
        if (!cancelled) setAuthenticated(Boolean(payload.authenticated));
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedProp]);

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-black/5 bg-[#f7f5ef]/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <Link href="/" className="block text-xl font-black tracking-tight">
            SINGGAH<span className="text-[#7b5b38]"> LOKAL</span>
          </Link>
          <div className="text-[10px] font-medium uppercase tracking-[0.2em] text-black/45">
            Temukan cerita di balik tempat
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <nav aria-label="Navigasi utama" className="hidden items-center gap-1 sm:flex">
            <Link
              href="/"
              aria-current={isActiveNavSection(pathname, "home") ? "page" : undefined}
              className={`${linkBase} ${
                isActiveNavSection(pathname, "home")
                  ? "bg-[#20231f] text-white"
                  : "text-black/60 hover:bg-black/5"
              }`}
            >
              Home
            </Link>
            <Link
              href="/live"
              aria-current={isActiveNavSection(pathname, "live") ? "page" : undefined}
              className={`${linkBase} ${
                isActiveNavSection(pathname, "live")
                  ? "bg-[#b3261e] text-white"
                  : "border border-[#b3261e]/40 bg-white text-[#b3261e]"
              }`}
            >
              LIVE
            </Link>
            {authenticated && (
              <Link
                href="/visit-intents"
                aria-current={isActiveNavSection(pathname, "visit-intents") ? "page" : undefined}
                className={`${linkBase} ${
                  isActiveNavSection(pathname, "visit-intents")
                    ? "bg-[#7b5b38] text-white"
                    : "border border-[#7b5b38]/40 bg-white text-[#7b5b38]"
                }`}
              >
                Visit Intent Saya
              </Link>
            )}
          </nav>

          {authenticated === null ? null : authenticated ? (
            <SignOutButton />
          ) : (
            <>
              <Link
                href="/auth/sign-up"
                className="hidden shrink-0 rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-bold text-black/70 transition hover:bg-black/5 sm:block"
              >
                Daftar
              </Link>
              <Link
                href="/auth"
                className="shrink-0 rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#7b5b38]"
              >
                Masuk
              </Link>
            </>
          )}
        </div>
      </div>
        </header>

      {/* Producer entry row — renders only when the server-derived membership
          probe says the signed-in user owns/manages a Place. */}
      <ProducerNav />
    </>
  );
}
