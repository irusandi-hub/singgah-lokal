"use client";

import { useEffect, useState } from "react";
import type { Place } from "@/lib/places";
import { PLACE_MEDIA_ACCEPTED_TYPES, PLACE_MEDIA_MAX_BYTES, PLACE_PHOTO_SLOTS } from "@/lib/place-media";
import PlaceLocationPicker from "@/components/place-location-picker";

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
    category: "Kopi", type: "production", area: "",
    address: "", contactInformation: "",
    timezone: "Asia/Jakarta", currency: "IDR",
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
          address: place.address, contactInformation: place.contactInformation,
          timezone: place.timezone, currency: place.currency,
          latitude: place.latitude?.toString() ?? "", longitude: place.longitude?.toString() ?? "",
        }
      : emptyPlaceForm(),
  );
  const [message, setMessage] = useState("");
  // Editor tabs (PO, 2026-09-26): "Detail Place" holds the existing Place
  // fields; "Upload" holds the standard photo slots. The Upload tab needs a
  // SAVED Place (the upload API is keyed by the Place id), so it is disabled
  // with an explanation while a NEW entry has no id yet — and becomes active
  // the moment the save succeeds (the parent flips new → edit).
  const [editorTab, setEditorTab] = useState<"detail" | "upload">("detail");

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
      setSlotError((current) => ({ ...current, [slotKey]: "Simpan Place dulu sebelum mengunggah foto." }));
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
    try {
      const response = await fetch(`/api/producer/places/${place.id}/photos/${slotKey}`, { method: "DELETE" });
      if (response.ok) {
        setSlots((current) => ({ ...current, [slotKey]: { slotKey, filled: false, photo: null } }));
        setMessage("Foto dihapus.");
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
    if (!response.ok) { setMessage(data.error ?? "Place tidak dapat disimpan"); return; }
    setMessage(`Tersimpan sebagai ${data.publicationStatus}`);
    // A successful NEW-entry submit resets transient input so reopening the
    // form (or a route remount) starts empty again.
    if (!place) setForm(emptyPlaceForm());
    onSaved?.(data);
  }

  return (
    <form key={isEdit ? `edit-${place?.id}` : "new"} className="grid gap-4" onSubmit={submit} autoComplete="off">
      {/* Editor tabs (PO, 2026-09-26): Detail Place = the Place fields;
          Upload = the standard photo slots. Upload requires a SAVED Place
          (the upload API is keyed by the Place id), so the tab stays
          disabled — with the reason shown — until the form is saved, and
          becomes active the moment the save succeeds. */}
      <div className="flex gap-2 border-b border-black/10 pb-3" role="tablist" aria-label="Editor Place">
        <button
          type="button"
          role="tab"
          aria-selected={editorTab === "detail"}
          onClick={() => setEditorTab("detail")}
          className={`rounded-full px-4 py-2 text-xs font-bold transition ${
            editorTab === "detail" ? "bg-brand-accent text-white" : "border border-black/10 bg-white text-black/60"
          }`}
        >
          Detail Place
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={editorTab === "upload"}
          disabled={!place}
          aria-disabled={!place}
          title={place ? undefined : "Simpan Place dulu — Upload membutuhkan Place yang sudah tersimpan."}
          onClick={() => setEditorTab("upload")}
          className={`rounded-full px-4 py-2 text-xs font-bold transition ${
            editorTab === "upload" ? "bg-brand-accent text-white" : "border border-black/10 bg-white text-black/60"
          } ${place ? "" : "cursor-not-allowed opacity-50"}`}
        >
          Upload
        </button>
      </div>
      {!place && (
        <p className="text-xs text-black/55" role="note">
          Tab Upload aktif setelah Place disimpan — Place baru harus tersimpan (memiliki ID) terlebih dahulu.
        </p>
      )}

      {editorTab === "detail" && (
        <>
          {!place && <label className="grid gap-1 text-sm font-semibold">ID Place<input required value={form.id} onChange={(event) => update("id", event.target.value)} placeholder="nama-place" /></label>}
      {      [["name", "Nama Place"], ["shortDescription", "Deskripsi singkat"], ["area", "Area"], ["address", "Alamat"], ["contactInformation", "Kontak"], ["timezone", "Timezone IANA"], ["currency", "Currency ISO 4217"]].map(([key, label]) => (
        <label className="grid gap-1 text-sm font-semibold" key={key}>{label}<input required={key !== "contactInformation"} value={form[key]} onChange={(event) => update(key, event.target.value)} /></label>
      ))}
      <div className="grid gap-2">
        <span className="text-sm font-semibold">Lokasi Place</span>
        <PlaceLocationPicker
          latitude={form.latitude}
          longitude={form.longitude}
          onChange={(latitude, longitude) =>
            setForm((current) => ({ ...current, latitude, longitude }))
          }
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-xs font-semibold">Latitude<input value={form.latitude} onChange={(event) => update("latitude", event.target.value)} /></label>
          <label className="grid gap-1 text-xs font-semibold">Longitude<input value={form.longitude} onChange={(event) => update("longitude", event.target.value)} /></label>
        </div>
      </div>
      <label className="grid gap-1 text-sm font-semibold">Kategori<select value={form.category} onChange={(event) => update("category", event.target.value)}><option>Kopi</option><option>Teh</option><option>Kuliner</option></select></label>
      <label className="grid gap-1 text-sm font-semibold">Tipe<select value={form.type} onChange={(event) => update("type", event.target.value)}><option value="production">Produksi</option><option value="experience">Experience</option></select></label>
        </>
      )}

      {/* MEDIA — the ≥5 standard photo slots, on the Upload tab. Files go to
          Supabase Storage through the server-side upload API; the HTTP-URL
          input was removed as a media mechanism (server-side fail-closed
          validation). This tab is reachable only for a SAVED Place. */}
      {editorTab === "upload" && (
      <section className="grid gap-3 rounded-xl border border-black/10 p-4" aria-label="Foto Place">
        <div>
          <span className="text-sm font-semibold">Foto Place ({PLACE_PHOTO_SLOTS.length} slot standar)</span>
          <p className="mt-1 text-xs text-black/55">
            Setiap slot memakai judul dan deskripsi sesuai struktur konten Production Story.
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
            <div className="grid gap-2 rounded-lg border border-black/10 p-3" key={slot.key}>
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

      {editorTab === "detail" && (
        <button className="rounded-lg bg-brand-ink px-4 py-3 text-sm font-bold text-white" type="submit">Simpan Place</button>
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

  const onFileChange = (candidate: File | null) => {
    if (!candidate) return;
    setFile(candidate);
  };

  return (
    <div className="grid gap-2">
      <label className="grid gap-1 text-xs font-semibold">
        Judul foto
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder={slot.label} />
      </label>
      <label className="grid gap-1 text-xs font-semibold">
        Deskripsi foto
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={2} />
      </label>
      <label className="grid gap-1 text-xs font-semibold">
        File foto
        <input
          type="file"
          accept={PLACE_MEDIA_ACCEPTED_TYPES.join(",")}
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
        />
      </label>
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
  if (!place) return <p className="text-sm text-black/60">Memuat Place...</p>;
  async function changeStatus(publicationStatus: Place["publicationStatus"]) {
    const response = await fetch(`/api/producer/places/${id}/publication`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicationStatus }) });
    const data = await response.json();
    if (response.ok) setPlace(data); else setError(data.error ?? "Status tidak dapat diubah");
  }
  return <><div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-black/60">Status: <strong>{place.publicationStatus}</strong><button className="rounded border border-black/15 px-3 py-1 font-semibold" onClick={() => changeStatus(place.publicationStatus === "published" ? "paused" : "published")} type="button">{place.publicationStatus === "published" ? "Pause" : "Publish"}</button><button className="rounded border border-black/15 px-3 py-1 font-semibold" onClick={() => changeStatus("archived")} type="button">Archive</button></div><PlaceForm place={place} onSaved={(saved) => { setPlace(saved); onSaved?.(saved); }} /></>;
}
