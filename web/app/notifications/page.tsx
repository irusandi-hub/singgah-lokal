import Link from "next/link";
import { redirect } from "next/navigation";
import SiteNav from "@/components/site-nav";
import NotificationInboxItem from "@/components/notification-inbox-item";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { listUserNotifications } from "@/lib/notification-service";

// Session data is read per request — never cached across users.
export const dynamic = "force-dynamic";

/**
 * Notification Inbox — the in-app notification center for the signed-in User
 * (MASTER 10 §9, §21: the in-app center is the mandatory MVP baseline).
 *
 * Server-side rules kept intact:
 * - signed-out visitors are redirected to the existing auth flow, so the inbox
 *   is never rendered (and never fetched) for an anonymous visitor;
 * - the list is the caller's own notifications only (service filters on the
 *   session actor; RLS is the authority), newest first;
 * - opening a notification sets read_at through the server route; nothing is
 *   stored in the browser, so a refresh always re-reads canonical state;
 * - destinations are existing routes only — a Place-scoped notification opens
 *   that Place page, everything else stays plain (no new Live route).
 */
export default async function NotificationsPage() {
  let notifications;

  try {
    const actor = await requireAuthenticatedActor(new Request("http://localhost/notifications"));
    notifications = await listUserNotifications(actor.userId);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      redirect("/auth?returnTo=%2Fnotifications");
    }
    throw error;
  }

  const unreadCount = notifications.filter((notification) => notification.readAt === null).length;

  return (
    <main className="min-h-screen bg-brand-cream text-brand-ink">
      <SiteNav />

      <section className="mx-auto max-w-4xl px-5 pb-12 pt-6">
        <div className="flex items-end justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Notifikasi</h1>
          <span className="text-xs font-bold text-black/45">
            {unreadCount > 0 ? `${unreadCount} belum dibaca` : "Semua sudah dibaca"}
          </span>
        </div>
        <p className="mt-2 text-sm text-black/55">
          Kabaran penting untuk akunmu, terbaru lebih dulu.
        </p>
        <p className="mt-1 text-xs text-black/45">
          Atur kategori notifikasi di{" "}
          <Link className="font-bold text-brand-accent underline-offset-2 hover:underline" href="/account/notifications">
            Notification Settings
          </Link>
          .
        </p>

        {notifications.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-black/10 bg-white p-8 text-center">
            <p className="text-sm font-bold">Belum ada notifikasi</p>
            <p className="mt-1 text-xs text-black/55">
              Ikuti sebuah Place agar kabaran Live-nya sampai ke sini.
            </p>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {notifications.map((notification) => (
              <NotificationInboxItem key={notification.id} notification={notification} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
