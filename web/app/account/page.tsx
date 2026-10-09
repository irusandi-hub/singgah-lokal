import Link from "next/link";
import { redirect } from "next/navigation";
import { isCreatorEmail } from "@/lib/auth/creator";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import SiteNav from "@/components/site-nav";
import {
  ListRow,
  PageHeader,
  PageShell,
  Panel,
  Section,
  backLinkClass,
  btn,
  metaTextClass,
} from "@/components/ui/kit";
import AccountProfileClient from "@/components/account/account-profile-client";
import AccountAccessClient from "@/components/account/account-access-client";
import AccountLiveAccessClient from "@/components/account/account-live-access-client";
import AccountLiveOperatorManager from "@/components/account/account-live-operator-manager";
import { AdminIcon, DeveloperIcon } from "@/components/account/account-icons";
import SignOutButton from "@/components/sign-out-button";
import { resolvePlaceMemberships, type AccountPlaceMembership } from "@/lib/account-memberships";
import {
  resolveLiveOperatorAssignments,
  type AccountLiveOperatorAssignment,
} from "@/lib/account-live-operators";

export const dynamic = "force-dynamic";

/**
 * AKUN & AKSES — the single gateway between the main app and every authority
 * area (Authority Master §1–§7).
 *
 * Layout (UI/UX pass, 2026-10-09): the page sits on the app's cream
 * background, the profile header is ONE rounded white panel (initials avatar,
 * real username, authenticated email, "Edit Profil"), and below it ONE grouped
 * "Akses" list where every row is an actual destination the account is
 * authorized to use:
 * - Pengelola  → an owner/manager row in producer_memberships (own resources).
 *   An owner/manager also gets "Kelola Akses Live" here, because delegating
 *   Live operation IS a Pengelola capability over their own Places.
 * - Operator Live → an ACTIVE delegated assignment in public.live_operators.
 *   Producer authority never produces an Operator Live row, and a delegated
 *   operator is never shown as Pengelola.
 * - Platform Admin → public.users.platform_role = 'platform_moderator'.
 * - Developer → the Creator-controlled environment allowlist.
 *
 * The authority probe runs server-side on every request, and each Operator
 * Live row shows the exact canonical Place name — never a raw place id. Areas
 * the account does not hold are not rendered at all — no dead links. The only
 * sign-out on the page reuses the existing SignOutButton (one implementation).
 *
 * NOTE (canonical schema): public.users carries exactly id, created_at,
 * platform_role and (since 0047) username. It has NO display_name column, so
 * the Profil Saya panel does not pretend to edit one — a fake editable field
 * is worse than an absent one.
 */

type AccountAuthority = {
  authenticated: boolean;
  email: string | null;
  username: string | null;
  memberships: AccountPlaceMembership[];
  liveAssignments: AccountLiveOperatorAssignment[];
  isPlatformAdmin: boolean;
  isCreator: boolean;
};

async function resolveAccountAuthority(): Promise<AccountAuthority> {
  const fallback: AccountAuthority = {
    authenticated: false,
    email: null,
    username: null,
    memberships: [],
    liveAssignments: [],
    isPlatformAdmin: false,
    isCreator: false,
  };

  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return fallback;

    // Pengelola authority comes from producer_memberships; Operator Live
    // authority comes ONLY from active live_operators assignments. They are
    // resolved separately so neither can ever imply the other. Only columns
    // that exist on public.users are selected.
    const [memberships, liveAssignments, { data: userRow }] = await Promise.all([
      resolvePlaceMemberships(),
      resolveLiveOperatorAssignments(),
      supabase
        .from("users")
        .select("platform_role, username")
        .eq("id", userData.user.id)
        .maybeSingle(),
    ]);

    return {
      authenticated: true,
      email: userData.user.email ?? null,
      username:
        (userRow as { username?: string | null } | null)?.username ?? null,
      memberships,
      liveAssignments,
      isPlatformAdmin: userRow?.platform_role === "platform_moderator",
      isCreator: isCreatorEmail(userData.user.email),
    };
  } catch {
    return fallback;
  }
}

export default async function AccountPage() {
  const authority = await resolveAccountAuthority();

  if (!authority.authenticated) {
    redirect("/auth?returnTo=%2Faccount");
  }

  const accessItems: Array<{
    href: string;
    label: string;
    description: string;
    icon: "admin" | "developer";
  }> = [];

  if (authority.isPlatformAdmin) {
    accessItems.push({
      href: "/admin",
      label: "Platform Admin",
      description: "Pengelolaan operasional platform.",
      icon: "admin",
    });
  }

  if (authority.isCreator) {
    accessItems.push({
      href: "/developer",
      label: "Developer",
      description: "Kelola akun Platform Admin.",
      icon: "developer",
    });
  }

  const hasProducerAccess = authority.memberships.length > 0;
  const hasLiveOperatorAccess = authority.liveAssignments.length > 0;
  const hasAccess =
    hasProducerAccess || hasLiveOperatorAccess || accessItems.length > 0;

  return (
    <>
      <SiteNav />
      <PageShell width="narrow">
        <PageHeader
          back={
            <Link className={backLinkClass} href="/">
              ← Beranda
            </Link>
          }
          title="Akun & Akses"
          description="Profil akun ini dan seluruh akses yang dimilikinya."
        />

        <div className="mt-4 grid gap-5">
          {/* Profile header — ONE rounded white panel: initials avatar, the
              real username, the authenticated email, and "Edit Profil"
              aligned with them (the client owns the editing state). */}
          <Section title="Profil Saya">
            <Panel>
              <AccountProfileClient
                username={authority.username}
                email={authority.email}
              />
            </Panel>
          </Section>

          {/* Exactly ONE "Akses" group: every access the account holds is
              listed here, so Producer and delegated Operator access are never
              presented as two competing sections. Each destination row carries
              an icon, a short label, and the shared right-facing chevron. */}
          <Section title="Akses">
            {hasAccess ? (
              <div className="grid gap-3">
                {hasProducerAccess ? (
                  <AccountAccessClient memberships={authority.memberships} />
                ) : null}
                {hasProducerAccess ? (
                  <AccountLiveOperatorManager places={authority.memberships} />
                ) : null}
                {hasLiveOperatorAccess ? (
                  <AccountLiveAccessClient assignments={authority.liveAssignments} />
                ) : null}
                {accessItems.length > 0 ? (
                  <div className="grid gap-2">
                    {accessItems.map(({ href, label, description, icon }) => (
                      <ListRow
                        key={href}
                        href={href}
                        leading={
                          icon === "admin" ? <AdminIcon /> : <DeveloperIcon />
                        }
                        title={label}
                        meta={description}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-2">
                <p className={`text-black/60 ${metaTextClass}`}>
                  Akun ini belum memiliki akses Pengelola, Operator Live,
                  Platform Admin, atau Developer.
                </p>
                <div>
                  <Link href="/producer/onboarding" className={btn.primary}>
                    Ajukan menjadi Pengelola
                  </Link>
                </div>
              </div>
            )}
          </Section>

          {/* The ONE sign-out on this page reuses the existing working action —
              no second sign-out implementation. */}
          <div className="flex justify-center border-t border-black/10 pt-4">
            <SignOutButton variant="header" />
          </div>
        </div>
      </PageShell>
    </>
  );
}
