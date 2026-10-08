"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_MEDIA_ACCEPTED_TYPES,
  AI_MEDIA_MAX_BYTES,
  AI_MEDIA_OUTPUT_SLOTS,
  AI_MEDIA_SOURCE_SLOTS,
  AiMediaError,
  validateAiMediaSourceFile,
  validateAiMediaSourceKey,
  type AiMediaSourceKey,
} from "@/lib/ai-media";

/**
 * MEDIA TEMPAT — method B: GENERATE AI (SINGGAH LOKAL).
 *
 * This panel is ONE of the two alternative media methods (the other is MANUAL,
 * owned by the standard photo slots in PlaceForm). It is never combined with
 * manual slots: it has its own private source photos and its own generated
 * outputs.
 *
 * The locked flow:
 *  1. Prepare EXACTLY 4 source photos (Tempat / Bahan / Proses Produksi /
 *     Hasil). These private photos are the generation input and stay unchanged.
 *  2. When all 4 are ready and the server says generation is available, press
 *     "Buat Gambar".
 *  3. Review EXACTLY 2 generated outputs — COVER and HOOK HORIZONTAL. Both stay
 *     Draft until the Producer approves or rejects them:
 *       - Cover is the canonical Place cover. It reaches
 *         places.cover_image_url only through the existing server approval path.
 *       - Hook Horizontal communicates the production process by arranging the
 *         four source visuals in the locked sequence Tempat → Bahan → Proses
 *         Produksi → Hasil. It is NOT a generic 4-photo collage, and approving
 *         it never changes the Place cover.
 *
 * Nothing is auto-published. "Buat Gambar" is enabled only when the server says
 * generation is actually possible (provider configured + enabled, 4 sources
 * present, quota available). If no provider is connected the panel says so
 * honestly instead of faking a generation. "Generate Ulang" stays locked and is
 * never an active control.
 *
 * The UI mirrors server limits for instant pick-time feedback only; the server
 * re-validates every write and stays the authority.
 */

type SourceState = {
  signedUrl: string | null;
  mimeType: string;
  byteSize: number;
  uploadedAt: string;
};

type SourceRow = {
  sourceKey?: unknown;
  signedUrl?: unknown;
  mimeType?: unknown;
  byteSize?: unknown;
  uploadedAt?: unknown;
};

type OutputState = {
  outputKey: string;
  status: string;
  provider: string | null;
  generatedAt: string;
  approvedAt: string | null;
  previewUrl: string | null;
  publicUrl: string | null;
};

const OUTPUT_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Disetujui",
  rejected: "Ditolak",
};

const AI_MEDIA_ERROR_LABELS: Record<string, string> = {
  ai_media_source_key_invalid: "Slot foto sumber tidak dikenali.",
  ai_media_source_type_invalid:
    "Format file tidak didukung (gunakan JPG, PNG, WebP, atau AVIF).",
  ai_media_source_size_invalid:
    "Ukuran foto melebihi batas (maksimal 5 MB).",
  ai_media_source_upload_failed:
    "Foto sumber tidak dapat disimpan. Coba lagi.",
  ai_media_output_key_invalid: "Jenis gambar tidak dikenali.",
  ai_media_output_not_found: "Gambar belum tersedia.",
  ai_media_output_not_draft: "Gambar ini sudah tidak berstatus draft.",
  ai_media_status_invalid: "Status keputusan tidak valid.",
  ai_media_approval_failed: "Keputusan tidak dapat disimpan. Coba lagi.",
  ai_media_promotion_failed:
    "Gambar tidak dapat dipublikasikan. Coba lagi.",
  ai_media_bucket_missing:
    "Penyimpanan AI Media belum tersedia. Hubungi pengelola platform.",
  ai_media_unavailable: "AI Media tidak dapat dimuat. Coba lagi.",
  authentication_required:
    "Sesi berakhir. Masuk kembali sebagai Pengelola Tempat ini.",
  producer_authorization_required:
    "Kamu tidak memiliki akses mengelola AI Media Tempat ini.",
  ai_media_generation_locked:
    "Gambar AI belum dapat dibuat. Coba lagi nanti.",
  ai_media_generation_failed:
    "Gambar AI tidak dapat dibuat. Coba lagi.",
  ai_media_quota_exhausted:
    "Kuota AI habis. Coba lagi nanti.",
};

function aiMediaErrorLabel(code: string): string {
  return AI_MEDIA_ERROR_LABELS[code] ?? "AI Media tidak dapat diproses. Coba lagi.";
}

function outputStatusLabel(status: string): string {
  return OUTPUT_STATUS_LABELS[status] ?? status;
}

/** The source list is newest-first: the first row per key is the current source. */
function mapSourceRows(rows: SourceRow[]): Partial<Record<AiMediaSourceKey, SourceState>> {
  const next: Partial<Record<AiMediaSourceKey, SourceState>> = {};
  for (const row of rows) {
    const key = row.sourceKey;
    if (!validateAiMediaSourceKey(key) || next[key]) continue;
    next[key] = {
      signedUrl: typeof row.signedUrl === "string" ? row.signedUrl : null,
      mimeType: typeof row.mimeType === "string" ? row.mimeType : "",
      byteSize:
        typeof row.byteSize === "number" ? row.byteSize : 0,
      uploadedAt: typeof row.uploadedAt === "string" ? row.uploadedAt : "",
    };
  }
  return next;
}

type OutputRow = {
  outputKey?: unknown;
  status?: unknown;
  provider?: unknown;
  generatedAt?: unknown;
  approvedAt?: unknown;
  previewUrl?: unknown;
  publicUrl?: unknown;
};

function mapOutputRows(rows: OutputRow[]): OutputState[] {
  return rows.map((output) => ({
    outputKey: String(output.outputKey ?? ""),
    status: String(output.status ?? ""),
    provider: output.provider == null ? null : String(output.provider),
    generatedAt: String(output.generatedAt ?? ""),
    approvedAt: output.approvedAt == null ? null : String(output.approvedAt),
    previewUrl: output.previewUrl == null ? null : String(output.previewUrl),
    publicUrl: output.publicUrl == null ? null : String(output.publicUrl),
  }));
}

export default function PlaceAiMediaPanel({ placeId }: { placeId: string }) {
  const [sources, setSources] = useState<
    Partial<Record<AiMediaSourceKey, SourceState>>
  >({});
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState("");
  const [outputs, setOutputs] = useState<OutputState[]>([]);
  const [outputsLoading, setOutputsLoading] = useState(true);
  const [outputsError, setOutputsError] = useState("");
  const [generationCap, setGenerationCap] = useState<{
    available: boolean;
    reason?: string;
    provider?: string;
  } | null>(null);
  const [generationCapLoading, setGenerationCapLoading] = useState(true);
  const [slotBusy, setSlotBusy] = useState<Record<string, boolean>>({});
  const [slotError, setSlotError] = useState<Record<string, string>>({});
  const [decisionBusy, setDecisionBusy] = useState<Record<string, boolean>>({});
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [message, setMessage] = useState("");

  const loadSources = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/producer/places/${placeId}/ai-media`,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSourcesError(
          aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")),
        );
        return;
      }
      setSources(mapSourceRows((data.sources ?? []) as SourceRow[]));
      setSourcesError("");
    } catch {
      setSourcesError(aiMediaErrorLabel("ai_media_unavailable"));
    } finally {
      setSourcesLoading(false);
    }
  }, [placeId]);

  const loadOutputs = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/producer/places/${placeId}/ai-media/outputs`,
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOutputsError(
          aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")),
        );
        return;
      }
      setOutputs(mapOutputRows((data.outputs ?? []) as OutputRow[]));
      setOutputsError("");
    } catch {
      setOutputsError(aiMediaErrorLabel("ai_media_unavailable"));
    } finally {
      setOutputsLoading(false);
    }
  }, [placeId]);

  // Mount fetch follows the repo pattern: setState only inside the promise
  // callbacks, never synchronously in the effect body. The panel is keyed by
  // the Place id, so switching Places remounts it with fresh state.
  useEffect(() => {
    let cancelled = false;

    const fetchSources = () => {
      fetch(`/api/producer/places/${placeId}/ai-media`)
        .then(async (response) => ({
          ok: response.ok,
          data: await response.json().catch(() => ({})),
        }))
        .then(({ ok, data }) => {
          if (cancelled) return;
          if (!ok) {
            setSourcesError(
              aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")),
            );
            return;
          }
          setSources(mapSourceRows((data.sources ?? []) as SourceRow[]));
        })
        .catch(() => {
          if (!cancelled)
            setSourcesError(aiMediaErrorLabel("ai_media_unavailable"));
        })
        .finally(() => {
          if (!cancelled) setSourcesLoading(false);
        });
    };

    const fetchOutputs = () => {
      fetch(`/api/producer/places/${placeId}/ai-media/outputs`)
        .then(async (response) => ({
          ok: response.ok,
          data: await response.json().catch(() => ({})),
        }))
        .then(({ ok, data }) => {
          if (cancelled) return;
          if (!ok) {
            setOutputsError(
              aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")),
            );
            return;
          }
          setOutputs(mapOutputRows((data.outputs ?? []) as OutputRow[]));
        })
        .catch(() => {
          if (!cancelled)
            setOutputsError(aiMediaErrorLabel("ai_media_unavailable"));
        })
        .finally(() => {
          if (!cancelled) setOutputsLoading(false);
        });
    };

    const fetchGenerationCap = () => {
      fetch(`/api/producer/places/${placeId}/ai-media/generate`)
        .then(async (response) => ({
          ok: response.ok,
          data: await response.json().catch(() => ({})),
        }))
        .then((response) => {
          if (cancelled) return;
          const { ok, data } = response;
          if (!ok) {
            setGenerationCap({
              available: false,
              reason: aiMediaErrorLabel(
                String(data.error ?? "ai_media_unavailable"),
              ),
            });
            return;
          }
          setGenerationCap({
            available: data.available === true,
            reason: data.reason ?? undefined,
            provider: data.provider ?? undefined,
          });
        })
        .finally(() => {
          if (!cancelled) setGenerationCapLoading(false);
        });
    };

    fetchSources();
    fetchOutputs();
    fetchGenerationCap();

    return () => {
      cancelled = true;
    };
  }, [placeId]);

  async function uploadSource(sourceKey: AiMediaSourceKey, file: File) {
    const replacing = Boolean(sources[sourceKey]);
    setSlotBusy((current) => ({ ...current, [sourceKey]: true }));
    setSlotError((current) => ({ ...current, [sourceKey]: "" }));
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(
        `/api/producer/places/${placeId}/ai-media/sources/${sourceKey}`,
        {
          method: "POST",
          body,
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSlotError((current) => ({
          ...current,
          [sourceKey]:
            aiMediaErrorLabel(
              String(data.error ?? "ai_media_source_upload_failed"),
            ),
        }));
        return;
      }
      // Re-read the canonical list so the preview uses a freshly signed private
      // URL minted by the server (never a client assumption).
      await loadSources();
      setMessage(
        replacing ? "Foto sumber diganti." : "Foto sumber tersimpan.",
      );
    } catch {
      setSlotError((current) => ({
        ...current,
        [sourceKey]: aiMediaErrorLabel("ai_media_source_upload_failed"),
      }));
    } finally {
      setSlotBusy((current) => ({ ...current, [sourceKey]: false }));
    }
  }

  async function createGeneration() {
    if (!generationCap?.available) return;
    setGenerateBusy(true);
    setGenerateError("");
    try {
      const idempotencyKey =
        `initial-${placeId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await fetch(
        `/api/producer/places/${placeId}/ai-media/generate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setGenerateError(
          aiMediaErrorLabel(
            String(data.error ?? "ai_media_generation_failed"),
          ),
        );
        return;
      }
      // A queued job does not instantly create outputs. Re-read the canonical
      // outputs until the worker saves the drafts — a bounded poll, then the
      // honest empty state stays if nothing arrived.
      setMessage("Memulai pembuatan gambar AI...");
      const maxPolls = 12;
      for (let polled = 0; polled < maxPolls; polled += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const listResponse = await fetch(
          `/api/producer/places/${placeId}/ai-media/outputs`,
        );
        const listData = await listResponse.json().catch(() => ({}));
        setOutputs(mapOutputRows((listData.outputs ?? []) as OutputRow[]));
        if (Array.isArray(listData.outputs) && listData.outputs.length > 0) break;
      }
      setOutputsLoading(false);
    } catch {
      setGenerateError(aiMediaErrorLabel("ai_media_generation_failed"));
    } finally {
      setGenerateBusy(false);
    }
  }

  async function decideOutput(
    outputKey: string,
    status: "approved" | "rejected",
  ) {
    setDecisionBusy((current) => ({ ...current, [outputKey]: true }));
    setOutputsError("");
    try {
      const response = await fetch(
        `/api/producer/places/${placeId}/ai-media/approve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ outputKey, status }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOutputsError(
          aiMediaErrorLabel(
            String(data.error ?? "ai_media_approval_failed"),
          ),
        );
        return;
      }
      // The server decided; re-read the canonical outputs instead of assuming.
      await loadOutputs();
      setMessage(
        status === "approved" ? "Gambar disetujui." : "Gambar ditolak.",
      );
    } catch {
      setOutputsError(aiMediaErrorLabel("ai_media_approval_failed"));
    } finally {
      setDecisionBusy((current) => ({ ...current, [outputKey]: false }));
    }
  }

  const completedSources = AI_MEDIA_SOURCE_SLOTS.filter(
    (slot) => Boolean(sources[slot.key]),
  ).length;
  const sourcesComplete =
    completedSources === AI_MEDIA_SOURCE_SLOTS.length;
  const generationAvailable =
    generationCap?.available === true &&
    sourcesComplete &&
    !generateBusy;
  const regenerationLocked = true; // locked for now; never client-controlled.

  return (
    <div className="grid min-w-0 gap-5">
      {/* STEP 1 — EXACTLY 4 SOURCE PHOTOS */}
      <section className="grid min-w-0 gap-4" aria-label="Foto sumber AI">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">1. Foto sumber (4)</h3>
            <p className="mt-0.5 text-xs text-black/55">
              Empat foto ini adalah bahan baku privat untuk membuat gambar AI:
              Tempat, Bahan, Proses Produksi, dan Hasil. Foto asli yang kamu
              unggah tidak berubah dan tidak menggantikan foto Tempat pada
              metode Manual. Format {AI_MEDIA_ACCEPTED_TYPES.join(", ")} —
              maksimal {Math.round(AI_MEDIA_MAX_BYTES / (1024 * 1024))} MB per
              foto.
            </p>
          </div>
          <span className="rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-bold">
            {completedSources}/{AI_MEDIA_SOURCE_SLOTS.length}
          </span>
        </div>

        {sourcesLoading && (
          <p className="text-xs text-black/55" role="status">
            Memuat foto sumber...
          </p>
        )}
        {sourcesError && (
          <p className="text-xs font-semibold text-red-700" role="alert">
            {sourcesError}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {AI_MEDIA_SOURCE_SLOTS.map((slot) => {
            const state = sources[slot.key] ?? null;
            const busy = Boolean(slotBusy[slot.key]);
            const error = slotError[slot.key] ?? "";
            return (
              <AiMediaSourceCard
                key={slot.key}
                label={slot.label}
                hint={slot.promptHint}
                state={state}
                busy={busy}
                error={error}
                onUpload={(file) => uploadSource(slot.key, file)}
              />
            );
          })}
        </div>
      </section>

      {/* STEP 2 — BUAT GAMBAR */}
      <section
        className={`grid min-w-0 gap-3 rounded-xl border p-4 ${
          generationAvailable
            ? "border-brand-accent/30 bg-brand-accent/5"
            : "border-black/10 bg-brand-cream"
        }`}
        aria-label="Buat Gambar AI"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">2. Buat Gambar</h3>
          <span className="text-[11px] font-semibold text-black/50">
            Foto sumber: {completedSources}/4
          </span>
        </div>

        <p className="text-xs text-black/60">
          AI membuat tepat dua gambar: Cover dan Hook Horizontal.
        </p>

        {generationCapLoading ? (
          <p className="text-xs text-black/55" role="status">
            Memeriksa ketersediaan gambar AI...
          </p>
        ) : !sourcesComplete ? (
          <p className="text-xs text-black/60">
            Lengkapi keempat foto sumber di atas sebelum membuat gambar.
          </p>
        ) : generationCap?.available === false ? (
          <>
            <p className="text-xs text-black/60">
              Keempat foto sumber sudah lengkap.
            </p>
            <p className="text-xs font-semibold text-red-700" role="alert">
              {generationCap.reason ??
                "Gambar AI belum dapat dibuat."}
            </p>
            {generationCap.provider && (
              <p className="text-[11px] text-black/45">
                Penyedia yang terdaftar: {generationCap.provider}.
              </p>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={generateBusy}
              onClick={createGeneration}
              className="justify-self-start rounded-lg bg-brand-ink px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-ink/90 disabled:opacity-50"
            >
              {generateBusy ? "Membuat..." : "Buat Gambar"}
            </button>
            {generateError && (
              <p className="text-xs font-semibold text-red-700" role="alert">
                {generateError}
              </p>
            )}
          </>
        )}

        {regenerationLocked && (
          <p className="text-[11px] text-black/45" role="note">
            Generate Ulang terkunci dan tidak dapat dijalankan dari sini.
          </p>
        )}
      </section>

      {/* STEP 3 — EXACTLY 2 GENERATED OUTPUTS */}
      <section className="grid min-w-0 gap-4" aria-label="Hasil Gambar AI">
        <div>
          <h3 className="text-sm font-semibold">3. Hasil (2 gambar)</h3>
          <p className="mt-0.5 text-xs text-black/55">
            Kedua gambar berstatus draft sampai kamu menyetujui atau menolaknya.
            Menyetujui Cover memperbarui sampul Tempat melalui jalur persetujuan server.
            Menyetujui Hook Horizontal tidak mengubah sampul Tempat.
          </p>
        </div>

        {outputsLoading && (
          <p className="text-xs text-black/55" role="status">
            Memuat gambar AI...
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {AI_MEDIA_OUTPUT_SLOTS.map((slot) => {
            const output = outputs.find(
              (item) => item.outputKey === slot.key,
            ) ?? null;
            const busy = Boolean(decisionBusy[slot.key]);

            // The status check is mirrored here for rendering; the server
            // remains the authority on the canonical status.
            const outputStatus = output?.status ?? "";
            const isDraft = Boolean(output && output.status === "draft");

            return (
              <AiMediaOutputCard
                key={slot.key}
                label={slot.label}
                description={slot.description}
                aspect={slot.aspect}
                output={output}
                busy={busy}
                outputStatus={outputStatus}
                isDraft={isDraft}
                onApprove={() => decideOutput(slot.key, "approved")}
                onReject={() => decideOutput(slot.key, "rejected")}
              />
            );
          })}
        </div>

        {outputsError && (
          <p className="text-xs font-semibold text-red-700" role="alert">
            {outputsError}
          </p>
        )}
      </section>

      {message && (
        <p className="text-sm text-black/60" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function AiMediaSourceCard({
  label,
  hint,
  state,
  busy,
  error,
  onUpload,
}: {
  label: string;
  hint: string;
  state: SourceState | null;
  busy: boolean;
  error: string;
  onUpload: (file: File) => void;
}) {
  const [pickerError, setPickerError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onFileChange = (candidate: File | null) => {
    if (!candidate) return;
    try {
      validateAiMediaSourceFile({ type: candidate.type, size: candidate.size });
      setPickerError("");
      onUpload(candidate);
    } catch (caught) {
      setPickerError(
        aiMediaErrorLabel(
          caught instanceof AiMediaError ? caught.code : "ai_media_source_upload_failed",
        ),
      );
    }
    // Allow re-selecting the same file (e.g. after a fix) to fire again.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="grid min-w-0 gap-2 rounded-xl border border-black/10 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-accent">
          {label}
        </span>
        <span
          className={`text-[11px] font-semibold ${
            state ? "text-green-700" : "text-black/40"
          }`}
        >
          {state ? "Tersimpan" : "Belum ada"}
        </span>
      </div>

      <p className="text-xs text-black/55">{hint}</p>

      {state?.signedUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={state.signedUrl}
          alt={label}
          loading="lazy"
          decoding="async"
          className="h-32 w-full rounded-lg border border-black/10 object-cover"
        />
      ) : (
        <div className="grid h-32 place-items-center rounded-lg border border-dashed border-black/15 bg-brand-cream text-center text-xs text-black/45">
          {state ? "Tersimpan — pratinjau tidak tersedia." : "Belum ada foto sumber."}
        </div>
      )}

      {state?.signedUrl && (
        <div className="rounded-lg bg-brand-cream/60 px-3 py-2 text-xs">
          <span className="font-semibold text-black/70">
            {Math.round(state.byteSize / 1024)} KB
          </span>
          <span className="ml-2 text-black/40">
            {state.mimeType.split("/")[1] ?? ""}
          </span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        accept={AI_MEDIA_ACCEPTED_TYPES.join(",")}
        onChange={(event) =>
          onFileChange(event.target.files?.[0] ?? null)
        }
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
        className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-xs font-bold text-black/70 transition hover:border-brand-accent/60 hover:text-brand-ink disabled:opacity-50"
      >
        {busy
          ? "Mengunggah..."
          : state
            ? "Ganti foto sumber"
            : "Unggah foto sumber"}
      </button>

      {pickerError && (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {pickerError}
        </p>
      )}
      {error && (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function AiMediaOutputCard({
  label,
  description,
  aspect,
  output,
  busy,
  outputStatus,
  isDraft,
  onApprove,
  onReject,
}: {
  label: string;
  description: string;
  aspect: "portrait" | "landscape";
  output: OutputState | null;
  busy: boolean;
  outputStatus: string;
  isDraft: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const imageUrl = output?.previewUrl ?? output?.publicUrl ?? null;
  const isApproved = outputStatus === "approved";
  const isRejected = outputStatus === "rejected";

  return (
    <div
      className={`grid min-w-0 gap-2 rounded-xl border p-3 shadow-sm ${
        isApproved
          ? "border-green-700/30 bg-green-50"
          : isRejected
            ? "border-red-700/25 bg-red-50"
            : "border-black/10 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-accent">
          {label}
        </span>
        {output && (
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${
              isApproved
                ? "border-green-700/40 bg-green-100 text-green-800"
                : isRejected
                  ? "border-red-700/30 bg-red-100 text-red-800"
                  : "border-black/10 bg-white text-black/60"
            }`}
          >
            {outputStatusLabel(output.status)}
          </span>
        )}
      </div>

      <p className="text-xs text-black/55">{description}</p>

      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={label}
          loading="lazy"
          decoding="async"
          className={`rounded-lg border border-black/10 object-cover ${
            aspect === "portrait"
              ? "mx-auto h-44 w-full max-w-[180px]"
              : "h-32 w-full"
          }`}
        />
      ) : output ? (
        <div className="grid h-32 place-items-center rounded-lg border border-dashed border-black/15 bg-brand-cream text-xs text-black/45">
          {isDraft
            ? "Pratinjau belum tersedia."
            : isRejected
              ? "Gambar ditolak."
              : "Pratinjau tidak tersedia."}
        </div>
      ) : (
        <div className="grid h-32 place-items-center rounded-lg border border-dashed border-black/15 bg-brand-cream text-xs text-black/45">
          Belum ada gambar.
        </div>
      )}

      {isDraft && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onApprove}
            className="rounded-lg bg-brand-ink px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand-ink/90 disabled:opacity-50"
          >
            {busy ? "Menyimpan..." : "Setujui"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold transition hover:border-red-600/50 hover:text-red-700 disabled:opacity-50"
          >
            {busy ? "Menyimpan..." : "Tolak"}
          </button>
        </div>
      )}

      {isApproved && (
        <p className="text-[11px] text-green-800">
          Disetujui · gambar ini sudah terbaca secara publik.
        </p>
      )}

      {isRejected && (
        <p className="text-[11px] text-red-800">
          Ditolak · gambar ini tidak digunakan.
        </p>
      )}
    </div>
  );
}
