import Link from "next/link";
import { redirect } from "next/navigation";
import { CreatorRequiredError, requireCreator } from "@/lib/auth/creator";

export const dynamic = "force-dynamic";

/**
 * Developer Center guard (Authority Master §2).
 *
 * - Unauthenticated → /auth?returnTo=%2Fdeveloper.
 * - Authenticated non-Creator → 403 page that reveals nothing about the
 *   Creator identity or allowlist.
 * - Creator is verified server-side on every request against the
 *   Creator-controlled environment allowlist (fail closed). The Creator is
 *   never modeled as platform_moderator (Authority Master §4) and no
 *   infrastructure credential is ever rendered here.
 */
type DeveloperGuard = { kind: "authorized"; email: string } | { kind: "unauthenticated" } | { kind: "forbidden" };

async function resolveDeveloperGuard(): Promise<DeveloperGuard> {
  try {
    const creator = await requireCreator();
    return { kind: "authorized", email: creator.email };
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      try {
        const { createSupabaseServerClient } = await import("@/lib/supabase/server");
        const supabase = await createSupabaseServerClient();
        const { data } = await supabase.auth.getUser();
        return data?.user ? { kind: "forbidden" } : { kind: "unauthenticated" };
      } catch {
        return { kind: "forbidden" };
      }
    }
    throw error;
  }
}

export default async function DeveloperLayout({ children }: { children: React.ReactNode }) {
  const guard = await resolveDeveloperGuard();

  if (guard.kind === "unauthenticated") {
    redirect("/auth?returnTo=%2Fdeveloper");
  }

  if (guard.kind === "forbidden") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f7f5ef] px-5 text-[#20231f]">
        <div className="w-full max-w-md rounded-2xl border border-black/10 bg-white p-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">403</p>
          <h1 className="mt-2 text-2xl font-black">Akses ditolak</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Area ini hanya untuk Creator / Owner / Developer.
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

  return (
    <div className="min-h-screen bg-[#20231f] text-[#f7f5ef]">
      <header className="border-b border-white/10">
        <div className="mx-auto max-w-4xl px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d8ad6f]">SINGGAH LOKAL</p>
              <h1 className="text-xl font-black tracking-tight">Developer Center</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-xs font-semibold text-white/60 sm:block">{guard.email}</span>
              <Link
                href="/"
                className="rounded-full border border-white/20 px-4 py-2 text-xs font-bold text-white/80 hover:bg-white/10"
              >
                Home
              </Link>
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">{children}</main>
    </div>
  );
}
