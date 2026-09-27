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
 * - the count is fetched on mount, on route change, and on the existing
 *   session-changed/pageshow events — the same event-driven pattern the
 *   header session probe already uses. That refresh alone left the badge
 *   stale whenever an event arrived while the tab was open, so the bell now
 *   ALSO listens on the recipient's own private Realtime topic: the database
 *   broadcasts an 'unread' signal when a notification is created and when the
 *   recipient marks one read, and the badge updates with no refresh;
 * - Realtime is display transport only (MASTER 10 §9/§21): the count itself is
 *   still the canonical RLS-scoped number, the signal only says "re-read it".
 *   There is NO polling and no database subscription as a fallback, and a
 *   denied channel join tears itself down instead of degrading;
 * - a real <a href> (keyboard accessible) that opens the inbox; it never
 *   blocks the user with a click handler.
 */

/** Private Realtime topic of the signed-in user. The database broadcasts the
 *  unread signal on `notifications:{userId}`; the RLS policy in migration
 *  0029 only lets a session receive on the topic built from its own
 *  auth.uid(), so no user can listen to anybody else's notifications. */
function unreadTopic(userId: string): string {
  return `notifications:${userId}`;
}

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
  const [sessionVersion, setSessionVersion] = useState(0);
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

  // Sign-in/sign-out re-opens the private topic for the new session, so the
  // bell can never keep listening as the previous account.
  useEffect(() => {
    function onSessionChange() {
      setSessionVersion((version) => version + 1);
    }
    window.addEventListener(SESSION_CHANGED_EVENT, onSessionChange);
    return () => window.removeEventListener(SESSION_CHANGED_EVENT, onSessionChange);
  }, []);

  // Realtime unread (MASTER 10 §9): join the recipient's own private channel
  // and apply the unread count the database broadcast. Fail closed on a denied
  // join — there is no pseudo-public channel and no polling fallback, so an
  // unauthorized or failed subscription simply leaves the fetch-driven badge.
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;

    let client: Awaited<ReturnType<typeof import("@supabase/supabase-js").createClient>> | null = null;
    let cancelled = false;

    (async () => {
      // The token endpoint returns the caller's OWN access token and user id
      // (no other session, no roles, no memberships), which is exactly what the
      // private-channel join needs.
      let accessToken: string | null = null;
      let userId: string | null = null;
      try {
        const response = await fetch("/api/auth/realtime-token", { cache: "no-store" });
        if (response.ok) {
          const payload = (await response.json()) as { accessToken?: unknown; userId?: unknown };
          if (typeof payload.accessToken === "string") accessToken = payload.accessToken;
          if (typeof payload.userId === "string" && payload.userId) userId = payload.userId;
        }
      } catch {
        return;
      }
      if (cancelled || !accessToken || !userId) return;

      const { createBrowserClient } = await import("@supabase/ssr");
      client = createBrowserClient(url, key, {
        realtime: { params: { eventsPerSecond: 5 } },
        accessToken: async () => accessToken,
      });
      if (cancelled) {
        void client.removeAllChannels();
        client = null;
        return;
      }

      const channel = client.channel(unreadTopic(userId), {
        config: { private: true, broadcast: { self: false } },
      });
      channel.on("broadcast", { event: "unread" }, (message: { payload?: { unreadCount?: unknown } }) => {
        const next = Number(message?.payload?.unreadCount);
        if (Number.isFinite(next) && next >= 0) {
          setUnreadCount(Math.floor(next));
        }
      });
      channel.subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          void client?.removeAllChannels();
          client = null;
        }
      });
    })();

    return () => {
      cancelled = true;
      // Full teardown of the dynamic client: channels AND socket, so no stale
      // listener survives a sign-out, a session change, or an unmount.
      if (client) {
        void client.removeAllChannels();
        client = null;
      }
    };
  }, [sessionVersion]);

  return <NotificationBellLink unreadCount={unreadCount} />;
}
