import Link from "next/link";
import { redirect } from "next/navigation";
import SiteNav from "@/components/site-nav";
import AccountProfileEditClient from "@/components/account/account-profile-edit-client";
import { readOwnProfile } from "@/lib/account/profile-read";
import { PageHeader, PageShell, backLinkClass } from "@/components/ui/kit";

// Session data is read per request — never cached across users.
export const dynamic = "force-dynamic";

/**
 * EDIT PROFIL — the separate editing screen for the signed-in account.
 *
 * A real page (not a subview) so the account page stays a compact summary and
 * a refresh, a deep link, or a back navigation always lands on a well-defined
 * screen. The page renders the caller's OWN profile read server-side
 * (lib/account/profile-read.ts); signed-out visitors go to the existing auth
 * flow with the destination preserved, and the profile is never fetched from
 * client-supplied input.
 *
 * The writing itself happens in the client component through the existing
 * endpoints — this page holds no authorization logic and no business rule.
 */
export default async function EditProfilePage() {
  const profile = await readOwnProfile();

  if (!profile) {
    redirect("/auth?returnTo=%2Faccount%2Fprofile");
  }

  return (
    <>
      <SiteNav />
      <PageShell width="narrow">
        <PageHeader
          back={
            <Link className={backLinkClass} href="/account">
              ← Akun &amp; Akses
            </Link>
          }
          title="Edit Profil"
          description="Perbarui data profil akunmu. Perubahan tersimpan di server, bukan di perangkat ini."
        />

        <div className="mt-4">
          <AccountProfileEditClient {...profile} />
        </div>
      </PageShell>
    </>
  );
}
