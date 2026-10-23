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
  /**
   * PRESENTATION ONLY (MOCKUP §1/§5, 2026-10-01): the header floats over
   * the Home map instead of sitting on its own opaque cream bar. It changes
   * the header's own classes and nothing else — the logo lockup, the nav
   * links, the session probe, the auth entry points, and every route are
   * byte-for-byte the same. Off by default, so every other page keeps the
   * existing solid header.
   */
  floating?: boolean;
  /**
   * Home-only gesture-help entry point. When provided, the "?" control sits in
   * the header row immediately left of the notification bell (or left of the
   * signed-out auth buttons); when omitted, no control is rendered. The panel
   * itself, its copy, and its focus return are owned by the caller.
   */
  onShowGestureHint?: () => void;
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
export default function SiteNav({
  authenticated: authenticatedProp,
  floating = false,
  onShowGestureHint,
}: SiteNavProps) {
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
    // MOCKUP §1/§5: the floating variant is transparent and sits INSIDE the
    // map's stacking context (z-1200, above the map surface and its control
    // ceiling) so no tile can ever paint over the logo or the Masuk button.
    // The solid variant is the existing header, unchanged.
    <header
      className={
        floating
          ? "absolute inset-x-0 top-0 z-[1200] border-b-0 bg-transparent"
          : "sticky top-0 z-30 border-b border-black/5 bg-brand-cream/95 backdrop-blur"
      }
    >
      <div
        className={`mx-auto flex max-w-6xl items-center justify-between gap-3 ${
          floating ? "px-4 py-3" : "px-5 py-3"
        }`}
      >
        <div className="min-w-0">
          {/* MOCKUP §1: the logo floats directly on the map, so it carries a
              soft white halo for contrast on busy tiles. Purely a filter on
              the EXISTING master lockup — its shape, colors, ratio, and
              tagline are untouched. */}
          <Link
            href="/"
            className={`relative flex min-h-[40px] items-center ${
              floating ? "drop-shadow-[0_1px_3px_rgb(255_255_255/0.95)]" : ""
            }`}
            aria-label="SINGGAH LOKAL — beranda"
          >
            {/* SOFT WHITE WASH BEHIND THE LOGO (2026-10-23) — a thin gradient
                layer, not a card: it gives the lockup a calm surface over busy
                map tiles without changing the logo's size, ratio, colours, or
                the header's layout. Only the floating Home header needs it. */}
            {floating ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -inset-x-3 -inset-y-1 rounded-full bg-[linear-gradient(90deg,rgb(255_255_255/0.92)_0%,rgb(255_255_255/0.72)_58%,rgb(255_255_255/0)_100%)] blur-[0.5px]"
              />
            ) : null}
            <span className="relative">
              <BrandLogo height={40} tagline="Temukan cerita di balik tempat" />
            </span>
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
              Beranda
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
                Kunjungan Saya
              </Link>
            )}
          </nav>

          {/* GESTURE HELP (2026-10-23): moved out of the map's old control
              column into the header row, immediately left of the bell (or of
              the signed-out auth buttons). Same 40px visual size as the bell;
              an out-of-flow span keeps the touch target at 44px. The handler,
              the label, and the panel are unchanged. */}
          {onShowGestureHint ? (
            <button
              type="button"
              data-gesture-hint-recall
              onClick={onShowGestureHint}
              title="Petunjuk gestur peta"
              aria-label="Tampilkan petunjuk gestur peta"
              className="relative inline-flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full border border-black/10 bg-white text-brand-ink shadow-[0_1px_3px_rgb(0_0_0/0.06)] transition hover:bg-brand-cream active:scale-95"
            >
              <span aria-hidden className="pointer-events-auto absolute -inset-1" />
              <span aria-hidden className="text-[15px] font-bold leading-none">?</span>
            </button>
          ) : null}

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
                className="inline-flex h-9 shrink-0 items-center rounded-full bg-brand-primary px-4 text-[13px] font-bold text-white transition hover:bg-brand-primary-deep sm:h-10 sm:px-5 sm:text-sm"
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
