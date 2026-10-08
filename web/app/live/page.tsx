import Link from "next/link";
import SiteNav from "@/components/site-nav";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageHeader, PageShell, btn, metaTextClass } from "@/components/ui/kit";

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
    <>
      <SiteNav />
      <PageShell width="wide">
        <PageHeader
          title="Live Sekarang"
          description="Proses produksi yang sedang berjalan dari Tempat terverifikasi. Live tidak direkam."
        />

        {loadError ? (
          <div className="mt-4 rounded-2xl border border-dashed border-black/15 bg-white px-4 py-5">
            <p className="text-sm font-semibold">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className={`mt-1 text-black/55 ${metaTextClass}`}>
              Coba lagi nanti atau jelajahi Tempat lain.
            </p>
            <Link href="/" className={`mt-3 ${btn.secondary}`}>
              Kembali ke Beranda
            </Link>
          </div>
        ) : liveItems.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-black/15 bg-white px-4 py-5">
            <p className="text-sm font-semibold">Saat ini belum ada Live yang sedang berlangsung.</p>
            <p className={`mt-1 text-black/55 ${metaTextClass}`}>
              Ketika sebuah Tempat memulai Live, proses produksinya otomatis muncul di sini.
            </p>
            <Link href="/" className={`mt-3 ${btn.secondary}`}>
              Kembali ke Beranda
            </Link>
          </div>
        ) : (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {liveItems.map((item) => (
              <Link key={item.sessionId} href={`/live/${item.sessionId}`} className="rounded-xl border border-live/30 bg-white px-3 py-2.5 transition hover:bg-black/[0.02]">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-live px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-white">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                  Live Sekarang
                </span>
                <p className="mt-2 text-sm font-semibold">{item.processTitle ?? "Proses produksi"}</p>
                <p className={`mt-0.5 text-black/55 ${metaTextClass}`}>{item.placeName}</p>
              </Link>
            ))}
          </div>
        )}
      </PageShell>
    </>
  );
}
