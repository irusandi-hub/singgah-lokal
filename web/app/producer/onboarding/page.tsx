import Link from "next/link";
import SiteNav from "@/components/site-nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getProducerApplicationStatus } from "@/lib/producer/application";
import ProducerApplicationClient from "./producer-application-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Ajukan menjadi Producer — SINGGAH LOKAL",
};

/**
 * Producer application (Authority Master: 1 akun = 1 identitas Producer).
 *
 * The application is bound to the signed-in account — there is no separate
 * Producer email/password/identity. An unauthenticated visitor is sent to
 * sign-in with returnTo back here; a signed-in user sees the account that
 * is applying, taken from the authenticated session (never typed freely).
 */
export default async function ProducerOnboardingPage() {
  // Fail-soft session probe: an unconfigured runtime must render the page
  // (with the sign-in CTA), not crash with 500.
  let user = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    user = data.user ?? null;
  } catch {
    user = null;
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
    <main className="min-h-screen bg-brand-cream text-brand-ink">
      <SiteNav />

      <section className="mx-auto max-w-3xl px-5 pb-14 pt-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">
          Untuk pemilik &amp; pengelola Place
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Ajukan menjadi Producer</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-black/60">
          Producer mengelola Place, Experience, Visit Intent, dan menayangkan proses produksi
          secara Live di SINGGAH LOKAL. Pengajuan memakai akun SINGGAH LOKAL-mu — email dan
          password Producer sama dengan akun ini, tidak ada akun terpisah.
        </p>

        {!user ? (
          <div className="mt-8 rounded-2xl border border-brand-accent/25 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Masuk dulu untuk mengajukan</h2>
            <p className="mt-2 text-sm leading-6 text-black/65">
              Pengajuan Producer terikat ke akun SINGGAH LOKAL yang sedang masuk. Masuk atau daftar
              dulu, lalu kamu kembali ke halaman ini untuk mengajukan.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href="/auth?returnTo=%2Fproducer%2Fonboarding"
                className="rounded-full bg-brand-primary px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-primary-deep"
              >
                Masuk untuk mengajukan
              </Link>
              <Link
                href="/auth/sign-up?returnTo=%2Fproducer%2Fonboarding"
                className="rounded-full border border-black/10 bg-white px-5 py-2.5 text-sm font-bold text-black/70 hover:bg-black/5"
              >
                Daftar akun
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-8 rounded-2xl border border-brand-accent/25 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Mengajukan dengan akun ini</h2>
            <p className="mt-2 text-sm leading-6 text-black/65">
              Anda mengajukan sebagai Producer menggunakan akun:
            </p>
            <p className="mt-2 rounded-xl bg-brand-cream px-4 py-3 text-sm font-bold text-brand-ink">
              {user.email ?? "Akun SINGGAH LOKAL"}
            </p>
            <p className="mt-3 text-xs leading-5 text-black/50">
              Ingin memakai email berbeda? Keluar, lalu masuk dengan akun yang dimaksud terlebih
              dahulu — pengajuan selalu mengikuti akun yang sedang masuk. Tidak ada email atau
              password Producer terpisah.
            </p>
            <ProducerApplicationClient
              initialStatus={application?.status ?? "none"}
              serviceAvailable={application !== null}
            />
          </div>
        )}

        <ol className="mt-8 grid gap-4">
          <li className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-accent">Langkah 1</p>
            <h2 className="mt-1 text-lg font-semibold">Ajukan dari akun ini</h2>
            <p className="mt-1 text-sm leading-6 text-black/65">
              Kirim pengajuan. Pengajuan tercatat atas akun SINGGAH LOKAL yang sedang masuk.
            </p>
          </li>
          <li className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-accent">Langkah 2</p>
            <h2 className="mt-1 text-lg font-semibold">Admin memverifikasi</h2>
            <p className="mt-1 text-sm leading-6 text-black/65">
              Admin platform memverifikasi Place dan bukti pengelolaan, lalu mengaktifkan
              membership Producer (owner/manager) untuk akun yang mengaju.
            </p>
          </li>
          <li className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-accent">Langkah 3</p>
            <h2 className="mt-1 text-lg font-semibold">Masuk dengan email &amp; password yang sama</h2>
            <p className="mt-1 text-sm leading-6 text-black/65">
              Begitu membership aktif, masuk kembali dengan akun yang sama dan area Producer
              terbuka otomatis: Dashboard, Places, Visit Intent Inbox, dan Live. Tidak ada akun
              atau password Producer kedua.
            </p>
          </li>
        </ol>

        <Link href="/" className="mt-6 inline-block text-sm font-bold text-brand-accent">
          ← Kembali ke beranda
        </Link>
      </section>
    </main>
  );
}
