import Link from "next/link";
import { redirect } from "next/navigation";
import { isCreatorEmail } from "@/lib/auth/creator";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Kelola Akun — the single gateway between the main app and every authority
 * area (Authority Master §1–§7).
 *
 * The authority probe runs server-side on every request:
 * - Producer  → an owner/manager row in producer_memberships (own resources).
 * - Platform Admin → public.users.platform_role = 'platform_moderator'
 *   (operational authority in-app).
 * - Creator/Owner/Developer → the Creator-controlled environment allowlist
 *   (program + infrastructure authority; the Creator is never
 *   platform_moderator, Authority Master §4).
 *
 * Areas the account does not hold are not rendered at all — no dead links,
 * no hints about who holds which authority. Dashboard layers themselves keep
 * their own guards; this page only decides what to offer.
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

  const entries: Array<{ href: string; eyebrow: string; title: string; description: string }> = [];

  if (authority.isProducer) {
    entries.push({
      href: "/producer",
      eyebrow: "Producer",
      title: "Producer Dashboard",
      description: "Kelola Place, Experience, Visit Intent, dan Live milikmu.",
    });
  }
  if (authority.isPlatformAdmin) {
    entries.push({
      href: "/admin",
      eyebrow: "Platform Admin",
      title: "Admin Center",
      description: "Pengelolaan operasional: Users, Producers, Places, Live, Moderation.",
    });
  }
  if (authority.isCreator) {
    entries.push({
      href: "/developer",
      eyebrow: "Creator / Owner / Developer",
      title: "Developer Center",
      description: "Kewenangan tertinggi: kelola Platform Admin dan akses area lain.",
    });
  }

  return (
    <main className="min-h-screen bg-brand-cream px-5 py-10 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-bold text-brand-accent">
          ← Beranda
        </Link>

        <header className="mt-8 border-b border-black/10 pb-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Kelola Akun</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Area akun</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            {authority.email ? (
              <>
                Masuk sebagai <span className="font-bold text-brand-ink">{authority.email}</span>. Area di bawah
                mengikuti kewenangan akun ini.
              </>
            ) : (
              "Area di bawah mengikuti kewenangan akunmu."
            )}
          </p>
        </header>

        {entries.length === 0 ? (
          <section className="mt-8 rounded-2xl border border-brand-accent/25 bg-[#fffaf0] p-6">
            <h2 className="text-sm font-semibold">Belum ada area khusus</h2>
            <p className="mt-2 text-sm leading-6 text-black/60">
              Akunmu adalah akun user biasa: discovery, Place, Experience, SINGGAH/Visit Intent, dan Live.
              Akses Producer diberikan admin platform; akses Platform Admin diberikan Creator.
            </p>
            <Link
              href="/producer/onboarding"
              className="mt-4 inline-flex rounded-full bg-brand-accent px-4 py-2 text-xs font-bold text-white"
            >
              Ajukan menjadi Producer
            </Link>
          </section>
        ) : (
          <div className="mt-8 grid gap-3">
            {entries.map(({ href, eyebrow, title, description }) => (
              <Link
                key={href}
                href={href}
                className="group rounded-2xl border border-black/10 bg-white p-6 transition hover:border-brand-accent/40 hover:shadow-sm"
              >
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-brand-accent">{eyebrow}</p>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                  <span aria-hidden className="text-brand-accent transition group-hover:translate-x-0.5">→</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-black/60">{description}</p>
              </Link>
            ))}
          </div>
        )}

        <p className="mt-8 text-xs leading-5 text-black/45">
          Setiap area tetap memverifikasi kewenangan secara server-side saat dibuka.
        </p>
      </div>
    </main>
  );
}
