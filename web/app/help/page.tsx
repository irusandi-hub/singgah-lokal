import Link from "next/link";

/**
 * Help surface — pointer-only (2026-09-27 decision on the Account Menu audit).
 *
 * No FAQ answers, contact channel, or support policy is invented: every entry
 * explains a capability that already exists in the product and links to its
 * real surface (Live report flow, Notification Settings, bell inbox,
 * Producer onboarding). Facts come from locked sources only: MASTER_LIVE_POLICY
 * (recording OFF, real-time only), migration 0008 (verified-email admission
 * gate), the Live viewer report flow (PO item 4 review by Platform
 * Admin/Moderator), and the existing Producer application route.
 */
export default function HelpPage() {
  return (
    <main className="min-h-screen bg-brand-cream px-5 py-10 text-brand-ink sm:px-8">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-bold text-brand-accent">
          ← Beranda
        </Link>

        <header className="mt-8 border-b border-black/10 pb-6">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">Help</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Pusat bantuan</h1>
          <p className="mt-3 text-sm leading-6 text-black/60">
            Panduan singkat untuk fitur yang sudah tersedia. Setiap tautan mengarah ke area yang
            benar-benar ada di aplikasi.
          </p>
        </header>

        <div className="mt-8 grid gap-3">
          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Menonton Live</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-black/60">
              <li>Live disiarkan real-time — tidak ada rekaman dan tidak ada tayangan ulang.</li>
              <li>
                Akses Live dan komentar melewati admission gate server-side: akun dengan email
                terverifikasi, dengan kapasitas penonton terbatas per sesi.
              </li>
              <li>
                Jika Live menampilkan konten terlarang, gunakan tombol <b>Laporkan</b> di halaman
                Live. Laporan ditinjau oleh Platform Admin/Moderator platform.
              </li>
            </ul>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Notifikasi</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-black/60">
              <li>
                Inbox notifikasi tersedia melalui ikon lonceng di header.
              </li>
              <li>
                Preferensi notifikasi diatur di{" "}
                <Link href="/account/notifications" className="font-semibold text-brand-accent">
                  Setting → Notification Settings
                </Link>
                .
              </li>
            </ul>
          </section>

          <section className="rounded-2xl border border-black/10 bg-white p-6">
            <h2 className="text-lg font-semibold tracking-tight">Menjadi Pengelola</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-black/60">
              <li>
                Ingin menyiarkan Live dan mengelola Tempat milikmu? Ajukan melalui halaman{" "}
                <Link href="/producer/onboarding" className="font-semibold text-brand-accent">
                  pengajuan Pengelola
                </Link>
                . Akses Pengelola diberikan admin platform.
              </li>
            </ul>
          </section>
        </div>

        <p className="mt-8 text-xs leading-5 text-black/45">
          SINGGAH LOKAL MVP — hanya area yang tercantum di halaman ini yang tersedia saat ini.
        </p>
      </div>
    </main>
  );
}
