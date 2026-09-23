import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Center guard (Authority Master §5).
 *
 * - Unauthenticated  → /auth?returnTo=%2Fadmin (same pattern as /producer).
 * - Authenticated non-moderator → 403 page. No data is rendered and the
 *   response does not reveal whether the account or role exists.
 * - Only public.users.platform_role = 'platform_moderator' passes, verified
 *   server-side on every request (fail closed).
 *
 * The guard runs first and resolves to a state; JSX renders outside try/catch.
 */
type AdminGuard =
  | { kind: "authorized" }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

async function resolveAdminGuard(): Promise<AdminGuard> {
  try {
    await requirePlatformModerator();
    return { kind: "authorized" };
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) {
      try {
        const supabase = await createSupabaseServerClient();
        const { data } = await supabase.auth.getUser();
        return data?.user ? { kind: "forbidden" } : { kind: "unauthenticated" };
      } catch {
        // Auth probe failure: fail closed to the safe 403 surface.
        return { kind: "forbidden" };
      }
    }
    throw error;
  }
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const guard = await resolveAdminGuard();

  if (guard.kind === "unauthenticated") {
    redirect("/auth?returnTo=%2Fadmin");
  }

  if (guard.kind === "forbidden") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f7f5ef] px-5 text-[#20231f]">
        <div className="w-full max-w-md rounded-2xl border border-black/10 bg-white p-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">403</p>
          <h1 className="mt-2 text-2xl font-black">Akses ditolak</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Area ini hanya untuk Platform Admin operasional.
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#7b5b38]"
          >
            Kembali ke beranda
          </Link>
        </div>
      </main>
    );
  }

  const sections = [
    { href: "/admin", label: "Overview" },
    { href: "/admin/users", label: "Users" },
    { href: "/admin/producers", label: "Producers" },
    { href: "/admin/producer-membership", label: "Producer Membership" },
    { href: "/admin/places", label: "Places" },
    { href: "/admin/experiences", label: "Experiences" },
    { href: "/admin/visit-intents", label: "Visit Intents" },
    { href: "/admin/live", label: "Live" },
    { href: "/admin/moderation", label: "Moderation" },
  ];

  return (
    <div className="min-h-screen bg-[#f7f5ef] text-[#20231f]">
      <header className="border-b border-black/5 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">SINGGAH LOKAL</p>
              <h1 className="text-xl font-black tracking-tight">Admin Center</h1>
            </div>
            <Link href="/" className="rounded-full border border-black/10 px-4 py-2 text-xs font-bold text-black/60 hover:bg-black/5">
              ← Area user
            </Link>
          </div>
          <nav aria-label="Navigasi Admin" className="mt-3 flex flex-wrap gap-2">
            {sections.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="rounded-full border border-black/10 bg-white px-3.5 py-1.5 text-xs font-bold text-black/60 transition hover:bg-[#7b5b38]/10 hover:text-[#7b5b38]"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-6">{children}</main>
    </div>
  );
}
