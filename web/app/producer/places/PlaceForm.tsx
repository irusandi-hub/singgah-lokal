"use client";

import { useEffect, useRef, useState } from "react";
import type { Place } from "@/lib/places";
import { APPLICATION_CURRENCIES, PLACE_CATEGORIES, PLACE_CURRENCY_LABELS } from "@/lib/places";
import {
  PLACE_MEDIA_ACCEPTED_TYPES,
  PLACE_MEDIA_MAX_BYTES,
  PLACE_PHOTO_SLOTS,
  PlaceMediaError,
  validatePlaceMediaFile,
} from "@/lib/place-media";
import PlaceLocationPicker from "@/components/place-location-picker";
import PlaceGeoFields from "@/components/place-geo-fields";
import { publicationStatusLabel } from "@/lib/status-labels";
import ExperiencesPanel from "./[placeId]/experiences/ExperiencesPanel";
import PlaceAiMediaPanel from "./PlaceAiMediaPanel";
import { btn } from "@/components/ui/kit";

type Props = { place?: Place; onSaved?: (place: Place) => void };

type SlotPhoto = {
  id: string;
  url: string | null;
  storagePath: string;
  title: string;
  description: string;
};

type SlotState = {
  slotKey: string;
  filled: boolean;
  photo: SlotPhoto | null;
};

const formLegend = "text-[13px] font-bold uppercase tracking-[0.12em] text-black/45";
const tabBase = "rounded-full px-3.5 py-1.5 text-xs font-bold transition";
const tabActive = "bg-brand-accent text-white";
const tabIdle = "border border-black/10 bg-white text-black/60 hover:bg-black/[0.04]";

function emptyPlaceForm(): Record<string, string> {
  return {
    id: "", name: "", shortDescription: "",
    category: "Sumber Daya Alam", type: "production", area: "",
    countryCode: "", regionName: "",
    address: "", contactInformation: "",
    currency: "IDR",
    latitude: "", longitude: "",
  };
}

export default function PlaceForm({ place, onSaved }: Props) {
  // NEW vs EDIT is explicit: `place` present = edit an existing record and
  // its saved values are the initial state; absent = NEW entry, which always
  // starts empty. The key marker makes React re-initialize (not reuse) the
  // form state when switching between NEW and EDIT remounts, so a previous
  // mount's transient input can never resurrect here.
  const isEdit = Boolean(place);
  const [form, setForm] = useState<Record<string, string>>(
    place
      ? {
          id: place.id, name: place.name, shortDescription: place.shortDescription,
          category: place.category, type: place.type, area: place.area,
          countryCode: place.countryCode ?? "", regionName: place.regionName ?? "",
          address: place.address, contactInformation: place.contactInformation,
          currency: place.currency,
          latitude: place.latitude?.toString() ?? "", longitude: place.longitude?.toString() ?? "",
        }
      : emptyPlaceForm(),
  );
  const [message, setMessage] = useState("");
  // Editor tabs (PO, 2026-09-26; Media UX restructure 2026-10-07):
  //   Informasi  — the existing Place fields;
  //   Kegiatan   — the experiences surface;
  //   Media      — MEDIA TEMPAT: the TWO ALTERNATIVE media methods.
  // The Media tab needs a SAVED Place (both media APIs are keyed by the Place
  // id), so it is disabled with an explanation while a NEW entry has no id yet
  // — and becomes active the moment the save succeeds (new → edit).
  const [editorTab, setEditorTab] = useState<"detail" | "experience" | "media">("detail");
  // MEDIA METHOD — exactly one of the two alternative methods, chosen by the
  // Producer. Only the chosen method is rendered and its state is never mixed
  // with the other one, so the media surface presents one clear workflow
  // instead of "5 manual slots + 4 AI slots" side by side. The choice is UI
  // state only: no database field is invented for it.
  const [mediaMethod, setMediaMethod] = useState<"manual" | "generate-ai" | null>(null);

  // MEDIA — standard photo slots (Supabase Storage upload; NO HTTP-URL
  // input). State is restored from the canonical place_photos record on
  // mount/reload so every photo + title + description survives a refresh.
  const [slots, setSlots] = useState<Record<string, SlotState>>({});
  const [slotBusy, setSlotBusy] = useState<Record<string, boolean>>({});
  const [slotError, setSlotError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!place) return;
    let cancelled = false;
    fetch(`/api/producer/places/${place.id}/photos`)
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error("photos unavailable"))))
      .then((payload: { slots: SlotState[] }) => {
        if (cancelled) return;
        const byKey: Record<string, SlotState> = {};
        for (const slot of payload.slots ?? []) byKey[slot.slotKey] = slot;
        setSlots(byKey);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [place]);

  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function uploadSlot(slotKey: string, file: File, title: string, description: string, mode: "save" | "replace") {
    if (!place) {
      setSlotError((current) => ({ ...current, [slotKey]: "Simpan Tempat dulu sebelum mengunggah foto." }));
      return;
    }
    setSlotBusy((current) => ({ ...current, [slotKey]: true }));
    setSlotError((current) => ({ ...current, [slotKey]: "" }));
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("title", title);
      body.append("description", description);
      const response = await fetch(`/api/producer/places/${place.id}/photos/${slotKey}`, { method: "POST", body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel(String(data.error ?? "place_media_upload_failed")) }));
        return;
      }
      setSlots((current) => ({
        ...current,
        [slotKey]: {
          slotKey,
          filled: true,
          photo: { id: data.id, url: data.url, storagePath: data.storagePath, title: data.title, description: data.description },
        },
      }));
      if (mode === "replace") setMessage("Foto diganti.");
      else setMessage("Foto tersimpan.");
    } catch {
      setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel("place_media_upload_failed") }));
    } finally {
      setSlotBusy((current) => ({ ...current, [slotKey]: false }));
    }
  }

  async function removeSlot(slotKey: string) {
    if (!place) return;
    setSlotBusy((current) => ({ ...current, [slotKey]: true }));
    setSlotError((current) => ({ ...current, [slotKey]: "" }));
    try {
      const response = await fetch(`/api/producer/places/${place.id}/photos/${slotKey}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setSlots((current) => ({ ...current, [slotKey]: { slotKey, filled: false, photo: null } }));
        setMessage("Foto dihapus.");
      } else {
        // No silent failure: a rejected delete (auth, authorization, storage)
        // surfaces as the slot's error state — the UI must never claim a
        // success the backend did not confirm.
        setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel(String(data.error ?? "place_media_upload_failed")) }));
      }
    } finally {
      setSlotBusy((current) => ({ ...current, [slotKey]: false }));
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("Menyimpan...");
    const payload = {
      ...form,
      latitude: form.latitude ? Number(form.latitude) : null,
      longitude: form.longitude ? Number(form.longitude) : null,
    };
    const response = await fetch(place ? `/api/producer/places/${place.id}` : "/api/producer/places", {
      method: place ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Tempat tidak dapat disimpan"); return; }
    setMessage(`Tersimpan — Status: ${publicationStatusLabel(data.publicationStatus)}`);
    // A successful NEW-entry submit resets transient input so reopening the
    // form (or a route remount) starts empty again.
    if (!place) setForm(emptyPlaceForm());
    onSaved?.(data);
  }

  return (
    <form key={isEdit ? `edit-${place?.id}` : "new"} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" onSubmit={submit} autoComplete="off">
      {/* Editor tabs (PO, 2026-09-26): Detail Place = the Place fields;
          Upload = the standard photo slots. Upload requires a SAVED Place
          (the upload API is keyed by the Place id), so the tab stays
          disabled — with the reason shown — until the form is saved, and
          becomes active the moment the save succeeds. */}
      <div className="flex flex-wrap gap-2 border-b border-black/10 pb-3" role="tablist" aria-label="Editor Tempat">
        <button
          type="button"
          role="tab"
          aria-selected={editorTab === "detail"}
          onClick={() => setEditorTab("detail")}
          className={`${tabBase} ${editorTab === "detail" ? tabActive : tabIdle}`}
        >
          Informasi
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={editorTab === "experience"}
          disabled={!place}
          aria-disabled={!place}
          title={place ? undefined : "Simpan Tempat dulu — Kegiatan membutuhkan Tempat yang sudah tersimpan."}
          onClick={() => setEditorTab("experience")}
          className={`${tabBase} ${editorTab === "experience" ? tabActive : tabIdle} ${place ? "" : "cursor-not-allowed opacity-50"}`}
        >
          Kegiatan
        </button>
        {/* Media — MEDIA TEMPAT. ONE media surface holding the two ALTERNATIVE
            methods (Manual / Generate AI). It needs a SAVED Place (both media
            APIs are keyed by the id), so it follows the same
            disabled-until-saved rule as Kegiatan. */}
        <button
          type="button"
          role="tab"
          aria-selected={editorTab === "media"}
          disabled={!place}
          aria-disabled={!place}
          title={place ? undefined : "Simpan Tempat dulu — Media membutuhkan Tempat yang sudah tersimpan."}
          onClick={() => setEditorTab("media")}
          className={`${tabBase} ${editorTab === "media" ? tabActive : tabIdle} ${place ? "" : "cursor-not-allowed opacity-50"}`}
        >
          Media
        </button>
      </div>
      {!place && (
        <p className="min-w-0 break-words text-xs text-black/55" role="note">
          Tab Media aktif setelah Tempat disimpan — Tempat baru harus tersimpan (memiliki ID) terlebih dahulu.
        </p>
      )}

      {editorTab === "detail" && (
        <>
      <fieldset className="grid min-w-0 gap-3">
        <legend className={formLegend}>Identitas Tempat</legend>
      {      [["name", "Nama Tempat"], ["shortDescription", "Deskripsi singkat"], ["area", "Area"], ["address", "Alamat"], ["contactInformation", "Kontak"]].map(([key, label]) => (
        <label className="grid gap-1 text-sm font-semibold" key={key}>{label}<input required={key !== "contactInformation"} value={form[key]} onChange={(event) => update(key, event.target.value)} /></label>
      ))}
      </fieldset>
      <fieldset className="grid min-w-0 gap-3">
        <legend className={formLegend}>Lokasi &amp; klasifikasi</legend>
      <div className="grid min-w-0 gap-2">
        <span className="text-sm font-semibold">Lokasi Tempat</span>
        <PlaceLocationPicker
          latitude={form.latitude}
          longitude={form.longitude}
          onChange={(latitude, longitude) =>
            setForm((current) => ({ ...current, latitude, longitude }))
          }
        />
        <p className="text-xs leading-5 text-black/55">Koordinat dipilih pada peta — timezone dihitung otomatis di server dari koordinat saat Tempat disimpan.</p>
      </div>
      <PlaceGeoFields
        countryCode={form.countryCode}
        regionName={form.regionName}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
      />
      <p className="text-xs leading-5 text-black/55">Area diisi dengan nama area lokal; provinsi/wilayah dipilih dari daftar negara di atas.</p>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold">Kategori<select value={form.category} onChange={(event) => update("category", event.target.value)}>{PLACE_CATEGORIES.map((category) => (<option key={category} value={category}>{category}</option>))}</select></label>
        <label className="grid gap-1 text-sm font-semibold">Tipe<select value={form.type} onChange={(event) => update("type", event.target.value)}><option value="production">Produksi</option><option value="experience">Kegiatan</option></select></label>
      </div>
      <label className="grid gap-1 text-sm font-semibold">Currency<select value={form.currency} onChange={(event) => update("currency", event.target.value)}>{APPLICATION_CURRENCIES.map((currency) => (<option key={currency} value={currency}>{PLACE_CURRENCY_LABELS[currency]}</option>))}</select></label>
      </fieldset>
        </>
      )}

      {/* The "Experience" tab reuses the standalone experiences surface for
          this Place (same API, same links) — no parallel management UI.
          Reachable only for a SAVED Place (the tab needs the id). */}
      {editorTab === "experience" && place && (
        <section className="grid gap-3 rounded-xl border border-black/10 p-4" aria-label="Kegiatan Tempat">
          <ExperiencesPanel placeId={place.id} />
        </section>
      )}

      {/* MEDIA TEMPAT — the TWO ALTERNATIVE METHODS (approved concept):
          MANUAL or GENERATE AI. Exactly one method is rendered at a time, so
          there is never a second surface that also looks like the main upload
          workflow, and the manual slots are never combined with the AI source
          workflow. Reachable only for a SAVED Place. */}
      {editorTab === "media" && place && (
      <section className="grid min-w-0 gap-4" aria-label="Media Tempat">
        <div>
          <h2 className="text-[17px] font-semibold leading-snug tracking-tight">Media Tempat</h2>
          <p className="mt-1 text-xs text-black/55">
            Pilih salah satu metode media. Manual dan Generate AI adalah dua
            metode alternatif — pilih satu, bukan keduanya.
          </p>
        </div>

        {/* METHOD CHOOSER — the two alternative methods, side by side and
            explicit. Nothing is uploaded before a method is chosen. */}
        <div
          className="grid gap-3 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Metode media Tempat"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mediaMethod === "manual"}
            onClick={() => setMediaMethod("manual")}
            className={`grid min-w-0 gap-1 rounded-xl border p-3 text-left transition ${
              mediaMethod === "manual"
                ? "border-brand-accent bg-brand-accent/5 shadow-sm"
                : "border-black/10 bg-white hover:border-brand-accent/50"
            }`}
          >
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-accent">Manual</span>
            <span className="text-sm font-semibold">Kelola foto sendiri</span>
            <span className="text-xs text-black/55">
              Kamu mengunggah dan mengelola {PLACE_PHOTO_SLOTS.length} foto
              Tempat: judul, deskripsi, ganti, dan hapus per slot. Tidak ada
              gambar buatan AI di metode ini.
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mediaMethod === "generate-ai"}
            onClick={() => setMediaMethod("generate-ai")}
            className={`grid min-w-0 gap-1 rounded-xl border p-3 text-left transition ${
              mediaMethod === "generate-ai"
                ? "border-brand-accent bg-brand-accent/5 shadow-sm"
                : "border-black/10 bg-white hover:border-brand-accent/50"
            }`}
          >
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-accent">Generate AI</span>
            <span className="text-sm font-semibold">4 foto sumber → 2 gambar</span>
            <span className="text-xs text-black/55">
              Siapkan 4 foto sumber (Tempat, Bahan, Proses Produksi, Hasil).
              AI membuat 2 gambar: Cover dan Hook Horizontal. Kamu tetap
              menyetujui atau menolaknya.
            </span>
          </button>
        </div>

        {mediaMethod === null && (
          <p className="text-xs text-black/50" role="note">
            Pilih salah satu metode di atas untuk mulai mengelola media Tempat.
          </p>
        )}

        {/* METHOD A — MANUAL: the standard photo slots. Same locked upload API,
            same limits, same Storage bucket; nothing here is AI-generated. */}
        {mediaMethod === "manual" && (
      <section className="grid min-w-0 gap-3 rounded-xl border border-black/10 bg-white p-4" aria-label="Media manual Tempat">
        <div>
          <h3 className="text-[15px] font-semibold">Metode: Manual</h3>
          <p className="mt-1 text-xs text-black/55">
            Foto diunggah ke penyimpanan server melalui API upload yang sama;
            tidak ada input URL gambar. Slot Hook pada metode ini adalah sampul
            (cover) Tempat yang tampil di Home. Metode ini terpisah dari metode
            Generate AI.
          </p>
        </div>
        <div>
          <span className="text-sm font-semibold">Foto Tempat ({PLACE_PHOTO_SLOTS.length} slot)</span>
          <p className="mt-1 text-xs text-black/55">
            Setiap slot memakai judul dan deskripsi sendiri.
            Format {PLACE_MEDIA_ACCEPTED_TYPES.join(", ")} — maksimal {Math.round(PLACE_MEDIA_MAX_BYTES / (1024 * 1024))} MB per foto.
          </p>
        </div>
        {PLACE_PHOTO_SLOTS.map((slot) => {
          const state = slots[slot.key];
          const photo = state?.filled ? state.photo : null;
          const busy = Boolean(slotBusy[slot.key]);
          const error = slotError[slot.key];
          const hasSavedMeta = Boolean(photo);
          return (
            <div className="grid min-w-0 gap-2 rounded-lg border border-black/10 p-3" key={slot.key}>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-brand-accent">{slot.label}</p>
              <p className="text-xs text-black/55">{slot.titlePrompt} — {slot.descriptionPrompt}</p>
              {photo?.url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.url} alt={`${slot.label}: ${photo.title}`} className="h-36 w-full rounded-lg border border-black/10 object-cover" />
              )}
              {photo && (
                <div className="rounded-lg bg-brand-cream px-3 py-2 text-xs">
                  <p className="font-bold">{photo.title}</p>
                  <p className="mt-0.5 text-black/60">{photo.description}</p>
                </div>
              )}
              <PlacePhotoInputs
                slot={slot}
                busy={busy}
                hasSavedMeta={hasSavedMeta}
                disabled={!place}
                onUpload={(file, title, description, mode) => uploadSlot(slot.key, file, title, description, mode)}
              />
              {photo && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeSlot(slot.key)}
                    className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold"
                  >
                    Hapus foto
                  </button>
                </div>
              )}
              {error && <p className="text-xs font-semibold text-red-700" role="alert">{error}</p>}
            </div>
          );
        })}
      </section>
        )}

        {/* METHOD B — GENERATE AI: exactly 4 private source photos in, exactly
            2 generated outputs out (Cover + Hook Horizontal). It reuses the
            existing AI media APIs, approval flow and audit trail, and it is
            never merged with the manual slots above. */}
        {mediaMethod === "generate-ai" && (
      <section className="grid min-w-0 gap-4 rounded-xl border border-black/10 bg-white p-4" aria-label="Media Generate AI Tempat">
        <div>
          <h3 className="text-[15px] font-semibold">Metode: Generate AI</h3>
          <p className="mt-1 text-xs text-black/55">
            Empat foto sumber (Tempat, Bahan, Proses Produksi, Hasil) menjadi
            bahan dua gambar AI: Cover dan Hook Horizontal. Foto sumber ini
            terpisah dari foto Tempat pada metode Manual.
          </p>
        </div>
        <PlaceAiMediaPanel key={place.id} placeId={place.id} />
      </section>
        )}
      </section>
      )}

      {editorTab === "detail" && (
        <button className="rounded-lg bg-brand-ink px-4 py-3 text-sm font-bold text-white" type="submit">Simpan Tempat</button>
      )}
      {message && <p className="text-sm text-black/60" role="status">{message}</p>}
    </form>
  );
}

const MEDIA_ERROR_LABELS: Record<string, string> = {
  place_photo_file_required: "Pilih file foto terlebih dahulu.",
  place_photo_type_invalid: "Format file tidak didukung (gunakan JPG, PNG, WebP, atau AVIF).",
  place_photo_size_invalid: "Ukuran foto melebihi batas (maksimal 5 MB).",
  place_photo_title_invalid: "Judul foto wajib diisi (maksimal 120 karakter).",
  place_photo_description_invalid: "Deskripsi foto wajib diisi (maksimal 1000 karakter).",
  place_media_bucket_missing: "Penyimpanan foto (bucket) belum tersedia. Hubungi pengelola platform.",
  authentication_required: "Sesi berakhir. Masuk kembali sebagai Pengelola Tempat ini.",
  producer_authorization_required: "Kamu tidak memiliki akses mengelola foto Tempat ini.",
  place_media_upload_failed: "Foto tidak dapat disimpan. Coba lagi.",
};

export function mediaErrorLabel(code: string): string {
  return MEDIA_ERROR_LABELS[code] ?? "Foto tidak dapat disimpan. Coba lagi.";
}

function PlacePhotoInputs({ slot, busy, hasSavedMeta, disabled, onUpload }: {
  slot: { key: string; label: string };
  busy: boolean;
  hasSavedMeta: boolean;
  disabled: boolean;
  onUpload: (file: File, title: string, description: string, mode: "save" | "replace") => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pickerError, setPickerError] = useState("");
  // PO fix 2026-09-28: the file picker control must be a real, clickable
  // button — the bare file input rendered as static OS text ("Choose File / No
  // file chosen") that users could not reliably tap on a phone. The hidden
  // input still owns the file (native validation, accept list, form semantics);
  // the button only opens its picker, like the claim-evidence flow.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The same locked limits run SERVER-SIDE on every write (lib/place-media);
  // mirroring them at pick-time gives instant feedback instead of failing
  // only after a network round-trip. The server remains the authority.
  const onFileChange = (candidate: File | null) => {
    if (!candidate) return;
    try {
      validatePlaceMediaFile({ type: candidate.type, size: candidate.size });
      setPickerError("");
      setFile(candidate);
    } catch (error) {
      setFile(null);
      setPickerError(mediaErrorLabel(error instanceof PlaceMediaError ? error.code : "place_media_upload_failed"));
    }
  };

  return (
    <div className="grid min-w-0 gap-2">
      <label className="grid min-w-0 gap-1 text-xs font-semibold">
        Judul foto
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder={slot.label} />
      </label>
      <label className="grid gap-1 text-xs font-semibold">
        Deskripsi foto
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={2} />
      </label>
      <div className="grid gap-1">
        <span className="text-xs font-semibold">File foto</span>
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          accept={PLACE_MEDIA_ACCEPTED_TYPES.join(",")}
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-xs font-bold text-black/70 transition hover:border-brand-accent/60 hover:text-brand-ink"
        >
          {file ? `File dipilih: ${file.name}` : "Pilih file foto"}
        </button>
      </div>
      {pickerError && (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {pickerError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || disabled || !file || !title.trim() || !description.trim()}
          onClick={() => file && onUpload(file, title, description, "save")}
          className="rounded-lg bg-brand-ink px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
        >
          {busy ? "Mengunggah..." : hasSavedMeta ? "Simpan perubahan" : "Unggah foto"}
        </button>
        {hasSavedMeta && (
          <button
            type="button"
            disabled={busy || disabled || !file || !title.trim() || !description.trim()}
            onClick={() => file && onUpload(file, title, description, "replace")}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold"
          >
            Ganti foto
          </button>
        )}
      </div>
    </div>
  );
}

export function PlaceEditor({ id, onSaved }: { id: string; onSaved?: (place: Place) => void }) {
  const [place, setPlace] = useState<Place | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetch(`/api/producer/places/${id}`).then(async (response) => response.ok ? setPlace(await response.json()) : setError((await response.json()).error)); }, [id]);
  if (error) return <p className="rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</p>;
  if (!place) return <p className="text-sm text-black/60">Memuat Tempat...</p>;
  async function changeStatus(publicationStatus: Place["publicationStatus"]) {
    const response = await fetch(`/api/producer/places/${id}/publication`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicationStatus }) });
    const data = await response.json();
    if (response.ok) setPlace(data); else setError(data.error ?? "Status tidak dapat diubah");
  }
  return <><div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-black/10 bg-white px-3 py-2 text-xs text-black/60">Status: <strong>{publicationStatusLabel(place.publicationStatus)}</strong><span className="ml-auto flex flex-wrap gap-2"><button className={btn.compact} onClick={() => changeStatus(place.publicationStatus === "published" ? "paused" : "published")} type="button">{place.publicationStatus === "published" ? "Jeda" : "Tayangkan"}</button><button className={btn.compact} onClick={() => changeStatus("archived")} type="button">Arsipkan</button></span></div><PlaceForm place={place} onSaved={(saved) => { setPlace(saved); onSaved?.(saved); }} /></>;
}
