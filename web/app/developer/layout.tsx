import Link from "next/link";
import { redirect } from "next/navigation";
import { CreatorRequiredError, requireCreator } from "@/lib/auth/creator";
import { hasValidGate } from "@/lib/creator/gate";

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
 * - SECURITY GATE (additional layer, never a replacement for Creator
 *   authorization): a verified Creator must also hold a valid signed gate
 *   cookie — issued only after the server-verified CAPTCHA and secret
 *   question steps — before any Developer Center content renders. Refresh
 *   and direct URLs cannot bypass it because the check re-runs on every
 *   request from the HTTP-only cookie, not from client state.
 */
type DeveloperGuard =
  | { kind: "authorized"; email: string; gateValid: boolean }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

async function resolveDeveloperGuard(): Promise<DeveloperGuard> {
  try {
    const creator = await requireCreator();
    // The gate cookie must be valid AND bound to this exact Creator's user id
    // (signature, expiry, purpose, and userId all verified server-side).
    const gateValid = await hasValidGate(creator.userId);
    return { kind: "authorized", email: creator.email, gateValid };
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

  if (guard.kind === "authorized" && !guard.gateValid) {
    // Verified Creator without a valid, user-bound gate: send them through
    // the two-step verification on a route OUTSIDE this layout (the old
    // /developer/gate placement caused a redirect loop with this check).
    // returnTo stays internal (encodeURIComponent of a fixed path — no open
    // redirect).
    redirect(`/developer-gate?returnTo=${encodeURIComponent("/developer")}`);
  }

  if (guard.kind === "forbidden") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-brand-cream px-5 text-[#20231f]">
        <div className="w-full max-w-md rounded-2xl border border-[#20231f]/10 bg-white p-8 text-center">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">403</p>
          <h1 className="mt-2 font-brand text-2xl font-black">Akses ditolak</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Area ini hanya untuk Creator / Owner / Developer.
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white transition hover:bg-[#0a5640]"
          >
            Kembali ke beranda
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-brand-cream font-brand text-[#20231f]">
      <header className="border-b border-[#20231f]/10">
        <div className="mx-auto max-w-4xl px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">SINGGAH LOKAL</p>
              <h1 className="text-xl font-black tracking-tight">Developer Center</h1>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden text-xs font-semibold text-[#20231f]/60 sm:block">{guard.email}</span>
              <Link
                href="/"
                className="rounded-full border border-[#20231f]/15 bg-white px-4 py-2 text-xs font-bold text-[#20231f]/80 transition hover:bg-brand-primary hover:text-white"
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
