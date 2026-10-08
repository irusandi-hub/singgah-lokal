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
import PlaceAiMediaPanel from "./PlaceAiMediaPanel";
import { btn, metaTextClass, sectionTitleClass, tabActiveClass, tabIdleClass, tabItemClass } from "@/components/ui/kit";

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

/**
 * INFORMASI TEMPAT — the Place fields, nothing else.
 *
 * UI/UX restructure 2026-10-08: this surface used to own the editor's tab bar,
 * the publication-status panel and the media workflow. All three moved to the
 * ONE Place workspace (PlaceWorkspace.tsx) so a single page owns a single
 * context, a single navigation layer and a single status block. The form is
 * now just the compact field list — same fields, same server-side validation,
 * same endpoints. NEW (no `place`) starts empty; EDIT is initialized from the
 * saved record.
 */
export default function PlaceForm({ place, onSaved }: Props) {
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

  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));

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
    setMessage("Tersimpan.");
    if (!place) setForm(emptyPlaceForm());
    onSaved?.(data);
  }

  return (
    <form key={isEdit ? `edit-${place?.id}` : "new"} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" onSubmit={submit} autoComplete="off">
      {[["name", "Nama Tempat"], ["shortDescription", "Deskripsi singkat"], ["area", "Area"], ["address", "Alamat"], ["contactInformation", "Kontak"]].map(([key, label]) => (
        <label className="grid gap-1 text-sm font-semibold" key={key}>
          {label}
          <input required={key !== "contactInformation"} value={form[key]} onChange={(event) => update(key, event.target.value)} />
        </label>
      ))}

      <div className="grid min-w-0 gap-2">
        <span className="text-sm font-semibold">Lokasi Tempat</span>
        <PlaceLocationPicker
          latitude={form.latitude}
          longitude={form.longitude}
          onChange={(latitude, longitude) => setForm((current) => ({ ...current, latitude, longitude }))}
        />
        <p className={`text-black/55 ${metaTextClass}`}>Koordinat dipilih pada peta — timezone dihitung otomatis di server dari koordinat saat Tempat disimpan.</p>
      </div>

      <PlaceGeoFields
        countryCode={form.countryCode}
        regionName={form.regionName}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
      />

      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold">
          Kategori
          <select value={form.category} onChange={(event) => update("category", event.target.value)}>
            {PLACE_CATEGORIES.map((category) => (<option key={category} value={category}>{category}</option>))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Tipe
          <select value={form.type} onChange={(event) => update("type", event.target.value)}>
            <option value="production">Produksi</option>
            <option value="experience">Kegiatan</option>
          </select>
        </label>
      </div>

      <label className="grid gap-1 text-sm font-semibold">
        Currency
        <select value={form.currency} onChange={(event) => update("currency", event.target.value)}>
          {APPLICATION_CURRENCIES.map((currency) => (<option key={currency} value={currency}>{PLACE_CURRENCY_LABELS[currency]}</option>))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button className={`w-fit ${btn.solid}`} type="submit">Simpan Tempat</button>
        {message ? <p className={`text-black/60 ${metaTextClass}`} role="status">{message}</p> : null}
      </div>
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

/**
 * MEDIA TEMPAT — the two ALTERNATIVE methods, one at a time.
 *
 * The approved concept is unchanged (MANUAL or GENERATE AI, never both);
 * only the presentation was flattened (UI/UX restructure 2026-10-08): a
 * compact Manual | Generate AI selector instead of two large method cards, and
 * separated photo rows instead of a card inside a card. Every upload, replace,
 * delete, validation, API, storage and authorization rule is untouched.
 */
export function PlaceMediaPanel({ place }: { place: Place }) {
  const [mediaMethod, setMediaMethod] = useState<"manual" | "generate-ai" | null>(null);

  // MEDIA — standard photo slots (Supabase Storage upload; NO HTTP-URL input).
  // State is restored from the canonical place_photos record on mount/reload so
  // every photo + title + description survives a refresh.
  const [slots, setSlots] = useState<Record<string, SlotState>>({});
  const [slotBusy, setSlotBusy] = useState<Record<string, boolean>>({});
  const [slotError, setSlotError] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
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
  }, [place.id]);

  async function uploadSlot(slotKey: string, file: File, title: string, description: string, mode: "save" | "replace") {
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
      setMessage(mode === "replace" ? "Foto diganti." : "Foto tersimpan.");
    } catch {
      setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel("place_media_upload_failed") }));
    } finally {
      setSlotBusy((current) => ({ ...current, [slotKey]: false }));
    }
  }

  async function removeSlot(slotKey: string) {
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

  return (
    <section className="grid min-w-0 gap-4" aria-label="Media Tempat">
      {/* METHOD CHOOSER — compact, one choice at a time. Nothing is uploaded
          before a method is chosen, and the two methods are alternatives. */}
      <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Metode media Tempat">
        {[
          { key: "manual" as const, label: "Manual" },
          { key: "generate-ai" as const, label: "Generate AI" },
        ].map((method) => (
          <button
            key={method.key}
            type="button"
            role="radio"
            aria-checked={mediaMethod === method.key}
            onClick={() => setMediaMethod(method.key)}
            className={`${tabItemClass} ${mediaMethod === method.key ? tabActiveClass : tabIdleClass}`}
          >
            {method.label}
          </button>
        ))}
      </div>

      {mediaMethod === null && (
        <p className={`text-black/50 ${metaTextClass}`} role="note">
          Pilih salah satu metode di atas. Manual dan Generate AI adalah dua metode alternatif — pilih satu, bukan keduanya.
        </p>
      )}

      {/* METHOD A — MANUAL: the standard photo slots. Same locked upload API,
          same limits, same Storage bucket; nothing here is AI-generated. */}
      {mediaMethod === "manual" && (
        <section className="grid min-w-0 gap-3" aria-label="Media manual Tempat">
          <div>
            <h2 className={sectionTitleClass}>Foto Tempat ({PLACE_PHOTO_SLOTS.length} slot)</h2>
            <p className={`mt-1 text-black/55 ${metaTextClass}`}>
              Setiap slot memakai judul dan deskripsi sendiri. Format {PLACE_MEDIA_ACCEPTED_TYPES.join(", ")} — maksimal {Math.round(PLACE_MEDIA_MAX_BYTES / (1024 * 1024))} MB per foto.
              Slot Hook adalah sampul (cover) Tempat yang tampil di Home.
            </p>
          </div>
          {PLACE_PHOTO_SLOTS.map((slot) => {
            const state = slots[slot.key];
            const photo = state?.filled ? state.photo : null;
            const busy = Boolean(slotBusy[slot.key]);
            const error = slotError[slot.key];
            return (
              <div className="grid min-w-0 gap-2 border-t border-black/10 pt-3" key={slot.key}>
                <p className="text-xs font-bold text-brand-accent">{slot.label}</p>
                <p className={`text-black/55 ${metaTextClass}`}>{slot.titlePrompt} — {slot.descriptionPrompt}</p>
                {photo?.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photo.url} alt={`${slot.label}: ${photo.title}`} className="h-36 w-full rounded-lg border border-black/10 object-cover" />
                )}
                {photo && (
                  <div className={`rounded-lg bg-brand-cream px-3 py-2 ${metaTextClass}`}>
                    <p className="font-bold">{photo.title}</p>
                    <p className="mt-0.5 text-black/60">{photo.description}</p>
                  </div>
                )}
                <PlacePhotoInputs
                  slot={slot}
                  busy={busy}
                  hasSavedMeta={Boolean(photo)}
                  disabled={false}
                  onUpload={(file, title, description, mode) => uploadSlot(slot.key, file, title, description, mode)}
                />
                {photo && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removeSlot(slot.key)}
                      className={btn.compact}
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

      {/* METHOD B — GENERATE AI: exactly 4 private source photos in, exactly 2
          generated outputs out (Cover + Hook Horizontal). Same AI media APIs,
          approval flow and audit trail; never merged with the manual slots. */}
      {mediaMethod === "generate-ai" && (
        <section className="grid min-w-0 gap-3" aria-label="Media Generate AI Tempat">
          <div>
            <h2 className={sectionTitleClass}>4 foto sumber → 2 gambar</h2>
            <p className={`mt-1 text-black/55 ${metaTextClass}`}>
              Empat foto sumber (Tempat, Bahan, Proses Produksi, Hasil) menjadi bahan dua gambar AI: Cover dan Hook Horizontal. Kamu tetap menyetujui atau menolaknya.
            </p>
          </div>
          <PlaceAiMediaPanel key={place.id} placeId={place.id} />
        </section>
      )}

      {message ? <p className={`text-black/60 ${metaTextClass}`} role="status">{message}</p> : null}
    </section>
  );
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
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || disabled || !file || !title.trim() || !description.trim()}
          onClick={() => file && onUpload(file, title, description, "save")}
          className={btn.solid}
        >
          {busy ? "Mengunggah..." : hasSavedMeta ? "Simpan perubahan" : "Unggah foto"}
        </button>
        {hasSavedMeta && (
          <button
            type="button"
            disabled={busy || disabled || !file || !title.trim() || !description.trim()}
            onClick={() => file && onUpload(file, title, description, "replace")}
            className={btn.compact}
          >
            Ganti foto
          </button>
        )}
      </div>
    </div>
  );
}
