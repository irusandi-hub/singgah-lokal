import Link from "next/link";
import { redirect } from "next/navigation";
import SiteNav from "@/components/site-nav";
import NotificationSettingsForm from "@/components/notification-settings-form";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { readUserNotificationPreferences } from "@/lib/notification-service";

// Session data is read per request — never cached across users.
export const dynamic = "force-dynamic";

/**
 * Notification Settings — communication preferences for the signed-in User
 * (MASTER 10 §10: optional categories are user-controlled and stored
 * server-side).
 *
 * This is a settings surface, not the inbox: the inbox lives behind the
 * header bell at /notifications and is never duplicated here. Signed-out
 * visitors are redirected to the existing auth flow; the page always renders
 * from the canonical notification_preferences row, so a refresh shows the
 * stored values, never a client-side guess.
 */
export default async function NotificationSettingsPage() {
  let preferences;

  try {
    const actor = await requireAuthenticatedActor(new Request("http://localhost/account/notifications"));
    preferences = await readUserNotificationPreferences(actor.userId);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      redirect("/auth?returnTo=%2Faccount%2Fnotifications");
    }
    throw error;
  }

  return (
    <main className="min-h-screen bg-brand-cream text-brand-ink">
      <SiteNav />

      <section className="mx-auto max-w-2xl px-5 pb-12 pt-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Setting</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Notification Settings</h1>
        <p className="mt-2 text-sm text-black/55">
          Pilih kategori notifikasi yang ingin kamu terima di dalam aplikasi.
        </p>
        <p className="mt-1 text-xs text-black/45">
          Daftar notifikasi ada di{" "}
          <Link className="font-bold text-brand-accent underline-offset-2 hover:underline" href="/notifications">
            Notifikasi
          </Link>
          .
        </p>

        <NotificationSettingsForm preferences={preferences} />
      </section>
    </main>
  );
}
