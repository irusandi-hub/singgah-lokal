import Link from "next/link";
import SiteNav from "@/components/site-nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// The header resolves auth state itself (session probe) — Masuk/Daftar vs
// [email · Kelola Akun · Keluar]. Producer entry lives in /account, not the
// main header.

export const dynamic = "force-dynamic";

// Live index: lists currently live sessions from canonical live_sessions.
// With Supabase unconfigured this renders the signed-out empty state (the
// platform may run without DB env vars), never an error page.
export default async function LiveIndexPage() {
  let liveItems: Array<{ sessionId: string; processTitle: string | null; placeName: string; placeId: string }> = [];
  let loadError = false;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("live_sessions")
      .select("id, status, process_title, places(name, id)")
      .eq("status", "live");
    if (error) throw error;
    liveItems = (data ?? []).map((row: Record<string, unknown>) => {
      const place = row.places as { name?: string; id?: string } | null;
      return {
        sessionId: String(row.id),
        processTitle: (row.process_title as string | null) ?? null,
        placeName: place?.name ?? "",
        placeId: place?.id ?? "",
      };
    });
  } catch {
    loadError = true;
  }

  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#20231f]">
      <SiteNav />
      <section className="mx-auto max-w-4xl px-5 pb-12 pt-6">
        <h1 className="text-2xl font-black tracking-tight">Live Sekarang</h1>
        <p className="mt-2 text-sm text-black/55">
          Proses produksi yang sedang berjalan dari Place terverifikasi. Live tidak direkam.
        </p>

        {loadError ? (
          <div className="mt-8 rounded-2xl border border-black/10 bg-white p-8 text-center">
            <p className="text-sm font-bold">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className="mt-1 text-xs text-black/55">
              Coba lagi nanti atau jelajahi Place lain.
            </p>
            <Link href="/" className="mt-4 inline-block rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white">
              Kembali ke Beranda
            </Link>
          </div>
        ) : liveItems.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-black/10 bg-white p-8 text-center">
            <p className="text-sm font-bold">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className="mt-1 text-xs text-black/55">
              Ketika sebuah Place memulai Live, proses produksinya otomatis muncul di sini.
            </p>
            <Link href="/" className="mt-4 inline-block rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white">
              Kembali ke Beranda
            </Link>
          </div>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {liveItems.map((item) => (
              <Link key={item.sessionId} href={`/live/${item.sessionId}`} className="rounded-2xl border border-[#b3261e]/30 bg-white p-5 shadow-sm transition hover:shadow-md">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#b3261e] px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-white">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                  Live Sekarang
                </span>
                <p className="mt-3 text-sm font-black">{item.processTitle ?? "Proses produksi"}</p>
                <p className="mt-0.5 text-xs text-black/55">{item.placeName}</p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
