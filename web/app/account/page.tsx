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
import { readOwnProfile } from "@/lib/account/profile-read";
import { profileErrorMessage } from "@/lib/account/profile-messages";
import LegalAcceptancePrompt from "@/components/legal/legal-acceptance-prompt";
import { readKetentuanAcceptanceState, type LegalAcceptanceState } from "@/lib/legal/acceptance";

export const dynamic = "force-dynamic";

/**
 * AKUN & AKSES — the single gateway between the main app and every authority
 * area (Authority Master §1–§7).
 *
 * Layout (Tahap 3 mobile pass, 2026-10-11): the page sits on the app's cream
 * background and contains exactly three things —
 *  1. "Profil Saya": ONE rounded white panel with the READ-ONLY identity summary
 *     (photo or initials, name, username), the verification summary, and the
 *     single "Edit Profil" action that opens /account/profile. No editable field
 *     lives on this page any more, so the summary can never show an unsaved form;
 *  2. "Akses": ONE grouped list where every row is an actual destination the
 *     account is authorized to use —
 *     - Pengelola → an owner/manager row in producer_memberships (own resources).
 *       An owner/manager also gets "Kelola Akses Live" here, because delegating
 *       Live operation IS a Pengelola capability over their own Places.
 *     - Operator Live → an ACTIVE delegated assignment in public.live_operators.
 *       Producer authority never produces an Operator Live row, and a delegated
 *       operator is never shown as Pengelola.
 *     - Platform Admin → public.users.platform_role = 'platform_moderator'.
 *     - Developer → the Creator-controlled environment allowlist;
 *  3. the ONE sign-out action, reusing the existing SignOutButton.
 *
 * The authority probe runs server-side on every request, and each Operator Live
 * row shows the exact canonical Place name — never a raw place id. Areas the
 * account does not hold are not rendered at all — no dead links.
 *
 * VERIFICATION STAYS SEPARATE: the panel reports the two account contact facts
 * (email, phone) only. Neither of them implies a verified manager or a verified
 * Place, and no such badge is rendered here.
 */

type AccountAuthority = {
  authenticated: boolean;
  email: string | null;
  memberships: AccountPlaceMembership[];
  liveAssignments: AccountLiveOperatorAssignment[];
  isPlatformAdmin: boolean;
  isCreator: boolean;
};

async function resolveAccountAuthority(): Promise<AccountAuthority> {
  const fallback: AccountAuthority = {
    authenticated: false,
    email: null,
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
        .select("platform_role")
        .eq("id", userData.user.id)
        .maybeSingle(),
    ]);

    return {
      authenticated: true,
      email: userData.user.email ?? null,
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
  const [authority, profile] = await Promise.all([
    resolveAccountAuthority(),
    readOwnProfile(),
  ]);

  if (!authority.authenticated) {
    redirect("/auth?returnTo=%2Faccount");
  }

  // Dokumen hukum berversi (migration 0059): keberadaan kewajiban persetujuan
  // adalah fakta server yang perlu diketahui akun ini. Kegagalan membaca register
  // TIDAK memblokir halaman — kartunya hanya tidak muncul.
  let legalAcceptance: LegalAcceptanceState | null = null;
  try {
    legalAcceptance = await readKetentuanAcceptanceState();
  } catch {
    legalAcceptance = null;
  }
  const needsLegalAcceptance = Boolean(
    legalAcceptance && legalAcceptance.available && legalAcceptance.required && !legalAcceptance.accepted,
  );

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
          {needsLegalAcceptance && legalAcceptance ? (
            <LegalAcceptancePrompt
              documentId={legalAcceptance.document.id}
              title={legalAcceptance.document.title}
              version={legalAcceptance.version}
              href={legalAcceptance.document.href}
            />
          ) : null}

          {/* Profil Saya — READ-ONLY summary on ONE rounded white panel. Every
              value comes from the server; the only action is Edit Profil. */}
          <Section title="Profil Saya">
            <Panel>
              {profile ? (
                <AccountProfileClient
                  fullName={profile.fullName}
                  username={profile.username}
                  email={authority.email}
                  avatarUrl={profile.avatarUrl}
                  verification={profile.verification}
                />
              ) : (
                <p className={`text-black/60 ${metaTextClass}`}>
                  {profileErrorMessage("profile_update_unavailable")}
                </p>
              )}
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
