"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_MEDIA_ACCEPTED_TYPES,
  AI_MEDIA_MAX_BYTES,
  AI_MEDIA_OUTPUT_SLOTS,
  AI_MEDIA_SOURCE_SLOTS,
  AiMediaError,
  isAiMediaRegenerationUnlocked,
  validateAiMediaSourceFile,
  validateAiMediaSourceKey,
  type AiMediaSourceKey,
} from "@/lib/ai-media";

/**
 * AI PLACE MEDIA — Producer surface (foundation, locked).
 *
 * The 4 source photos (Tempat / Bahan / Proses Produksi / Hasil) are PRIVATE
 * inputs for the AI media foundation. They coexist with the standard 5 photo
 * slots and never replace them: different tab, different API, different private
 * bucket. Uploading a source REPLACES that slot (the server RPC is keyed by
 * place + producer + source key) and the original file the Producer uploaded is
 * stored unchanged.
 *
 * Generated media is DERIVED media: the 2 outputs (Hook Image + Place Story
 * Image) are drafts until the Producer approves them through the existing
 * approval API, and nothing is ever auto-published. Hook approval may update
 * the canonical cover only through that server path; Place Story stays
 * separate from the cover.
 *
 * Generation is NOT exposed here. No AI provider is integrated and there is no
 * client generation endpoint, so the generation area reports the honest
 * locked/unavailable state instead of pretending a generation happened, and
 * "Generate Ulang" stays locked — never an active action.
 *
 * The UI mirrors the server limits for instant pick-time feedback only; the
 * server re-validates every write and stays the authority.
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
  ai_media_source_type_invalid: "Format file tidak didukung (gunakan JPG, PNG, WebP, atau AVIF).",
  ai_media_source_size_invalid: "Ukuran foto melebihi batas (maksimal 5 MB).",
  ai_media_source_upload_failed: "Foto sumber tidak dapat disimpan. Coba lagi.",
  ai_media_output_key_invalid: "Jenis gambar tidak dikenali.",
  ai_media_output_not_found: "Gambar belum tersedia.",
  ai_media_output_not_draft: "Gambar ini sudah tidak berstatus draft.",
  ai_media_status_invalid: "Status keputusan tidak valid.",
  ai_media_approval_failed: "Keputusan tidak dapat disimpan. Coba lagi.",
  ai_media_promotion_failed: "Gambar tidak dapat dipublikasikan. Coba lagi.",
  ai_media_bucket_missing: "Penyimpanan AI Media belum tersedia. Hubungi pengelola platform.",
  ai_media_unavailable: "AI Media tidak dapat dimuat. Coba lagi.",
  authentication_required: "Sesi berakhir. Masuk kembali sebagai Pengelola Tempat ini.",
  producer_authorization_required: "Kamu tidak memiliki akses mengelola AI Media Tempat ini.",
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
      byteSize: typeof row.byteSize === "number" ? row.byteSize : 0,
      uploadedAt: typeof row.uploadedAt === "string" ? row.uploadedAt : "",
    };
  }
  return next;
}

function mapOutputRows(rows: OutputState[]): OutputState[] {
  return rows.map((output) => ({
    outputKey: String(output.outputKey),
    status: String(output.status),
    provider: output.provider ?? null,
    generatedAt: String(output.generatedAt ?? ""),
    approvedAt: output.approvedAt ?? null,
    previewUrl: output.previewUrl ?? null,
    publicUrl: output.publicUrl ?? null,
  }));
}

export default function PlaceAiMediaPanel({ placeId }: { placeId: string }) {
  const [sources, setSources] = useState<Partial<Record<AiMediaSourceKey, SourceState>>>({});
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState("");
  const [outputs, setOutputs] = useState<OutputState[]>([]);
  const [outputsLoading, setOutputsLoading] = useState(true);
  const [outputsError, setOutputsError] = useState("");
  const [slotBusy, setSlotBusy] = useState<Record<string, boolean>>({});
  const [slotError, setSlotError] = useState<Record<string, string>>({});
  const [decisionBusy, setDecisionBusy] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");

  // Both reads are independent: a failure in one never blanks the other, and an
  // empty/incomplete source set is a normal state — it must never block the rest
  // of the Place editor. These loaders are used by the upload/approval handlers
  // to re-read the canonical server state after a confirmed write.
  const loadSources = useCallback(async () => {
    try {
      const response = await fetch(`/api/producer/places/${placeId}/ai-media`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSourcesError(aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")));
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
      const response = await fetch(`/api/producer/places/${placeId}/ai-media/outputs`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOutputsError(aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")));
        return;
      }
      setOutputs(mapOutputRows((data.outputs ?? []) as OutputState[]));
      setOutputsError("");
    } catch {
      setOutputsError(aiMediaErrorLabel("ai_media_unavailable"));
    } finally {
      setOutputsLoading(false);
    }
  }, [placeId]);

  // Initial load follows the repo's mount-fetch pattern: setState only inside
  // the promise callbacks, never synchronously in the effect body. The panel is
  // keyed by the Place id, so switching Places remounts it with fresh state.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/producer/places/${placeId}/ai-media`)
      .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setSourcesError(aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")));
          return;
        }
        setSources(mapSourceRows((data.sources ?? []) as SourceRow[]));
      })
      .catch(() => {
        if (!cancelled) setSourcesError(aiMediaErrorLabel("ai_media_unavailable"));
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });

    fetch(`/api/producer/places/${placeId}/ai-media/outputs`)
      .then(async (response) => ({ ok: response.ok, data: await response.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setOutputsError(aiMediaErrorLabel(String(data.error ?? "ai_media_unavailable")));
          return;
        }
        setOutputs(mapOutputRows((data.outputs ?? []) as OutputState[]));
      })
      .catch(() => {
        if (!cancelled) setOutputsError(aiMediaErrorLabel("ai_media_unavailable"));
      })
      .finally(() => {
        if (!cancelled) setOutputsLoading(false);
      });

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
      const response = await fetch(`/api/producer/places/${placeId}/ai-media/sources/${sourceKey}`, {
        method: "POST",
        body,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSlotError((current) => ({
          ...current,
          [sourceKey]: aiMediaErrorLabel(String(data.error ?? "ai_media_source_upload_failed")),
        }));
        return;
      }
      // Re-read the canonical list so the preview comes from a freshly signed
      // private URL minted by the server (never a client-side assumption).
      await loadSources();
      setMessage(replacing ? "Foto sumber diganti." : "Foto sumber tersimpan.");
    } catch {
      setSlotError((current) => ({ ...current, [sourceKey]: aiMediaErrorLabel("ai_media_source_upload_failed") }));
    } finally {
      setSlotBusy((current) => ({ ...current, [sourceKey]: false }));
    }
  }

  async function decideOutput(outputKey: string, status: "approved" | "rejected") {
    setDecisionBusy((current) => ({ ...current, [outputKey]: true }));
    setOutputsError("");
    try {
      const response = await fetch(`/api/producer/places/${placeId}/ai-media/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outputKey, status }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOutputsError(aiMediaErrorLabel(String(data.error ?? "ai_media_approval_failed")));
        return;
      }
      // The server decided; re-read the canonical outputs instead of assuming.
      await loadOutputs();
      setMessage(status === "approved" ? "Gambar disetujui." : "Gambar ditolak.");
    } catch {
      setOutputsError(aiMediaErrorLabel("ai_media_approval_failed"));
    } finally {
      setDecisionBusy((current) => ({ ...current, [outputKey]: false }));
    }
  }

  const completedSources = AI_MEDIA_SOURCE_SLOTS.filter((slot) => Boolean(sources[slot.key])).length;
  const sourcesComplete = completedSources === AI_MEDIA_SOURCE_SLOTS.length;
  const regenerationLocked = !isAiMediaRegenerationUnlocked();

  return (
    <div className="grid min-w-0 gap-4">
      {/* 4 SOURCE PHOTOS — private inputs for the AI media foundation. They are
          additional derived-media inputs: the standard 5 photo slots are
          untouched and live on their own tab. */}
      <div className="grid min-w-0 gap-3">
        <div>
          <span className="text-sm font-semibold">Foto Sumber AI ({AI_MEDIA_SOURCE_SLOTS.length} slot)</span>
          <p className="mt-1 text-xs text-black/55">
            Foto sumber bersifat privat dan hanya untuk membuat gambar AI — bukan sampul Tempat.
            Format {AI_MEDIA_ACCEPTED_TYPES.join(", ")} — maksimal {Math.round(AI_MEDIA_MAX_BYTES / (1024 * 1024))} MB per foto.
            File yang kamu unggah disimpan apa adanya.
          </p>
        </div>
        {sourcesLoading && <p className="text-xs text-black/55" role="status">Memuat foto sumber...</p>}
        {sourcesError && <p className="text-xs font-semibold text-red-700" role="alert">{sourcesError}</p>}
        {AI_MEDIA_SOURCE_SLOTS.map((slot) => (
          <AiMediaSourceSlot
            key={slot.key}
            label={slot.label}
            hint={slot.promptHint}
            state={sources[slot.key] ?? null}
            busy={Boolean(slotBusy[slot.key])}
            error={slotError[slot.key] ?? ""}
            onUpload={(file) => uploadSource(slot.key, file)}
          />
        ))}
      </div>

      {/* GENERATION — locked/unavailable. No provider is integrated and there
          is no client generation endpoint, so NO active generation control is
          rendered. "Generate Ulang" stays locked. */}
      <section className="grid min-w-0 gap-2 rounded-lg border border-dashed border-black/20 bg-brand-cream p-3" aria-label="Pembuatan Gambar AI">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-accent">Pembuatan Gambar AI</p>
          <span className="text-[11px] font-semibold text-black/50">
            Foto sumber: {completedSources}/{AI_MEDIA_SOURCE_SLOTS.length}
          </span>
        </div>
        <p className="text-xs text-black/55">
          {sourcesComplete
            ? "Keempat foto sumber sudah lengkap."
            : "Lengkapi keempat foto sumber di atas untuk menyiapkan gambar AI."}
        </p>
        <p className="text-xs font-semibold text-black/60" role="note">
          Pembuatan gambar AI belum dapat dijalankan — belum ada penyedia AI yang terhubung. Setelah tersedia,
          gambar hasil tetap berstatus draft sampai kamu menyetujuinya.
        </p>
        {regenerationLocked && (
          <p className="text-xs text-black/45" role="note">
            Generate Ulang terkunci dan tidak dapat dijalankan dari sini.
          </p>
        )}
      </section>

      {/* 2 GENERATED OUTPUTS — exactly Hook Image + Place Story Image. Both are
          drafts until the Producer approves them through the existing approval
          API. Nothing is auto-published. */}
      <div className="grid min-w-0 gap-3">
        <div>
          <span className="text-sm font-semibold">Hasil Gambar AI ({AI_MEDIA_OUTPUT_SLOTS.length})</span>
          <p className="mt-1 text-xs text-black/55">
            Kedua gambar berstatus draft sampai kamu menyetujui atau menolaknya. Menyetujui Hook Image dapat
            memperbarui sampul Tempat melalui jalur persetujuan server; Place Story Image tetap terpisah dari sampul.
          </p>
        </div>
        {outputsLoading && <p className="text-xs text-black/55" role="status">Memuat gambar AI...</p>}
        {AI_MEDIA_OUTPUT_SLOTS.map((slot) => {
          const output = outputs.find((item) => item.outputKey === slot.key) ?? null;
          const busy = Boolean(decisionBusy[slot.key]);
          const imageUrl = output?.previewUrl ?? output?.publicUrl ?? null;
          return (
            <div className="grid min-w-0 gap-2 rounded-lg border border-black/10 p-3" key={slot.key}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-accent">{slot.label}</p>
                {output && (
                  <span className="rounded-full border border-black/10 bg-white px-2 py-0.5 text-[11px] font-bold text-black/60">
                    {outputStatusLabel(output.status)}
                  </span>
                )}
              </div>
              <p className="text-xs text-black/55">{slot.description}</p>
              {imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl}
                  alt={slot.label}
                  className={`rounded-lg border border-black/10 object-cover ${
                    slot.aspect === "portrait" ? "mx-auto h-56 w-full max-w-[200px]" : "h-36 w-full"
                  }`}
                />
              ) : (
                <div className="grid h-28 place-items-center rounded-lg border border-dashed border-black/15 bg-brand-cream text-xs text-black/45">
                  {output ? "Pratinjau tidak tersedia." : "Belum ada gambar."}
                </div>
              )}
              {output && output.status === "draft" && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => decideOutput(slot.key, "approved")}
                    className="rounded-lg bg-brand-ink px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                  >
                    {busy ? "Menyimpan..." : "Setujui"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => decideOutput(slot.key, "rejected")}
                    className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                  >
                    Tolak
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {outputsError && <p className="text-xs font-semibold text-red-700" role="alert">{outputsError}</p>}
      </div>

      {message && <p className="text-sm text-black/60" role="status">{message}</p>}
    </div>
  );
}

function AiMediaSourceSlot({ label, hint, state, busy, error, onUpload }: {
  label: string;
  hint: string;
  state: SourceState | null;
  busy: boolean;
  error: string;
  onUpload: (file: File) => void;
}) {
  const [pickerError, setPickerError] = useState("");
  // A real, clickable button opens the file picker; the hidden input still owns
  // the file (native accept list, form semantics), matching the standard photo
  // slots.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onFileChange = (candidate: File | null) => {
    if (!candidate) return;
    try {
      // The server re-validates on every write; this only gives instant
      // feedback so a bad file never costs a round-trip.
      validateAiMediaSourceFile({ type: candidate.type, size: candidate.size });
      setPickerError("");
      onUpload(candidate);
    } catch (caught) {
      setPickerError(aiMediaErrorLabel(caught instanceof AiMediaError ? caught.code : "ai_media_source_upload_failed"));
    }
    // Allow re-selecting the same file (e.g. after a fix) to fire again.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="grid min-w-0 gap-2 rounded-lg border border-black/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-accent">{label}</p>
        <span className="text-[11px] font-semibold text-black/50">{state ? "Tersimpan" : "Belum ada"}</span>
      </div>
      <p className="text-xs text-black/55">{hint}</p>
      {state?.signedUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.signedUrl} alt={label} className="h-36 w-full rounded-lg border border-black/10 object-cover" />
      ) : (
        <div className="grid h-36 place-items-center rounded-lg border border-dashed border-black/15 bg-brand-cream text-xs text-black/45">
          {state ? "Tersimpan — pratinjau tidak tersedia." : "Belum ada foto sumber."}
        </div>
      )}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          accept={AI_MEDIA_ACCEPTED_TYPES.join(",")}
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-xs font-bold text-black/70 transition hover:border-brand-accent/60 hover:text-brand-ink disabled:opacity-50"
        >
          {busy ? "Mengunggah..." : state ? "Ganti foto sumber" : "Unggah foto sumber"}
        </button>
      </div>
      {pickerError && <p className="text-xs font-semibold text-red-700" role="alert">{pickerError}</p>}
      {error && <p className="text-xs font-semibold text-red-700" role="alert">{error}</p>}
    </div>
  );
}
