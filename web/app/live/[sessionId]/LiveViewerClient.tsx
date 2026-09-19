"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LIVE_COMMENT_MAX_LENGTH } from "@/lib/live/types";

type Props = {
  sessionId: string;
  processTitle: string;
  placeId: string;
  placeName: string;
};

type ReportCategory = {
  value: string;
  label: string;
};

const REPORT_CATEGORIES: ReportCategory[] = [
  { value: "sexual_content", label: "Konten seksual" },
  { value: "graphic_violence", label: "Kekerasan grafis" },
  { value: "illegal_activity", label: "Aktivitas ilegal" },
  { value: "prohibited_product", label: "Produk terlarang" },
  { value: "smoking", label: "Merokok" },
  { value: "unsafe_activity", label: "Aktivitas tidak aman" },
  { value: "minor_as_subject", label: "Anak di bawah umur" },
  { value: "private_data", label: "Data pribadi" },
  { value: "other", label: "Lainnya" },
];

/**
 * Signed playback URL (tech §5, Phase 5): the provider-documented mechanism
 * is token-in-place-of-id — the short-lived RS256 token replaces the input
 * UID in the WHEP playback URL. The customer-subdomain comes from the
 * public config (non-secret); no credential is embedded client-side.
 */
function buildWhepUrl(token: string): string {
  const customerCode = process.env.NEXT_PUBLIC_STREAM_CUSTOMER_CODE ?? "";
  const host = customerCode
    ? `customer-${customerCode}.cloudflarestream.com`
    : "cloudflarestream.com";
  return `https://${host}/${token}/webRTC/play`;
}

export function LiveViewerClient({ sessionId, processTitle, placeId, placeName }: Props) {
  const [comments, setComments] = useState<Array<{ id: string; body: string }>>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [whepUrl, setWhepUrl] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportCategory, setReportCategory] = useState("other");
  const [reportNote, setReportNote] = useState("");
  const [reportDone, setReportDone] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // Comments are ephemeral: delivered over the session's Realtime broadcast
  // channel only, never persisted (policy §12.1 item 6; tech §6). B1 keeps
  // the server admission gate closed, so this feed stays empty until Phase 2.1.
  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;

    let channel: ReturnType<{ channel: ReturnType<typeof Object> }["channel"]> | null = null;
    let cancelled = false;

    (async () => {
      const { createClient } = await import("@supabase/supabase-js");
      const client = createClient(url, key, { realtime: { params: { eventsPerSecond: 5 } } });
      if (cancelled) {
        void client.removeAllChannels();
        return;
      }
      channel = client.channel(`live_session:${sessionId}`, { config: { broadcast: { self: false } } });
      channel.on("broadcast", { event: "comment" }, (message: { payload?: { body?: unknown; sequence?: unknown } }) => {
        const body = typeof message?.payload?.body === "string" ? message.payload.body : "";
        if (!body) return;
        setComments((current) => [...current.slice(-49), { id: `${message.payload?.sequence ?? ""}`, body }]);
      });
      // Realtime status event (tech §6): flip to the ended state in place
      // when the server broadcasts the end — no reload needed. Display-only;
      // canonical status remains Supabase (tech §6).
      channel.on("broadcast", { event: "status" }, (message: { payload?: { status?: unknown; endedReason?: unknown } }) => {
        if (message?.payload?.status === "ended") {
          setEndedReason(typeof message.payload.endedReason === "string" ? message.payload.endedReason : "ended");
        }
      });
      channel.subscribe();
    })();

    return () => {
      cancelled = true;
      channel?.unsubscribe();
    };
  }, [sessionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [comments]);

  // WHEP playback (PO item 2, tech §5 amended): one admission attempt per
  // mount. The server applies every gate (published Place, stream health,
  // verified email + content gate + B1 fail-closed age gate, 100-concurrent
  // cap) and issues the WHEP URL only inside the successful admission
  // response — the client never receives anything playable beforehand.
  useEffect(() => {
    if (endedReason) return;

    let cancelled = false;
    let pc: RTCPeerConnection | null = null;

    (async () => {
      const admission = await fetch("/api/live/playback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!admission.ok) {
        const payload = (await admission.json().catch(() => ({}))) as { error?: string };
        if (payload.error === "live_capacity_full") setPlaybackError("Live penuh (maksimal 100 penonton).");
        else if (payload.error === "live_stream_unavailable") setPlaybackError("Streaming belum tersedia.");
        else if (payload.error === "authentication_required") setPlaybackError("Masuk untuk menonton Live.");
        else setPlaybackError("Akses Live memerlukan verifikasi (email terverifikasi + usia ≥ 18).");
        return;
      }
      const payload = (await admission.json().catch(() => ({}))) as { token?: string };
      if (!payload.token) {
        setPlaybackError("Streaming tidak dapat diputar.");
        return;
      }
      if (cancelled) return;

      try {
        // Signed playback (tech §5, Phase 5): the short-lived RS256 token
        // replaces the input UID in the WHEP URL (provider-documented
        // token-in-place-of-id). The server never exposes the raw URL, and
        // the token is minted only after admission succeeds.
        const whepUrl = buildWhepUrl(payload.token);
        pc = new RTCPeerConnection();
        pcRef.current = pc;
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        const stream = new MediaStream();
        if (videoRef.current) videoRef.current.srcObject = stream;
        pc.ontrack = (event) => stream.addTrack(event.track);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const response = await fetch(whepUrl, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: offer.sdp ?? "",
        });
        if (!response.ok) {
          setPlaybackError("Streaming tidak dapat diputar.");
          return;
        }
        const answer = await response.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
        setWhepUrl(whepUrl);
      } catch {
        setPlaybackError("Streaming tidak dapat diputar.");
      }
    })();

    return () => {
      cancelled = true;
      pc?.close();
      pcRef.current = null;
    };
  }, [sessionId, endedReason]);

  async function submitComment() {
    const body = draft.trim();
    if (!body) return;
    setNotice(null);
    const response = await fetch("/api/live/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, body }),
    });
    if (response.ok) {
      setDraft("");
      return;
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (payload.error === "authentication_required") setNotice("Masuk untuk ikut berkomentar.");
    else if (payload.error === "live_viewer_denied") setNotice("Akses Live memerlukan verifikasi usia (≥ 18).");
    else if (payload.error === "live_capacity_full") setNotice("Live penuh (maksimal 100 penonton).");
    else if (payload.error === "live_session_not_live") setNotice("Live sudah berakhir.");
    else if (payload.error === "live_comment_rate_limited") setNotice("Tunggu sebentar sebelum berkomentar lagi.");
    else if (payload.error === "live_comment_rejected") setNotice("Komentar ditolak moderator (tidak sesuai aturan komunitas).");
    else setNotice("Komentar tidak dapat dikirim.");
  }

  async function submitReport() {
    const response = await fetch("/api/live/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, category: reportCategory, note: reportNote || undefined }),
    });
    if (response.ok) {
      setReportDone(true);
      setReportOpen(false);
      return;
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (payload.error === "authentication_required") setNotice("Masuk untuk melaporkan Live ini.");
    else if (payload.error === "live_viewer_denied") setNotice("Akses Live memerlukan verifikasi usia (≥ 18).");
    else setNotice("Laporan tidak dapat dikirim.");
  }

  // Realtime ended signal (tech §6): replace participation UI in place.
  if (endedReason) {
    return (
      <section className="mt-6 rounded-2xl border border-black/10 bg-white p-5 shadow-sm" aria-label="Live berakhir">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Live berakhir</p>
        <p className="mt-2 text-sm text-black/70">
          Live ini telah diakhiri. Tidak ada rekaman atau tayangan ulang — Live bersifat real-time saja.
        </p>
        <Link
          className="mt-4 inline-flex rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white"
          href={`/places/${placeId}`}
        >
          Kembali ke {placeName}
        </Link>
      </section>
    );
  }

  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2">
      {/* Video stage (WHEP playback; server-gated) */}
      <section className="rounded-2xl border border-black/10 bg-[#20231f] p-5 shadow-sm" aria-label="Video Live">
        <video ref={videoRef} autoPlay playsInline muted className="aspect-video w-full rounded-xl bg-black object-cover" />
        {playbackError && (
          <p className="mt-3 text-xs font-semibold text-[#e8c47c]">{playbackError}</p>
        )}
        {!playbackError && !whepUrl && (
          <p className="mt-3 text-xs text-white/60">
            Menunggu verifikasi akses Live (email terverifikasi + usia ≥ 18).
          </p>
        )}
      </section>

      {/* Comments (ephemeral) */}
      <section className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm" aria-label="Komentar Live">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Komentar</p>
          <span className="text-[10px] text-black/40">Ephemeral • tidak disimpan</span>
        </div>

        <div ref={listRef} className="mt-3 h-40 space-y-2 overflow-y-auto rounded-xl bg-[#f7f5ef] p-3">
          {comments.length === 0 ? (
            <p className="text-xs text-black/45">
              Komentar muncul real-time untuk penonton terverifikasi.
            </p>
          ) : (
            comments.map((comment) => (
              <p key={comment.id} className="rounded-lg bg-white px-3 py-2 text-xs text-black/75 shadow-sm">
                {comment.body}
              </p>
            ))
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            maxLength={LIVE_COMMENT_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Tanya soal ${processTitle.toLowerCase()}...`}
            className="w-full rounded-full border border-black/10 bg-[#f7f5ef] px-4 py-2.5 text-sm outline-none"
          />
          <button
            onClick={submitComment}
            className="rounded-full bg-[#20231f] px-4 py-2.5 text-sm font-bold text-white"
          >
            Kirim
          </button>
        </div>
        {notice && <p className="mt-2 text-xs font-semibold text-[#b3261e]">{notice}</p>}
      </section>

      {/* Report */}
      <section className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm" aria-label="Laporkan Live">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Laporkan Live</p>
        {reportDone ? (
          <p className="mt-3 text-sm font-semibold text-black/70">
            Terima kasih. Laporanmu diterima dan akan ditinjau moderator platform.
          </p>
        ) : reportOpen ? (
          <div className="mt-3 space-y-3">
            <select
              value={reportCategory}
              onChange={(event) => setReportCategory(event.target.value)}
              className="w-full rounded-xl border border-black/10 bg-[#f7f5ef] px-3 py-2.5 text-sm"
            >
              {REPORT_CATEGORIES.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </select>
            <textarea
              value={reportNote}
              maxLength={500}
              onChange={(event) => setReportNote(event.target.value)}
              placeholder="Catatan tambahan (opsional)"
              className="h-20 w-full rounded-xl border border-black/10 bg-[#f7f5ef] px-3 py-2.5 text-sm"
            />
            <div className="flex gap-2">
              <button onClick={submitReport} className="rounded-full bg-[#b3261e] px-4 py-2 text-sm font-bold text-white">
                Kirim laporan
              </button>
              <button onClick={() => setReportOpen(false)} className="rounded-full border border-black/10 px-4 py-2 text-sm font-bold">
                Batal
              </button>
            </div>
          </div>
        ) : (
          <div>
            <p className="mt-3 text-sm text-black/65">
              Laporkan jika Live menampilkan konten yang dilarang platform.
            </p>
            <button
              onClick={() => setReportOpen(true)}
              className="mt-4 rounded-full border border-[#b3261e] px-4 py-2 text-sm font-bold text-[#b3261e]"
            >
              Laporkan
            </button>
          </div>
        )}
        <p className="mt-4 text-[10px] leading-4 text-black/40">
          Live tidak direkam. Laporan ditinjau Platform Admin/Moderator.
        </p>
      </section>
    </div>
  );
}
