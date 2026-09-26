"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { SESSION_CHANGED_EVENT } from "@/lib/session-events";
import { formatUnreadBadge, notificationBellLabel } from "@/lib/notifications-model";

/**
 * Header notification entry point (MASTER 10 §9 unread count/badge).
 *
 * - one bell in the existing header, only for a signed-in user;
 * - the bell is always visible, the badge only when unread > 0 (0 → none,
 *   1–99 → the number, 100+ → "99+");
 * - the count comes from the signed-in user's own unread notifications
 *   (GET /api/notifications → notifications where read_at IS NULL); a
 *   signed-out request answers 401 and the bell then stays badge-free;
 * - NO polling and NO realtime: the count is fetched on mount, on route
 *   change, and on the existing session-changed/pageshow events — the same
 *   event-driven pattern the header session probe already uses;
 * - a real <a href> (keyboard accessible) that opens the inbox; it never
 *   blocks the user with a click handler.
 */

export function NotificationBellLink({ unreadCount }: { unreadCount: number }) {
  const badge = formatUnreadBadge(unreadCount);

  return (
    <Link
      href="/notifications"
      aria-label={notificationBellLabel(unreadCount)}
      className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white text-brand-ink transition hover:bg-brand-primary hover:text-white"
    >
      <svg
        aria-hidden
        fill="none"
        height="18"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
        width="18"
      >
        <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      {badge ? (
        <span
          data-testid="notification-unread-badge"
          className="absolute -right-1 -top-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-live px-1 text-[10px] font-bold leading-[18px] text-white"
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

export default function NotificationBell() {
  const [unreadCount, setUnreadCount] = useState(0);
  const pathname = usePathname();

  const load = useCallback(() => {
    let cancelled = false;
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => {
        if (cancelled) return null;
        // 401 = signed out: no badge, no notification data is kept client-side.
        if (response.status === 401) return { unreadCount: 0 };
        if (!response.ok) throw new Error("Notifications unavailable");
        return response.json() as Promise<{ unreadCount?: number }>;
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        const next = Number(payload.unreadCount);
        setUnreadCount(Number.isFinite(next) && next > 0 ? next : 0);
      })
      .catch(() => {
        if (!cancelled) setUnreadCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mount + route change (e.g. back from the inbox after marking read).
  useEffect(() => load(), [load, pathname]);

  // Sign-in/sign-out and bfcache restores, mirroring the header session probe.
  useEffect(() => {
    function onSessionChange() {
      load();
    }
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) load();
    }
    window.addEventListener(SESSION_CHANGED_EVENT, onSessionChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener(SESSION_CHANGED_EVENT, onSessionChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [load]);

  return <NotificationBellLink unreadCount={unreadCount} />;
}
