import Link from "next/link";
import { redirect } from "next/navigation";
import { CreatorRequiredError, requireCreator } from "@/lib/auth/creator";
import { hasValidGate } from "@/lib/creator/gate";
import { sanitizeReturnTo } from "@/lib/auth/return-to";
import CreatorGateClient from "./creator-gate-client";

export const dynamic = "force-dynamic";

/**
 * Creator security gate page (Authority Master §2).
 *
 * This route lives OUTSIDE app/developer/ so it is not wrapped by the
 * Developer Center layout — the previous placement under developer/gate
 * made the layout's own gate-check redirect loop against this page and
 * render blank. Only the Creator ever reaches this route: requireCreator()
 * runs first and a non-Creator sees the same 403 as anywhere else —
 * regular users, Producers, and Platform Admins never encounter this gate.
 * A Creator with a valid signed gate cookie proceeds straight to their
 * destination; otherwise the two-step verification starts here. The
 * destination after completion is a fixed internal path resolved through
 * the same returnTo sanitization used by /auth, so no open redirect is
 * introduced.
 */
export default async function DeveloperGatePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  let creatorEmail: string;
  let creatorId: string;
  try {
    const creator = await requireCreator();
    creatorEmail = creator.email;
    creatorId = creator.userId;
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      // Unauthenticated visitors head to sign-in first; authenticated
      // non-Creators get the same denial as any other Creator-only surface.
      const { createSupabaseServerClient } = await import("@/lib/supabase/server");
      try {
        const supabase = await createSupabaseServerClient();
        const { data } = await supabase.auth.getUser();
        if (!data?.user) {
          redirect("/auth?returnTo=%2Fdeveloper-gate");
        }
      } catch {
        redirect("/auth?returnTo=%2Fdeveloper-gate");
      }
      return (
        <main className="flex min-h-screen items-center justify-center bg-brand-cream px-5 text-[#20231f]">
          <div className="w-full max-w-md rounded-2xl border border-[#20231f]/10 bg-white p-8 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">403</p>
            <h1 className="mt-2 font-brand text-2xl font-black">Akses ditolak</h1>
            <p className="mt-3 text-sm leading-6 text-black/60">
              Gate ini hanya untuk Creator / Owner / Developer.
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
    throw error;
  }

  // An already-verified Creator does not see the gate again until the signed
  // cookie expires — and the cookie must belong to THIS Creator.
  if (await hasValidGate(creatorId)) {
    const params = await searchParams;
    const returnTo = sanitizeReturnTo(params.returnTo ?? null);
    redirect(returnTo === "/" ? "/developer" : returnTo);
  }

  return (
    <div className="min-h-screen bg-brand-cream font-brand text-[#20231f]">
      <header className="border-b border-[#20231f]/10">
        <div className="mx-auto max-w-4xl px-5 py-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">SINGGAH LOKAL</p>
          <h1 className="text-xl font-black tracking-tight">Security Gate</h1>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        <div className="space-y-6">
          <section className="rounded-2xl border border-[#20231f]/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">
              Creator / Owner / Developer
            </p>
            <h2 className="mt-2 font-brand text-2xl font-black text-[#20231f]">Verifikasi Creator</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#20231f]/60">
              Dua langkah verifikasi server-side diperlukan sebelum Developer Center dapat dibuka:
              CAPTCHA &ldquo;Bukan robot&rdquo; dan Pertanyaan Rahasia. Verifikasi berlaku sementara; refresh atau
              membuka URL langsung tidak melewati gate.
            </p>
            <p className="mt-3 text-xs text-[#20231f]/45">Masuk sebagai {creatorEmail}.</p>
          </section>

          <CreatorGateClient />
        </div>
      </main>
    </div>
  );
}
