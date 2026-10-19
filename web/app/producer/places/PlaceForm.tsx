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
  // A request that never reached the server (offline, connection dropped,
  // fetch rejected) is NOT a server rejection. It gets its own honest message
  // so the producer knows the photo was not confirmed either way.
  place_media_network_error: "Koneksi terputus. Foto belum tersimpan — periksa jaringan lalu coba lagi.",
};

/**
 * SAFE SLOT DEFAULTS (2026-10-19). A manual photo uploads the moment it is
 * picked, so the metadata fields can no longer be a prerequisite. When the
 * producer has not written a title/description yet, the upload carries a
 * non-empty value that is derived from the slot itself — the locked slot label
 * plus the Place name, and the slot's existing content prompt. Both are
 * truncated to the server's validation limits; nothing is invented about the
 * photo beyond naming the slot it belongs to.
 */
function slotDefaultMeta(placeName: string, slot: { label: string; descriptionPrompt: string }) {
  return {
    title: `${slot.label}: ${placeName}`.trim().slice(0, 120),
    description: slot.descriptionPrompt.trim().slice(0, 1000),
  };
}

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
  // One operation at a time PER SLOT. "upload" and "meta" only differ in the
  // status sentence the slot shows; both block a second request.
  const [slotBusy, setSlotBusy] = useState<Record<string, "upload" | "meta">>({});
  const busySlotsRef = useRef(new Set<string>());
  const [slotError, setSlotError] = useState<Record<string, string>>({});
  // A failed load must not look like "no photo saved yet": the saved photos are
  // reported as unavailable instead of silently rendering empty slots, and the
  // pickers stay disabled until the canonical state is known — uploading over
  // an unknown saved photo could silently replace it.
  const [loadError, setLoadError] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
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
        setLoadError("");
      })
      .catch(() => {
        if (!cancelled) setLoadError("Foto Tempat tidak dapat dimuat. Periksa koneksi lalu muat ulang.");
      });
    return () => {
      cancelled = true;
    };
  }, [place.id, reloadNonce]);

  const clearBusy = (slotKey: string) => {
    busySlotsRef.current.delete(slotKey);
    setSlotBusy((current) => {
      const next = { ...current };
      delete next[slotKey];
      return next;
    });
  };

  const slotPayload = (data: { id: string; url: string; storagePath: string; title: string; description: string }, slotKey: string): SlotState => ({
    slotKey,
    filled: true,
    photo: { id: data.id, url: data.url, storagePath: data.storagePath, title: data.title, description: data.description },
  });

  /**
   * IMMEDIATE UPLOAD (2026-10-19). The picker calls this as soon as a valid
   * file is chosen; there is no second "upload" click and the title/description
   * are not a gate (the caller substitutes safe slot defaults). The stored
   * photo is replaced only after the server confirms the write, so a failure
   * leaves the previous photo and its metadata intact.
   *
   * Returns whether the server confirmed the upload — the picker uses that to
   * stop showing the pending file name. A second request for the SAME slot is
   * ignored while one is running, at the parent level (not only in the UI).
   */
  async function uploadSlot(slotKey: string, file: File, title: string, description: string): Promise<boolean> {
    if (busySlotsRef.current.has(slotKey)) return false;
    busySlotsRef.current.add(slotKey);
    setSlotBusy((current) => ({ ...current, [slotKey]: "upload" }));
    setSlotError((current) => ({ ...current, [slotKey]: "" }));
    setMessage("");
    const replacing = Boolean(slots[slotKey]?.filled);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("title", title);
      body.append("description", description);
      const response = await fetch(`/api/producer/places/${place.id}/photos/${slotKey}`, { method: "POST", body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel(String(data.error ?? "place_media_upload_failed")) }));
        return false;
      }
      setSlots((current) => ({ ...current, [slotKey]: slotPayload(data, slotKey) }));
      setMessage(replacing ? "Foto diganti." : "Foto tersimpan.");
      return true;
    } catch {
      setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel("place_media_network_error") }));
      return false;
    } finally {
      clearBusy(slotKey);
    }
  }

  /**
   * METADATA EDIT (2026-10-19). Because a photo now uploads on pick, the
   * producer must still be able to refine its title/description afterwards.
   * This uses the SAME existing POST endpoint with no file: when the slot is
   * already saved the server updates only the metadata, leaves the Storage
   * object untouched, and therefore leaves the Hook cover unchanged too.
   */
  async function saveSlotMeta(slotKey: string, title: string, description: string): Promise<boolean> {
    if (busySlotsRef.current.has(slotKey)) return false;
    busySlotsRef.current.add(slotKey);
    setSlotBusy((current) => ({ ...current, [slotKey]: "meta" }));
    setSlotError((current) => ({ ...current, [slotKey]: "" }));
    setMessage("");
    try {
      const body = new FormData();
      body.append("title", title);
      body.append("description", description);
      const response = await fetch(`/api/producer/places/${place.id}/photos/${slotKey}`, { method: "POST", body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel(String(data.error ?? "place_media_upload_failed")) }));
        return false;
      }
      setSlots((current) => ({ ...current, [slotKey]: slotPayload(data, slotKey) }));
      setMessage("Judul dan deskripsi disimpan.");
      return true;
    } catch {
      setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel("place_media_network_error") }));
      return false;
    } finally {
      clearBusy(slotKey);
    }
  }

  async function removeSlot(slotKey: string) {
    if (busySlotsRef.current.has(slotKey)) return;
    busySlotsRef.current.add(slotKey);
    setSlotBusy((current) => ({ ...current, [slotKey]: "upload" }));
    setSlotError((current) => ({ ...current, [slotKey]: "" }));
    setMessage("");
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
    } catch {
      // A DELETE that never reached the server used to escape as an unhandled
      // rejection while the busy flag cleared: the producer saw nothing and
      // could not tell whether the photo had been deleted. The slot now says
      // plainly that the delete was not confirmed and keeps the photo.
      setSlotError((current) => ({ ...current, [slotKey]: mediaErrorLabel("place_media_network_error") }));
    } finally {
      clearBusy(slotKey);
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
          {loadError ? (
            <div className="grid gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2" role="alert">
              <p className="text-xs font-semibold text-red-700">{loadError}</p>
              <button
                type="button"
                onClick={() => {
                  setLoadError("");
                  setReloadNonce((current) => current + 1);
                }}
                className={`w-fit ${btn.compact}`}
              >
                Muat ulang foto
              </button>
            </div>
          ) : null}
          {PLACE_PHOTO_SLOTS.map((slot) => {
            const state = slots[slot.key];
            const photo = state?.filled ? state.photo : null;
            const busyMode = slotBusy[slot.key];
            const busy = Boolean(busyMode);
            const error = slotError[slot.key];
            const defaults = slotDefaultMeta(place.name, slot);
            return (
              <div className="grid min-w-0 gap-2 border-t border-black/10 pt-3" key={slot.key}>
                <p className="text-xs font-bold text-brand-accent">{slot.label}</p>
                <p className={`text-black/55 ${metaTextClass}`}>{slot.titlePrompt} — {slot.descriptionPrompt}</p>
                {photo?.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photo.url}
                    alt={`${slot.label}: ${photo.title}`}
                    loading="lazy"
                    decoding="async"
                    className="h-36 w-full rounded-lg border border-black/10 object-cover"
                  />
                )}
                {photo && (
                  <div className={`rounded-lg bg-brand-cream px-3 py-2 ${metaTextClass}`}>
                    <p className="font-bold">{photo.title}</p>
                    <p className="mt-0.5 text-black/60">{photo.description}</p>
                  </div>
                )}
                <PlacePhotoInputs
                  // The saved slot identity is the component's reset boundary:
                  // a first load or a confirmed write remounts the fields with
                  // the canonical metadata, while unsaved typing (same key) is
                  // never overwritten by an effect.
                  key={`${slot.key}:${photo?.id ?? "empty"}:${photo?.title ?? ""}:${photo?.description ?? ""}`}
                  slot={slot}
                  busy={busy}
                  busyLabel={busyMode === "meta" ? "Menyimpan judul dan deskripsi…" : "Mengunggah foto…"}
                  hasSavedMeta={Boolean(photo)}
                  disabled={Boolean(loadError)}
                  defaultTitle={defaults.title}
                  defaultDescription={defaults.description}
                  savedTitle={photo?.title ?? null}
                  savedDescription={photo?.description ?? null}
                  onUpload={(file, title, description) => uploadSlot(slot.key, file, title, description)}
                  onSaveMeta={(title, description) => saveSlotMeta(slot.key, title, description)}
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

/**
 * ONE MANUAL SLOT — pick a photo and it uploads immediately (2026-10-19).
 *
 * ROOT CAUSE REPAIRED HERE: the old component started every slot with an
 * EMPTY title and description and required both before its upload button
 * became enabled. The producer therefore had to write metadata first and then
 * press a second "Unggah foto" button, contradicting the required flow (pick →
 * upload). The fields now start from the SAVED metadata when a photo exists,
 * or from safe slot defaults when it does not; the pick itself is the upload.
 *
 * Metadata is still editable: the same POST endpoint is called with no file
 * and updates only title/description (see saveSlotMeta). The state machine is
 * deliberately small: one in-flight operation per slot, clear status, and the
 * previously saved photo stays on screen unless the server confirms the new
 * write.
 */
function PlacePhotoInputs({ slot, busy, busyLabel, hasSavedMeta, disabled, defaultTitle, defaultDescription, savedTitle, savedDescription, onUpload, onSaveMeta }: {
  slot: { key: string; label: string };
  busy: boolean;
  busyLabel: string;
  hasSavedMeta: boolean;
  disabled: boolean;
  defaultTitle: string;
  defaultDescription: string;
  savedTitle: string | null;
  savedDescription: string | null;
  onUpload: (file: File, title: string, description: string) => Promise<boolean>;
  onSaveMeta: (title: string, description: string) => Promise<boolean>;
}) {
  // Saved metadata wins whenever a slot is (re)opened; the slot defaults are
  // only the starting point for a slot that has never been saved.
  const initialTitle = savedTitle?.trim() ? savedTitle : defaultTitle;
  const initialDescription = savedDescription?.trim() ? savedDescription : defaultDescription;
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [file, setFile] = useState<File | null>(null);
  const [pickerError, setPickerError] = useState("");
  // PO fix 2026-09-28: the file picker control must be a real, clickable
  // button — the bare file input rendered as static OS text ("Choose File / No
  // file chosen") that users could not reliably tap on a phone. The hidden
  // input still owns the file (native validation, accept list, form semantics);
  // the button only opens its picker, like the claim-evidence flow.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Saved metadata is the source of truth whenever the slot's canonical
  // identity changes (first load, confirmed write). The parent remounts this
  // component for that case (see its `key`), so no effect has to copy props
  // into state and unsaved typing is never overwritten.

  // The same locked limits run SERVER-SIDE on every write (lib/place-media);
  // mirroring them at pick-time gives instant feedback instead of failing
  // only after a network round-trip. The server remains the authority.
  //
  // UPLOAD ON PICK: a valid file is uploaded here, with the metadata the
  // producer has typed (or the slot defaults), so there is no second button
  // and no metadata prerequisite. The same-file case works because the native
  // input value is reset by the caller before this runs.
  const onFileChange = async (candidate: File | null) => {
    if (!candidate || busy || disabled) return;
    try {
      validatePlaceMediaFile({ type: candidate.type, size: candidate.size });
    } catch (error) {
      setFile(null);
      setPickerError(mediaErrorLabel(error instanceof PlaceMediaError ? error.code : "place_media_upload_failed"));
      return;
    }
    setPickerError("");
    setFile(candidate);
    const confirmed = await onUpload(
      candidate,
      title.trim() || defaultTitle,
      description.trim() || defaultDescription,
    );
    // On failure the previous photo stays and the error is shown by the slot;
    // the pending file name is dropped so a retry starts from a clean picker.
    if (!confirmed) setFile(null);
  };

  return (
    <div className="grid min-w-0 gap-2" aria-busy={busy}>
      <label className="grid min-w-0 gap-1 text-xs font-semibold">
        Judul foto
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder={slot.label} />
      </label>
      <label className="grid gap-1 text-xs font-semibold">
        Deskripsi foto
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={2} />
      </label>
      {/* Metadata stays editable AFTER the immediate upload. It reuses the
          existing slot endpoint (no file = metadata only), so the Hook cover
          and the stored object are untouched. */}
      {hasSavedMeta && (
        <button
          type="button"
          disabled={busy || disabled || !title.trim() || !description.trim()}
          onClick={() => void onSaveMeta(title.trim(), description.trim())}
          className={`w-fit ${btn.compact}`}
        >
          Simpan judul &amp; deskripsi
        </button>
      )}
      <div className="grid gap-1">
        <span className="text-xs font-semibold">File foto</span>
        <input
          ref={fileInputRef}
          type="file"
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          accept={PLACE_MEDIA_ACCEPTED_TYPES.join(",")}
          onChange={(event) => {
            const candidate = event.target.files?.[0] ?? null;
            // Re-selecting the SAME photo must fire change again: the native
            // input only emits change when its value differs, so the value is
            // cleared the moment the file is read.
            event.target.value = "";
            void onFileChange(candidate);
          }}
        />
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => fileInputRef.current?.click()}
          className="w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-xs font-bold text-black/70 transition hover:border-brand-accent/60 hover:text-brand-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy
            ? busyLabel
            : file
              ? `File dipilih: ${file.name}`
              : hasSavedMeta
                ? "Pilih foto pengganti"
                : "Pilih foto"}
        </button>
        <p className={`text-black/45 ${metaTextClass}`}>
          Foto langsung diunggah setelah dipilih. Judul dan deskripsi memakai nilai awal slot ini dan tetap dapat diubah.
        </p>
      </div>
      {busy && (
        <p className="text-xs font-semibold text-brand-ink/70" role="status">{busyLabel}</p>
      )}
      {pickerError && (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {pickerError}
        </p>
      )}
    </div>
  );
}
