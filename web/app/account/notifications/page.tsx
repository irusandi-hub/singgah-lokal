import Link from "next/link";
import { redirect } from "next/navigation";
import SiteNav from "@/components/site-nav";
import NotificationSettingsForm from "@/components/notification-settings-form";
import { AuthenticationRequiredError, requireAuthenticatedActor } from "@/lib/auth/server";
import { readUserNotificationPreferences } from "@/lib/notification-service";
import { PageHeader, PageShell, metaTextClass } from "@/components/ui/kit";

// Session data is read per request — never cached across users.
export const dynamic = "force-dynamic";

/**
 * Pengaturan Notifikasi — communication preferences for the signed-in User
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
    <>
      <SiteNav />
      <PageShell width="narrow">
        <PageHeader
          eyebrow="Pengaturan"
          title="Pengaturan Notifikasi"
          description="Pilih kategori notifikasi yang ingin kamu terima di dalam aplikasi."
        />
        <p className={`mt-2 text-black/45 ${metaTextClass}`}>
          Daftar notifikasi ada di{" "}
          <Link className="font-bold text-brand-accent underline-offset-2 hover:underline" href="/notifications">
            Notifikasi
          </Link>
          .
        </p>

        <div className="mt-4">
          <NotificationSettingsForm preferences={preferences} />
        </div>
      </PageShell>
    </>
  );
}
