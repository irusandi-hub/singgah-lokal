import Link from "next/link";
import SiteNav from "@/components/site-nav";

export const metadata = {
  title: "Ajukan menjadi Producer — SINGGAH LOKAL",
};

// Pre-membership onboarding page. It explains the provisioning path and
// deliberately grants nothing: Producer authorization stays derived
// server-side from producer_memberships (owner/manager), so a regular
// account never self-assigns a role and no membership is created here.
export default function ProducerOnboardingPage() {
  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#20231f]">
      <SiteNav />

      <section className="mx-auto max-w-3xl px-5 pb-14 pt-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">
          Untuk pemilik & pengelola Place
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight">Ajukan menjadi Producer</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-black/60">
          Producer mengelola Place, Experience, Visit Intent, dan menayangkan proses produksi
          secara Live di SINGGAH LOKAL.
        </p>

        <ol className="mt-8 grid gap-4">
          <li className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-xs font-black uppercase tracking-wide text-[#7b5b38]">Langkah 1</p>
            <h2 className="mt-1 text-lg font-black">Punya akun SINGGAH LOKAL</h2>
            <p className="mt-1 text-sm leading-6 text-black/65">
              Akun biasa cukup untuk memulai. Pendaftaran tidak memberikan akses Producer secara
              otomatis.
            </p>
            <Link
              href="/auth/sign-up"
              className="mt-3 inline-flex rounded-full border border-black/10 bg-white px-4 py-2 text-xs font-bold text-black/70 hover:bg-black/5"
            >
              Daftar akun
            </Link>
          </li>
          <li className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-xs font-black uppercase tracking-wide text-[#7b5b38]">Langkah 2</p>
            <h2 className="mt-1 text-lg font-black">Ajukan Place untuk verifikasi</h2>
            <p className="mt-1 text-sm leading-6 text-black/65">
              Hubungi admin platform dengan data Place dan bukti pengelolaan. Admin memverifikasi
              Place, lalu memberikan membership Producer (owner/manager) melalui sistem.
            </p>
          </li>
          <li className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-xs font-black uppercase tracking-wide text-[#7b5b38]">Langkah 3</p>
            <h2 className="mt-1 text-lg font-black">Area Producer terbuka otomatis</h2>
            <p className="mt-1 text-sm leading-6 text-black/65">
              Begitu membership aktif dan kamu masuk kembali, navigasi Producer muncul sendiri:
              Dashboard, Places, Visit Intent Inbox, dan Live. Tidak ada yang perlu dikonfigurasi.
            </p>
          </li>
        </ol>

        <div className="mt-8 rounded-2xl border border-[#7b5b38]/25 bg-[#fffaf0] p-5 text-sm leading-6 text-black/70">
          <p className="font-bold">Sudah diverifikasi admin?</p>
          <p className="mt-1">
            Cukup <Link href="/auth" className="font-bold text-[#7b5b38] underline underline-offset-2">masuk</Link>{" "}
            dan buka <Link href="/producer" className="font-bold text-[#7b5b38] underline underline-offset-2">/producer</Link>.
            Jika area Producer belum muncul, membership-mu belum diaktifkan — hubungi admin platform.
          </p>
        </div>

        <Link href="/" className="mt-6 inline-block text-sm font-bold text-[#7b5b38]">
          ← Kembali ke beranda
        </Link>
      </section>
    </main>
  );
}
