"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SESSION_CHANGED_EVENT } from "@/lib/session-events";
import { isActiveNavSection } from "@/lib/navigation";
import AccountMenu from "./account-menu";
import BrandLogo from "./brand-logo";
import NotificationBell from "./notification-bell";

type SiteNavProps = {
  // Optional server-derived auth state. When omitted the header probes
  // /api/auth/session itself, so any page can render <SiteNav /> and the
  // state stays correct after login, logout, refresh, and direct URLs.
  authenticated?: boolean;
};

type SessionPayload = {
  authenticated?: boolean;
  email?: string | null;
};

const linkBase = "rounded-full px-3.5 py-1.5 text-xs font-bold transition";

// Main app header. Role dashboards (Producer / Platform Admin / Developer)
// are NOT menu items here: each area is a separate layer, reached through
// Kelola Akun (/account), which resolves authority server-side. The header
// shows the active account's email aligned with the account controls.
export default function SiteNav({ authenticated: authenticatedProp }: SiteNavProps) {
  const pathname = usePathname();
  const [session, setSession] = useState<SessionPayload | null>(
    authenticatedProp === undefined ? null : { authenticated: authenticatedProp, email: null },
  );

  useEffect(() => {
    if (authenticatedProp !== undefined) return;
    let cancelled = false;
    fetch("/api/auth/session")
      .then((response) => (response.ok ? response.json() : { authenticated: false, email: null }))
      .then((payload: SessionPayload) => {
        if (!cancelled) setSession(payload);
      })
      .catch(() => {
        if (!cancelled) setSession({ authenticated: false, email: null });
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedProp]);

  // Session flips without a remount in two real mobile cases: Sign Out from
  // the account menu while already on this page, and a bfcache restore of a
  // page restored with a dead session. Both re-probe the session here so the
  // header shows the signed-out state immediately — no manual refresh.
  useEffect(() => {
    if (authenticatedProp !== undefined) return;
    function probe() {
      fetch("/api/auth/session")
        .then((response) => (response.ok ? response.json() : { authenticated: false, email: null }))
        .then((payload: SessionPayload) => setSession(payload))
        .catch(() => setSession({ authenticated: false, email: null }));
    }
    function onPagesShow(event: PageTransitionEvent) {
      if (event.persisted) probe();
    }
    window.addEventListener(SESSION_CHANGED_EVENT, probe);
    window.addEventListener("pageshow", onPagesShow);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, probe);
      window.removeEventListener("pageshow", onPagesShow);
    };
  }, [authenticatedProp]);

  const authenticated = session?.authenticated === true;

  return (
    <header className="sticky top-0 z-30 border-b border-black/5 bg-brand-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <Link href="/" className="flex min-h-[40px] items-center" aria-label="SINGGAH LOKAL — beranda">
            <BrandLogo height={40} tagline="Temukan cerita di balik tempat" />
          </Link>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <nav aria-label="Navigasi utama" className="hidden items-center gap-1 sm:flex">
            <Link
              href="/"
              aria-current={isActiveNavSection(pathname, "home") ? "page" : undefined}
              className={`${linkBase} ${
                isActiveNavSection(pathname, "home")
                  ? "bg-brand-primary text-white"
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
                  ? "bg-live text-white"
                  : "border border-live/40 bg-white text-live"
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
                    ? "bg-brand-accent text-white"
                    : "border border-brand-accent/40 bg-white text-brand-accent"
                }`}
              >
                Visit Intent Saya
              </Link>
            )}
          </nav>

          {session === null ? null : authenticated ? (
            // Single ☰ entry point after sign in: email, Kelola Akun, and
            // Sign Out no longer sit in the header itself. Header session
            // state re-probes on sign-out and bfcache restores (see above).
            // Notification bell (signed-in only, unread badge from the
            // caller's own unread notifications) sits beside it — an additive
            // entry point, no existing nav item moved or replaced.
            <>
              <NotificationBell />
              <AccountMenu />
            </>
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
                className="shrink-0 rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-primary-deep"
              >
                Masuk
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
