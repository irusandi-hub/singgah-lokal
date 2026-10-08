import Link from "next/link";
import { redirect } from "next/navigation";
import { isCreatorEmail } from "@/lib/auth/creator";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ListRow, PageHeader, PageShell, Section, backLinkClass, btn, metaTextClass } from "@/components/ui/kit";

export const dynamic = "force-dynamic";

/**
 * Account Center — the single gateway between the main app and every authority
 * area (Authority Master §1–§7).
 *
 * The authority probe runs server-side on every request:
 * - Producer  → an owner/manager row in producer_memberships (own resources).
 * - Platform Admin → public.users.platform_role = 'platform_moderator'.
 * - Creator/Owner/Developer → the Creator-controlled environment allowlist.
 *
 * Areas the account does not hold are not rendered at all — no dead links, no
 * hints about who holds which authority. The page is deliberately tiny: one
 * identity line, then the areas that actually open for this account.
 */

type AccountAuthority = {
  authenticated: boolean;
  email: string | null;
  isProducer: boolean;
  isPlatformAdmin: boolean;
  isCreator: boolean;
};

async function resolveAccountAuthority(): Promise<AccountAuthority> {
  const fallback: AccountAuthority = {
    authenticated: false,
    email: null,
    isProducer: false,
    isPlatformAdmin: false,
    isCreator: false,
  };

  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return fallback;

    const [{ data: membership }, { data: userRow }] = await Promise.all([
      supabase
        .from("producer_memberships")
        // producer_memberships has NO id column (PK is (user_id, place_id),
        // 0001) — probe an existing column so the read cannot fail.
        .select("role")
        .eq("user_id", userData.user.id)
        .in("role", ["owner", "manager"])
        .limit(1)
        .maybeSingle(),
      supabase.from("users").select("platform_role").eq("id", userData.user.id).maybeSingle(),
    ]);

    return {
      authenticated: true,
      email: userData.user.email ?? null,
      isProducer: Boolean(membership),
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

  const entries: Array<{ href: string; label: string; description: string }> = [];

  if (authority.isProducer) {
    entries.push({ href: "/producer", label: "Pengelola", description: "Kelola Tempat, Kegiatan, Kunjungan, dan Live milikmu." });
  }
  if (authority.isPlatformAdmin) {
    entries.push({ href: "/admin", label: "Platform Admin", description: "Pengelolaan operasional platform." });
  }
  if (authority.isCreator) {
    entries.push({ href: "/developer", label: "Developer", description: "Kewenangan Creator: kelola Platform Admin." });
  }

  return (
    <PageShell width="narrow">
      <PageHeader
        back={
          <Link className={backLinkClass} href="/">
            ← Beranda
          </Link>
        }
        title="Account Center"
        description={authority.email ? <>Masuk sebagai <strong className="font-bold text-brand-ink">{authority.email}</strong></> : "Area di bawah mengikuti kewenangan akunmu."}
      />

      <div className="mt-4">
        {entries.length === 0 ? (
          <Section title="Available areas">
            <p className={`text-black/60 ${metaTextClass}`}>
              Akunmu adalah akun user: discovery, Tempat, Kegiatan, SINGGAH/Kunjungan, dan Live.
            </p>
            <div>
              <Link href="/producer/onboarding" className={btn.primary}>
                Ajukan menjadi Pengelola
              </Link>
            </div>
          </Section>
        ) : (
          <Section title="Available areas">
            {entries.map(({ href, label, description }) => (
              <ListRow key={href} href={href} title={label} meta={description} />
            ))}
          </Section>
        )}
      </div>
    </PageShell>
  );
}
