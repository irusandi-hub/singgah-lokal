"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type StageOption = {
  id: string;
  title: string;
  sortOrder: number;
};

type Props = {
  places: Array<{ id: string; name: string; stages: StageOption[] }>;
};

type CameraCheck = {
  devices: MediaDeviceInfo[];
  resolution: string;
  frameRate: number;
  height: number;
  passed: boolean;
  error?: string;
};

type Broadcast = {
  pc: RTCPeerConnection;
  sessionUrl: string | null;
};

/**
 * Per-attempt idempotency key (policy §8, tech §4.2): one fresh key per start
 * attempt, reused only across retries of that same attempt so replays return
 * the original session without side effects. Never a hardcoded constant —
 * that would collapse every future start into the first session.
 */
const START_IDEMPOTENCY_KEY_PREFIX = "producer-live-start";
const END_IDEMPOTENCY_KEY_PREFIX = "producer-live-end";

function nextIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${START_IDEMPOTENCY_KEY_PREFIX}-${crypto.randomUUID()}`;
  }
  return `${START_IDEMPOTENCY_KEY_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function nextEndIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${END_IDEMPOTENCY_KEY_PREFIX}-${crypto.randomUUID()}`;
  }
  return `${END_IDEMPOTENCY_KEY_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function LiveConsole({ places }: Props) {
  const router = useRouter();
  const [placeId, setPlaceId] = useState(places[0]?.id ?? "");
  const [stageId, setStageId] = useState("");
  const [step, setStep] = useState<"choose" | "camera" | "preview" | "live">("choose");
  const [camera, setCamera] = useState<CameraCheck | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [broadcastLive, setBroadcastLive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const broadcastRef = useRef<Broadcast | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const endIdempotencyKeyRef = useRef<string | null>(null);

  const stages = useMemo(
    () => places.find((place) => place.id === placeId)?.stages ?? [],
    [places, placeId],
  );

  // Keep the stage selection valid when Place/Place stages change without
  // a setState-in-effect (lint rule react-hooks/set-state-in-effect).
  const effectiveStageId = stages.some((stage) => stage.id === stageId)
    ? stageId
    : stages[0]?.id ?? "";

  // Duration guard display: the locked 60-minute cap is enforced server-side
  // (self-healing cap); the console mirrors it so the Producer sees time left.
  useEffect(() => {
    if (step !== "live" || !startedAtRef.current) return;
    const interval = window.setInterval(() => {
      if (!startedAtRef.current) return;
      const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsedSeconds(Math.min(elapsed, 3600));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [step]);

  const stopPreview = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => stopPreview(), [stopPreview]);

  async function runCameraCheck() {
    setError(null);
    setCamera(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings();
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === "videoinput",
      );

      const resolution = settings?.width && settings?.height ? `${settings.width}x${settings.height}` : "?";
      const frameRate = Math.round(settings?.frameRate ?? 0);
      const height = Math.round(settings?.height ?? 0);
      // Locked quality: 720p/30fps (policy §6, tech §8). Both must be met.
      const passed = devices.length >= 1 && height >= 720 && frameRate >= 30;

      setCamera({ devices, resolution, frameRate, height, passed });
      if (videoRef.current) await videoRef.current.play().catch(() => undefined);
    } catch {
      setCamera({
        devices: [],
        resolution: "?",
        frameRate: 0,
        height: 0,
        passed: false,
        error: "Kamera tidak dapat diakses. Izinkan akses kamera dan coba lagi.",
      });
    }
  }

  async function startLive() {
    if (!placeId || !effectiveStageId) return;
    setBusy(true);
    setError(null);
    const idempotencyKey = nextIdempotencyKey();
    try {
      const response = await fetch("/api/producer/live/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeId, stageId: effectiveStageId, idempotencyKey }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        sessionId?: string;
        webRtcPublishUrl?: string | null;
        error?: string;
      };
      if (!response.ok || !payload.sessionId) {
        setError(startErrorMessage(payload.error));
        return;
      }
      setActiveSessionId(payload.sessionId);
      setStep("live");
      stopPreview();
      // WHIP ingest (PO item 1): publish the camera to the session's live
      // input immediately after the session starts. The publish URL is
      // issued only in this authorized start response.
      await publishToWhip(payload.sessionId, payload.webRtcPublishUrl ?? null);
    } finally {
      setBusy(false);
    }
  }

  /**
   * WHIP broadcast (tech §5 amended): captures the checked camera, adds each
   * track send-only to one peer connection, and POSTs the SDP offer to the
   * server-issued WHIP URL. No encoder/relay is implemented — the browser's
   * native WebRTC stack is the only publisher.
   */
  async function publishToWhip(sessionId: string, publishUrl: string | null) {
    setPublishing(true);
    try {
      if (!publishUrl) {
        // Re-issue from the server when the start replay path had no URL.
        const urlResponse = await fetch(`/api/producer/live/sessions/${sessionId}/publish-url`);
        if (!urlResponse.ok) {
          setError("Sesi Live dibuat, tetapi layanan streaming belum tersedia.");
          return;
        }
        const urlPayload = (await urlResponse.json()) as { publishUrl?: string };
        if (!urlPayload.publishUrl) {
          setError("Sesi Live dibuat, tetapi layanan streaming belum tersedia.");
          return;
        }
        publishUrl = urlPayload.publishUrl;
      }

      const media = streamRef.current ?? await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = media;

      const pc = new RTCPeerConnection();
      media.getTracks().forEach((track) => {
        pc.addTransceiver(track, { direction: "sendonly" });
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await fetch(publishUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp ?? "",
      });
      if (!response.ok) {
        pc.close();
        setError("Sambungan streaming ke penyedia gagal. Coba akhiri dan mulai Live lagi.");
        return;
      }
      const answer = await response.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      const location = response.headers.get("Location");
      broadcastRef.current = { pc, sessionUrl: location ? new URL(location, publishUrl).toString() : null };
      startedAtRef.current = Date.now();
      setBroadcastLive(true);
      setElapsedSeconds(0);
    } catch {
      setError("Penerbitan video gagal. Izinkan kamera dan coba lagi.");
    } finally {
      setPublishing(false);
    }
  }

  async function stopBroadcast() {
    const broadcast = broadcastRef.current;
    broadcastRef.current = null;
    startedAtRef.current = null;
    setBroadcastLive(false);
    if (broadcast?.sessionUrl) {
      await fetch(broadcast.sessionUrl, { method: "DELETE" }).catch(() => undefined);
    }
    broadcast?.pc.close();
  }

  async function endLive() {
    if (!activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const endIdempotencyKey =
        endIdempotencyKeyRef.current ?? nextEndIdempotencyKey();
      endIdempotencyKeyRef.current = endIdempotencyKey;

      const response = await fetch("/api/producer/live/sessions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId,
          idempotencyKey: endIdempotencyKey,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(endErrorMessage(payload.error));
        return;
      }
      setActiveSessionId(null);
      endIdempotencyKeyRef.current = null;
      setStep("choose");
      setAttested(false);
      setCamera(null);
      await stopBroadcast();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      {error && (
        <p className="rounded-2xl border border-[#b3261e]/30 bg-[#b3261e]/5 px-4 py-3 text-sm font-semibold text-[#b3261e]">
          {error}
        </p>
      )}

      {step === "choose" && (
        <section className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Langkah 1</p>
          <h2 className="mt-1 text-xl font-black tracking-tight">Pilih Proses yang akan ditayangkan</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">
              Place
              <select
                value={placeId}
                onChange={(event) => setPlaceId(event.target.value)}
                className="mt-1 w-full rounded-xl border border-black/10 bg-[#f7f5ef] px-3 py-2.5 text-sm font-semibold text-[#20231f]"
              >
                {places.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-bold uppercase tracking-[0.14em] text-black/45">
              Proses (harus published)
              <select
                value={effectiveStageId}
                onChange={(event) => setStageId(event.target.value)}
                className="mt-1 w-full rounded-xl border border-black/10 bg-[#f7f5ef] px-3 py-2.5 text-sm font-semibold text-[#20231f]"
              >
                {stages.length === 0 && <option value="">Tidak ada Proses published</option>}
                {stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    Tahap {stage.sortOrder + 1} • {stage.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            disabled={!stageId}
            onClick={() => {
              setStep("camera");
              void runCameraCheck();
            }}
            className="mt-5 rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40"
          >
            Lanjut ke pemeriksaan kamera
          </button>
        </section>
      )}

      {step === "camera" && (
        <section className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Langkah 2</p>
          <h2 className="mt-1 text-xl font-black tracking-tight">Pemeriksaan kamera</h2>
          <video ref={videoRef} muted playsInline className="mt-4 aspect-video w-full rounded-xl bg-black object-cover" />
          {camera && (
            <div className="mt-3 grid gap-1 text-xs text-black/65">
              <p>Perangkat video: {camera.devices.length}</p>
              <p>Resolusi: {camera.resolution} • Frame rate: {camera.frameRate} fps</p>
              {camera.passed ? (
                <p className="font-semibold">Kualitas memenuhi syarat: minimal 720p / 30 fps.</p>
              ) : (
                <p className="font-semibold text-[#b3261e]">
                  Kualitas belum memenuhi syarat: minimal 720p / 30 fps diperlukan.
                </p>
              )}
              {camera.error && <p className="font-semibold text-[#b3261e]">{camera.error}</p>}
            </div>
          )}
          <label className="mt-4 flex items-start gap-2 text-xs leading-5 text-black/65">
            <input
              type="checkbox"
              checked={attested}
              onChange={(event) => setAttested(event.target.checked)}
              className="mt-0.5"
            />
            Saya menggunakan 1 kamera statis tanpa gerakan (tanpa handheld, vlog, panning, following,
            multi-kamera, drone, body-cam).
          </label>
          <div className="mt-4 flex gap-2">
            <button
              disabled={!camera?.passed || !attested}
              onClick={() => setStep("preview")}
              className="rounded-full bg-[#20231f] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40"
            >
              Lanjut ke pratinjau
            </button>
            <button
              onClick={() => {
                stopPreview();
                void runCameraCheck();
              }}
              className="rounded-full border border-black/10 px-5 py-2.5 text-sm font-bold"
            >
              Ulangi cek
            </button>
          </div>
        </section>
      )}

      {step === "preview" && (
        <section className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Langkah 3</p>
          <h2 className="mt-1 text-xl font-black tracking-tight">Pratinjau</h2>
          <video ref={videoRef} muted playsInline autoPlay className="mt-4 aspect-video w-full rounded-xl bg-black object-cover" />
          <p className="mt-3 text-xs text-black/55">
            Kualitas dikunci 720p/30fps • 1 kamera statis • Live tidak direkam • tanpa monetisasi.
          </p>
          <div className="mt-4 flex gap-2">
            <button
              disabled={busy}
              onClick={startLive}
              className="rounded-full bg-[#b3261e] px-6 py-2.5 text-sm font-black text-white disabled:opacity-40"
            >
              {busy ? "Memulai..." : "Mulai Live"}
            </button>
            <button
              onClick={() => {
                stopPreview();
                setStep("choose");
              }}
              className="rounded-full border border-black/10 px-5 py-2.5 text-sm font-bold"
            >
              Batal
            </button>
          </div>
        </section>
      )}

      {step === "live" && (
        <section className="rounded-2xl border border-[#b3261e]/30 bg-[#b3261e]/5 p-5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#b3261e]" />
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#b3261e]">LIVE SEKARANG</p>
          </div>
          <h2 className="mt-1 text-xl font-black tracking-tight">Live sedang berjalan</h2>
          <p className="mt-2 text-sm text-black/65">
            Penonton maksimal 100 concurrent • durasi maksimal 60 menit • Live berakhir otomatis bila
            Proses ditarik dari published.
          </p>
          <p className="mt-2 text-xs font-bold text-[#b3261e]">
            {publishing
              ? "Menyambungkan kamera ke streaming..."
              : broadcastLive
                ? `Berlangsung ${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")} / 60:00`
                : "Kamera belum tersambung ke streaming."}
          </p>
          {elapsedSeconds >= 3600 && (
            <p className="mt-1 text-xs font-semibold text-[#b3261e]">
              Batas 60 menit tercapai — Live akan diakhiri otomatis oleh server.
            </p>
          )}
          <button
            disabled={busy || !activeSessionId}
            onClick={endLive}
            className="mt-4 rounded-full bg-[#20231f] px-6 py-2.5 text-sm font-black text-white disabled:opacity-40"
          >
            {busy ? "Mengakhiri..." : "Akhiri Live"}
          </button>
        </section>
      )}
    </div>
  );
}

function startErrorMessage(error?: string): string {
  switch (error) {
    case "live_boundary_unavailable":
      return "Layanan streaming belum tersedia. Coba lagi nanti.";
    case "live_cap_denied":
      return "Batas 5 Live aktif secara global sedang tercapai.";
    case "live_place_busy":
      return "Place ini sudah memiliki Live aktif (maksimal 1).";
    case "live_not_eligible":
      return "Place/Producer ini belum memenuhi syarat Live.";
    case "live_stage_not_published":
      return "Proses harus berstatus published untuk ditayangkan.";
    case "producer_authorization_required":
      return "Kamu tidak memiliki akses Producer untuk Place ini.";
    case "live_start_busy":
      return "Sedang ada pemulitan Live lain. Coba sesaat lagi.";
    default:
      return "Live tidak dapat dimulai.";
  }
}

function endErrorMessage(error?: string): string {
  if (error === "producer_authorization_required") {
    return "Kamu tidak memiliki akses Producer untuk Live ini.";
  }
  return "Live tidak dapat diakhiri. Coba lagi.";
}
