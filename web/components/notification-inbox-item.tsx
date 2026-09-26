"use client";

import Link from "next/link";
import { useState } from "react";
import { resolveNotificationHref, type NotificationItem } from "@/lib/notifications-model";

/**
 * One inbox row. Clicking it marks the notification read through the server
 * route (POST /api/notifications/:id/read) and, when an existing route exists
 * for the referenced Place, navigates to it. Notifications without a known
 * target stay a plain button — no invented destination (MASTER 10 §9:
 * expired/unknown targets must resolve gracefully).
 *
 * read state comes from the server payload; the local flip only reflects the
 * server's own response, so a refresh restores the canonical state.
 */
export default function NotificationInboxItem({ notification }: { notification: NotificationItem }) {
  const [read, setRead] = useState(notification.readAt !== null);
  const [busy, setBusy] = useState(false);
  const href = resolveNotificationHref(notification);

  async function markRead() {
    if (read || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/notifications/${notification.id}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (response.ok) setRead(true);
    } finally {
      setBusy(false);
    }
  }

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold">{notification.title}</p>
        {!read ? (
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-live" aria-label="Belum dibaca" />
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-5 text-black/60">{notification.body}</p>
      <p className="mt-1 text-[11px] font-medium text-black/45">
        {formatNotificationTimestamp(notification.createdAt)}
      </p>
    </>
  );

  const className = `block rounded-2xl border p-4 text-left transition ${
    read ? "border-black/10 bg-white" : "border-live/40 bg-[#fdf6f2]"
  }`;

  if (href) {
    return (
      <Link
        href={href}
        onClick={() => {
          void markRead();
        }}
        className={className}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        void markRead();
      }}
      disabled={busy}
      className={`${className} w-full disabled:opacity-70`}
    >
      {content}
    </button>
  );
}

function formatNotificationTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  // Delivery timestamp of the notification for the reader's own locale. The
  // locked "Place timezone" rule applies to Place schedules and Visit Intent
  // times (AGENTS.md), not to when a notification was created, so no timezone
  // is asserted here.
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}
