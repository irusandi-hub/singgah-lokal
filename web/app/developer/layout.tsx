import Link from "next/link";
import { redirect } from "next/navigation";
import { CreatorRequiredError, requireCreator } from "@/lib/auth/creator";
import { hasValidGate } from "@/lib/creator/gate";
import { acquireCreatorLease } from "@/lib/creator/session-lease";
import CreatorLeaseHeartbeat from "./creator-lease-heartbeat";

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
 * - The signed Creator gate cookie and the singleton session lease are both
 *   checked on every Developer request. The browser heartbeat renews the
 *   lease while the Center remains open.
 */
type DeveloperGuard =
  | { kind: "authorized"; email: string; userId: string; gateValid: boolean }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

async function resolveDeveloperGuard(): Promise<DeveloperGuard> {
  try {
    const creator = await requireCreator();
    const gateValid = await hasValidGate();
    return { kind: "authorized", email: creator.email, userId: creator.userId, gateValid };
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

  if (guard.kind === "authorized") {
    if (!guard.gateValid) {
      redirect(`/developer-gate?returnTo=${encodeURIComponent("/developer")}`);
    }

    let leaseIsActive = false;
    try {
      leaseIsActive = await acquireCreatorLease(guard.userId);
    } catch {
      redirect("/developer-gate");
    }
    if (!leaseIsActive) {
      redirect("/developer-gate");
    }
  }

  if (guard.kind === "forbidden") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-brand-cream px-5 text-brand-ink">
        <div className="w-full max-w-md rounded-2xl border border-brand-ink/10 bg-white p-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">403</p>
          <h1 className="mt-2 font-brand text-2xl font-semibold">Akses ditolak</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Area ini hanya untuk Creator / Owner / Developer.
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-primary-deep"
          >
            Kembali ke beranda
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-brand-cream font-brand text-brand-ink">
      <header className="border-b border-brand-ink/10">
        <div className="mx-auto max-w-4xl px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">SINGGAH LOKAL</p>
              <h1 className="text-xl font-semibold tracking-tight">Developer Center</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-xs font-semibold text-brand-ink/60 sm:block">{guard.email}</span>
              <Link
                href="/"
                className="rounded-full border border-brand-ink/15 bg-white px-4 py-2 text-xs font-bold text-brand-ink/80 transition hover:bg-brand-primary hover:text-white"
              >
                Home
              </Link>
            </div>
          </div>
        </div>
      </header>
      <CreatorLeaseHeartbeat />
      <main className="mx-auto max-w-4xl px-5 py-8">{children}</main>
    </div>
  );
}
