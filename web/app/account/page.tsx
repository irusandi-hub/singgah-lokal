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
} from "@/components/ui/kit";import AccountProfileClient from "@/components/account/account-profile-client";
import AccountAccessClient from "@/components/account/account-access-client";
import AccountLiveAccessClient from "@/components/account/account-live-access-client";
import { resolvePlaceMemberships } from "@/lib/account-memberships";

export const dynamic = "force-dynamic";

/**
 * Account & Access Center — the single gateway between the main app and every
 * authority area (Authority Master §1–§7).
 *
 * Purpose: show who this account is, then the access it actually holds —
 * Pengelola, Operator Live (when applicable), and any other authority the
 * account genuinely has. Areas the account does not hold are not rendered at
 * all — no dead links, no hints about who holds which authority.
 *
 * The authority probe runs server-side on every request:
 * - Producer  → an owner/manager row in producer_memberships (own resources).
 * - Platform Admin → public.users.platform_role = 'platform_moderator'.
 * - Creator/Owner/Developer → the Creator-controlled environment allowlist.
 *
 * The page is deliberately compact: one identity block, then one section per
 * access area the account holds. There is NO separate security/logout section
 * here — sign-out already lives in the app-level account menu and its own
 * backend endpoint.
 */

type AccountAuthority = {
  authenticated: boolean;
  email: string | null;
  displayName: string | null;
  username: string | null;
  memberships: Array<{ placeId: string; role: "owner" | "manager" }>;
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
    isPlatformAdmin: false,
    isCreator: false,
  };

  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return fallback;

    const [{ data: memberships }, { data: userRow }] = await Promise.all([
      supabase
        .from("producer_memberships")
        .select("place_id, role")
        .eq("user_id", userData.user.id)
        .in("role", ["owner", "manager"])
        .order("created_at", { ascending: true }),
      supabase
        .from("users")
        .select("platform_role, display_name, username")
        .eq("id", userData.user.id)
        .maybeSingle(),
    ]);

    // Account & Access Center shows the account’s own public profile
    // (identity), then the access it actually holds. Display name and username
    // are OPTIONAL: a missing value is shown as absent, never invented.
    return {
      authenticated: true,
      email: userData.user.email ?? null,
      displayName:
        (userRow as { display_name?: string | null } | null)?.display_name ?? null,
      username:
        (userRow as { username?: string | null } | null)?.username ?? null,
      memberships: (memberships ?? []).map((row) => ({
        placeId: String(row.place_id),
        role: (row.role as "owner" | "manager") ?? "manager",
      })),
      isPlatformAdmin:
        userRow?.platform_role === "platform_moderator",
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

        {authority.memberships.length > 0 ? (
          <Section title="Akses">
            <AccountAccessClient memberships={authority.memberships} />
          </Section>
        ) : accessItems.length === 0 ? (
          <Section title="Akses">
            <p className={`text-black/60 ${metaTextClass}`}>
              Akun ini belum memiliki akses Pengelola, Platform Admin, atau
              Developer.
            </p>
            <div>
              <Link href="/producer/onboarding" className={btn.primary}>
                Ajukan menjadi Pengelola
              </Link>
            </div>
          </Section>
        ) : (
          <Section title="Akses">
            {accessItems.map(({ href, label, description }) => (
              <ListRow
                key={href}
                href={href}
                title={label}
                meta={description}
              />
            ))}
          </Section>
        )}

        {authority.memberships.length > 0 && (
          <Section title="Akses">
            <AccountLiveAccessClient memberships={authority.memberships} />
          </Section>
        )}
      </div>
    </PageShell>
  );
}
