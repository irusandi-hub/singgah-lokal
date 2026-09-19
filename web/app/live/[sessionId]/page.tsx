import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerPlaceExperienceRepository } from "@/lib/place-experience-repository";
import { getServerProductionStoryRepository } from "@/lib/production-story-repository";
import { LiveViewerClient } from "./LiveViewerClient";

export const dynamic = "force-dynamic";

export default async function LiveViewerPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: session } = await supabase
    .from("live_sessions")
    .select("id, place_id, stage_id, status, started_at, ended_at, ended_reason, viewer_peak, live_input_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (!session) {
    notFound();
  }

  const status = session.status as "scheduled" | "live" | "ended";
  if (status === "scheduled") {
    // Phase 2 has no scheduled Live; fail closed.
    notFound();
  }

  const placeRepository = await getServerPlaceExperienceRepository();
  const place = await placeRepository.getPublishedPlaceById(session.place_id);
  if (!place) {
    // Unpublished Place: never expose the Live (fail-closed visibility).
    notFound();
  }

  const stage = await (await getServerProductionStoryRepository()).getById(session.place_id, session.stage_id, true);
  const isEnded = status === "ended";

  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#20231f]">
      <div className="mx-auto max-w-3xl px-5 py-6 sm:px-8">
        <Link className="text-sm font-bold text-[#7b5b38]" href={`/places/${place.id}`}>
          ← Kembali ke {place.name}
        </Link>

        <section className="mt-6 overflow-hidden rounded-[28px] border border-black/10 bg-[#20231f] shadow-sm">
          {/* Video stage. Playback is provisioned server-side only
              (Cloudflare playback token via admission); B1 keeps viewer
              admission DENY for everyone until verified-age lands, so this
              surface intentionally shows the gate state instead of video. */}
          <div className="relative flex aspect-video items-center justify-center bg-black">
            {isEnded ? (
              <div className="p-8 text-center">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-white/50">Live berakhir</p>
                <p className="mt-2 text-lg font-black text-white">Live ini sudah selesai</p>
                <p className="mt-1 text-xs text-white/60">
                  Tidak ada rekaman — Live tidak direkam (kebijakan platform).
                </p>
              </div>
            ) : (
              <div className="p-8 text-center">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#e8c47c]">LIVE SEKARANG</p>
                <p className="mt-2 text-lg font-black text-white">
                  Menunggu verifikasi akses Live
                </p>
                <p className="mt-1 text-xs text-white/60">
                  Akses Live memerlukan akun terverifikasi (email terverifikasi + usia ≥ 18).
                </p>
              </div>
            )}
            {!isEnded && (
              <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-[#b3261e] px-3 py-1.5 text-[11px] font-black uppercase tracking-widest text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                Live
              </div>
            )}
          </div>

          {/* Status / viewers / process strip */}
          <div className="grid gap-4 border-t border-white/10 bg-[#20231f] p-5 sm:grid-cols-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">Status</p>
              <p className="mt-1 text-sm font-bold text-white">{isEnded ? "Berakhir" : "Sedang tayang"}</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">Penonton (puncak)</p>
              <p className="mt-1 text-sm font-bold text-white">{session.viewer_peak} / 100</p>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/45">Proses</p>
              <p className="mt-1 text-sm font-bold text-white">{stage?.title ?? "Proses produksi"}</p>
            </div>
          </div>
        </section>

        {isEnded && (
          <section className="mt-6 rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Live berakhir</p>
            <p className="mt-2 text-sm text-black/70">
              Live ini telah diakhiri. Tidak ada rekaman atau tayangan ulang — Live bersifat real-time saja.
            </p>
            <Link
              className="mt-4 inline-flex rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white"
              href={`/places/${place.id}`}
            >
              Kembali ke Place
            </Link>
          </section>
        )}

        {!isEnded && (
          <LiveViewerClient
            sessionId={session.id}
            processTitle={stage?.title ?? "Proses produksi"}
            placeId={place.id}
            placeName={place.name}
          />
        )}

        <section className="mt-6 rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Tentang Place ini</p>
          <h2 className="mt-2 text-xl font-black tracking-tight">{place.name}</h2>
          <p className="mt-1 text-sm text-black/55">{place.area}</p>
          <Link
            className="mt-4 inline-flex rounded-full border border-black/10 bg-[#f7f5ef] px-4 py-2 text-sm font-bold"
            href={`/places/${place.id}`}
          >
            Buka Place
          </Link>
        </section>
      </div>
    </main>
  );
}
