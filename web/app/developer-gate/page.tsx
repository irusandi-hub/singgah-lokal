import Link from "next/link";
import { redirect } from "next/navigation";

import { CreatorRequiredError, requireCreator } from "@/lib/auth/creator";
import { hasValidGate, isCreatorGateConfigured } from "@/lib/creator/gate";
import { sanitizeReturnTo } from "@/lib/auth/return-to";
import { acquireCreatorLease } from "@/lib/creator/session-lease";
import { getCreatorSecretQuestion } from "@/lib/creator/security-settings";
import CreatorGateClient, { type GatePayload } from "./creator-gate-client";

export const dynamic = "force-dynamic";

function serviceState(): GatePayload {
  return {
    state: "error",
    code: "service_unavailable",
    error: "Layanan Creator sedang tidak tersedia. Coba lagi nanti.",
  };
}

function serviceUnavailablePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-cream px-5 text-brand-ink">
      <section className="w-full max-w-md rounded-2xl border border-live/30 bg-white p-8 text-center" role="alert">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-live">Layanan tidak tersedia</p>
        <h1 className="mt-2 font-brand text-2xl font-semibold">Creator Gate belum dapat dibuka</h1>
        <p className="mt-3 text-sm leading-6 text-brand-ink/60">Autentikasi atau penyimpanan Creator sedang gagal. Coba lagi nanti.</p>
      </section>
    </main>
  );
}

export default async function DeveloperGatePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  let creatorEmail: string;
  let creatorUserId: string;
  try {
    const creator = await requireCreator();
    creatorEmail = creator.email;
    creatorUserId = creator.userId;
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      const { createSupabaseServerClient } = await import("@/lib/supabase/server");
      try {
        const supabase = await createSupabaseServerClient();
        const { data } = await supabase.auth.getUser();
        if (!data?.user) redirect("/auth?returnTo=%2Fdeveloper-gate");
      } catch {
        redirect("/auth?returnTo=%2Fdeveloper-gate");
      }
      return (
        <main className="flex min-h-screen items-center justify-center bg-brand-cream px-5 text-brand-ink">
          <div className="w-full max-w-md rounded-2xl border border-brand-ink/10 bg-white p-8 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">403</p>
            <h1 className="mt-2 font-brand text-2xl font-semibold">Akses ditolak</h1>
            <p className="mt-3 text-sm leading-6 text-black/60">Gate ini hanya untuk Creator / Owner / Developer.</p>
            <Link href="/" className="mt-6 inline-block rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-primary-deep">
              Kembali ke beranda
            </Link>
          </div>
        </main>
      );
    }
    return serviceUnavailablePage();
  }

  let initialState: GatePayload = { state: "loading" };
  try {
    if (!isCreatorGateConfigured()) {
      initialState = {
        state: "error",
        code: "gate_not_configured",
        error: "Layanan Creator belum dikonfigurasi. Hubungi pengelola lingkungan.",
      };
    } else {
      const acquired = await acquireCreatorLease();
      if (!acquired) {
        initialState = {
          state: "creator_session_active",
          code: "creator_session_active",
          error: "Sesi Creator lain sedang aktif. Tunggu hingga lease berakhir.",
        };
      } else if (await hasValidGate()) {
        const params = await searchParams;
        const returnTo = sanitizeReturnTo(params.returnTo ?? null);
        redirect(returnTo === "/" ? "/developer" : returnTo);
      } else {
        const questionStatus = await getCreatorSecretQuestion(creatorUserId);
        initialState = questionStatus.configured
          ? { state: "ready", question: questionStatus.question }
          : {
              state: "secret_question_missing",
              code: "secret_question_missing",
              error: "Pertanyaan rahasia belum dikonfigurasi. Gate tetap ditutup.",
            };
      }
    }
  } catch (error) {
    console.error("[developer-gate] initial status failed:", error);
    initialState = serviceState();
  }

  return (
    <div className="min-h-screen bg-brand-cream font-brand text-brand-ink">
      <header className="border-b border-brand-ink/10">
        <div className="mx-auto max-w-4xl px-5 py-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-primary">SINGGAH LOKAL</p>
          <h1 className="text-xl font-semibold tracking-tight">Creator Gate</h1>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        <div className="space-y-6">
          <section className="rounded-2xl border border-brand-ink/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Creator / Owner / Developer</p>
            <h2 className="mt-2 font-brand text-2xl font-semibold text-brand-ink">Verifikasi Creator</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-brand-ink/60">
              Satu sesi Creator aktif pada satu waktu. Setelah lease diperoleh, jawab pertanyaan rahasia yang sudah
              tersimpan untuk membuka Developer Center.
            </p>
            <p className="mt-3 text-xs text-brand-ink/45">Masuk sebagai {creatorEmail}.</p>
          </section>
          <CreatorGateClient initialStatus={initialState} />
        </div>
      </main>
    </div>
  );
}
