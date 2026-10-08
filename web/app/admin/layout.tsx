import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";
import AdminNav from "@/components/admin/admin-nav";

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
 * The shell is ONE compact layer: the area title, the tab row, and the single
 * exit back to the app. Section pages add their own one-line parent link
 * (AdminBackToAdminCenter) — hierarchy up, not a second navigation system.
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
      <main className="flex min-h-screen items-center justify-center bg-brand-cream px-5 text-brand-ink">
        <div className="w-full max-w-md rounded-2xl border border-black/10 bg-white p-6 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-brand-accent">403</p>
          <h1 className="mt-2 text-2xl font-semibold">Akses ditolak</h1>
          <p className="mt-2 text-sm leading-6 text-black/60">
            Area ini hanya untuk Platform Admin operasional.
          </p>
          <Link
            href="/"
            className="mt-5 inline-block rounded-full bg-brand-primary px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-primary-deep"
          >
            Kembali ke beranda
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-brand-cream text-brand-ink">
      <header className="sticky top-0 z-30 border-b border-black/5 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 pt-3">
          <h1 className="text-[15px] font-semibold tracking-tight">
            Admin Center
            <span className="ml-2 text-[11px] font-bold uppercase tracking-[0.16em] text-brand-accent">SINGGAH LOKAL</span>
          </h1>
          <Link href="/" className="text-xs font-bold text-brand-accent transition hover:text-brand-primary">
            ← Kembali ke Beranda
          </Link>
        </div>
        <div className="mx-auto max-w-5xl px-4 pb-2">
          <AdminNav />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-4">
        <div className="grid gap-4">{children}</div>
      </main>
    </div>
  );
}
