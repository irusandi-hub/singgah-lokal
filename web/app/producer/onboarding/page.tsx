import Link from "next/link";
import { redirect } from "next/navigation";
import SiteNav from "@/components/site-nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getProducerApplicationStatus } from "@/lib/producer/application";
import { PageHeader, PageShell, Panel, Section, backLinkClass, btn, metaTextClass } from "@/components/ui/kit";
import ProducerApplicationClient from "./producer-application-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Ajukan menjadi Pengelola — SINGGAH LOKAL",
};

/**
 * Producer application (Authority Master: 1 akun = 1 identitas Producer).
 *
 * The application is bound to the signed-in account — there is no separate
 * Producer email/password/identity. An unauthenticated visitor is sent to
 * sign-in with returnTo back here; a signed-in user sees the account that is
 * applying, taken from the authenticated session (never typed freely).
 *
 * PRODUCER GATE: an account that already holds an active owner/manager
 * membership never sees the application form again — it is redirected to
 * /producer. The check is server-side per request (force-dynamic), so the
 * decision stays correct after login, refresh, and logout/login again.
 *
 * This page runs BEFORE any membership exists, so it keeps the public area
 * navigation (SiteNav) and its single way back is the public home.
 */
export default async function ProducerOnboardingPage() {
  // Fail-soft session probe: an unconfigured runtime must render the page
  // (with the sign-in CTA), not crash with 500.
  let user = null;
  let hasProducerMembership = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    user = data.user ?? null;
    if (user) {
      // RLS memberships_self_read (0001) scopes this read to the session's
      // own rows; owner/manager is the Producer gate.
      const { data: memberships } = await supabase
        .from("producer_memberships")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["owner", "manager"])
        .limit(1);
      hasProducerMembership = (memberships?.length ?? 0) > 0;
    }
  } catch {
    user = null;
    hasProducerMembership = false;
  }

  if (hasProducerMembership) {
    redirect("/producer");
  }

  let application: Awaited<ReturnType<typeof getProducerApplicationStatus>> | null = null;
  if (user) {
    try {
      application = await getProducerApplicationStatus(user.id);
    } catch {
      application = null; // surfaced as service-unavailable in the client panel
    }
  }

  return (
    <>
      <SiteNav />
      <PageShell>
        <Link className={backLinkClass} href="/">
          ← Kembali ke beranda
        </Link>

        <div className="mt-3">
          <PageHeader
            eyebrow="Untuk pemilik & pengelola Tempat"
            title="Ajukan menjadi Pengelola"
            description="Pengelola mengelola Tempat, Kegiatan, Kunjungan, dan menayangkan proses produksi secara Live di SINGGAH LOKAL. Pengajuan memakai akun SINGGAH LOKAL-mu — email dan password Pengelola sama dengan akun ini, tidak ada akun terpisah."
          />
        </div>

        <div className="mt-5 grid gap-5">
          {!user ? (
            <Panel>
              <p className="text-sm font-semibold">Masuk dulu untuk mengajukan</p>
              <p className={`mt-1 text-black/65 ${metaTextClass}`}>
                Pengajuan Pengelola terikat ke akun SINGGAH LOKAL yang sedang masuk. Masuk atau daftar
                dulu, lalu kamu kembali ke halaman ini untuk mengajukan.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href="/auth?returnTo=%2Fproducer%2Fonboarding" className={btn.primary}>
                  Masuk untuk mengajukan
                </Link>
                <Link href="/auth/sign-up?returnTo=%2Fproducer%2Fonboarding" className={btn.secondary}>
                  Daftar akun
                </Link>
              </div>
            </Panel>
          ) : (
            <Panel>
              <p className="text-sm font-semibold">Mengajukan dengan akun ini</p>
              <p className={`mt-1 text-black/65 ${metaTextClass}`}>Anda mengajukan sebagai Pengelola menggunakan akun:</p>
              <p className="mt-2 rounded-xl bg-brand-cream px-3 py-2 text-sm font-bold text-brand-ink">
                {user.email ?? "Akun SINGGAH LOKAL"}
              </p>
              <p className={`mt-2 text-black/50 ${metaTextClass}`}>
                Ingin memakai email berbeda? Keluar, lalu masuk dengan akun yang dimaksud terlebih
                dahulu — pengajuan selalu mengikuti akun yang sedang masuk. Tidak ada email atau
                password Pengelola terpisah.
              </p>
              <ProducerApplicationClient
                initialStatus={application?.status ?? "none"}
                serviceAvailable={application !== null}
              />
            </Panel>
          )}

          <Section title="Alur pengajuan">
            <ol className="grid gap-2">
              {/* The three application steps. The copy lives here, in the
                  rendered surface, exactly as the Master states it. */}
              {[
                {
                  title: "Ajukan dari akun ini",
                  body: "Kirim pengajuan. Pengajuan tercatat atas akun SINGGAH LOKAL yang sedang masuk.",
                },
                {
                  title: "Admin memverifikasi",
                  body: "Admin platform memverifikasi Tempat dan bukti pengelolaan, lalu mengaktifkan hak akses Pengelola untuk akun yang mengaju.",
                },
                {
                  title: "Masuk dengan email & password yang sama",
                  body: "Begitu aksesnya aktif, masuk kembali dengan akun yang sama dan area Pengelola terbuka otomatis: Dashboard, Tempat, Permintaan Kunjungan, dan Live. Tidak ada akun atau password Pengelola kedua.",
                },
              ].map((step, index) => (
                <li key={step.title} className="flex gap-3 rounded-xl border border-black/10 bg-white px-3 py-2.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-accent/15 text-xs font-bold text-brand-accent" aria-hidden>
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{step.title}</span>
                    <span className={`mt-0.5 block text-black/60 ${metaTextClass}`}>{step.body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </PageShell>
    </>
  );
}
