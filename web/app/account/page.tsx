import Link from "next/link";
import { redirect } from "next/navigation";
import { isCreatorEmail } from "@/lib/auth/creator";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  ListRow,
  PageHeader,
  PageShell,
  Section,
  backLinkClass,
  btn,
  metaTextClass,
} from "@/components/ui/kit";
import AccountProfileClient from "@/components/account/account-profile-client";
import AccountAccessClient from "@/components/account/account-access-client";
import AccountLiveAccessClient from "@/components/account/account-live-access-client";
import { resolvePlaceMemberships, type AccountPlaceMembership } from "@/lib/account-memberships";
import {
  resolveLiveOperatorAssignments,
  type AccountLiveOperatorAssignment,
} from "@/lib/account-live-operators";

export const dynamic = "force-dynamic";

/**
 * Account & Access Center — the single gateway between the main app and every
 * authority area (Authority Master §1–§7).
 *
 * The page shows who this account is, then — in ONE "Akses" section — the
 * access it actually holds:
 * - Pengelola  → an owner/manager row in producer_memberships (own resources).
 * - Operator Live → an ACTIVE delegated assignment in public.live_operators.
 *   Producer authority never produces an Operator Live card, and a delegated
 *   operator is never shown as Pengelola.
 * - Platform Admin → public.users.platform_role = 'platform_moderator'.
 * - Developer → the Creator-controlled environment allowlist.
 *
 * The authority probe runs server-side on every request, and each card shows
 * the exact canonical Place name — never a raw place id. Areas the account does
 * not hold are not rendered at all — no dead links.
 */

type AccountAuthority = {
  authenticated: boolean;
  email: string | null;
  displayName: string | null;
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
    displayName: null,
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
    // resolved separately so neither can ever imply the other.
    const [memberships, liveAssignments, { data: userRow }] = await Promise.all([
      resolvePlaceMemberships(),
      resolveLiveOperatorAssignments(),
      supabase
        .from("users")
        .select("platform_role, display_name, username")
        .eq("id", userData.user.id)
        .maybeSingle(),
    ]);

    return {
      authenticated: true,
      email: userData.user.email ?? null,
      displayName:
        (userRow as { display_name?: string | null } | null)?.display_name ?? null,
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

  const profileIdentity = (
    <div className="grid gap-2">
      {authority.email ? (
        <p className="text-sm font-semibold">
          Masuk sebagai{" "}
          <strong className="font-bold text-brand-ink">{authority.email}</strong>
        </p>
      ) : (
        <p className="text-sm font-semibold text-black/55">Akun tidak dikenali.</p>
      )}
      {authority.displayName ? (
        <p className="text-xs text-black/55">
          Nama tampilan: {authority.displayName}
        </p>
      ) : null}
      <AccountProfileClient username={authority.username} />
    </div>
  );

  const accessItems: Array<{
    href: string;
    label: string;
    description: string;
  }> = [];

  if (authority.isPlatformAdmin) {
    accessItems.push({
      href: "/admin",
      label: "Platform Admin",
      description: "Pengelolaan operasional platform.",
    });
  }

  if (authority.isCreator) {
    accessItems.push({
      href: "/developer",
      label: "Developer",
      description: "Kewenangan Creator: kelola Platform Admin.",
    });
  }

  const hasProducerAccess = authority.memberships.length > 0;
  const hasLiveOperatorAccess = authority.liveAssignments.length > 0;
  const hasAccess =
    hasProducerAccess || hasLiveOperatorAccess || accessItems.length > 0;

  return (
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            ← Beranda
          </Link>
        }
        title="Account & Access Center"
        description="Lihat profil dan akses yang tersedia untuk akun ini."
      />

      <div className="mt-4">
        <Section title="Profil">{profileIdentity}</Section>

        {/* Exactly ONE "Akses" section: every access the account holds is
            grouped here, so Producer and delegated Operator access are never
            presented as two competing sections. */}
        <Section title="Akses">
          {hasAccess ? (
            <div className="grid gap-3">
              {hasProducerAccess ? (
                <AccountAccessClient memberships={authority.memberships} />
              ) : null}
              {hasLiveOperatorAccess ? (
                <AccountLiveAccessClient assignments={authority.liveAssignments} />
              ) : null}
              {accessItems.length > 0 ? (
                <div className="grid gap-2">
                  {accessItems.map(({ href, label, description }) => (
                    <ListRow
                      key={href}
                      href={href}
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
                Akun ini belum memiliki akses Pengelola, Operator Live, Platform
                Admin, atau Developer.
              </p>
              <div>
                <Link href="/producer/onboarding" className={btn.primary}>
                  Ajukan menjadi Pengelola
                </Link>
              </div>
            </div>
          )}
        </Section>
      </div>
    </PageShell>
  );
}
