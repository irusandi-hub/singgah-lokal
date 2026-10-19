"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PLACE_MEDIA_ACCEPTED_TYPES,
  PLACE_MEDIA_MAX_BYTES,
  validatePlaceMediaFile,
  PlaceMediaError,
} from "@/lib/place-media";
import {
  PLACE_PROFILE_PHOTO_KIND_LABEL,
  resolvePlaceProfilePhotoKind,
  type PlaceProfilePhotoKind,
} from "@/lib/place-cover";

/**
 * ADMIN PLACE DETAIL — "Foto Profil Tempat".
 *
 * The ONE control that lets a Platform Admin add or replace the profile photo
 * of a Place — the canonical `places.cover_image_url` that Home cards, the
 * Place detail hero, and the Producer workspace header render.
 *
 * DESIGN RULES THIS COMPONENT OBEYS
 * - The SERVER is the only authority. The control posts the picked file to
 *   /api/admin/places/[placeId]/cover, which re-verifies the Platform Admin
 *   session and re-validates type + size; nothing here is the protection.
 * - The photo the Admin sees after saving comes from the SERVER RESPONSE, not
 *   from the local preview: the surface can never look updated when the save
 *   failed. `router.refresh()` then re-reads the canonical page so the newest
 *   value is what stays on screen.
 * - The extra rules of this feature are stated, not implied: the change never
 *   publishes/pauses/archives the Place, never assigns a manager, and never
 *   requires one. A managerless or archived Place is a legitimate target.
 * - File rules are mirrored from the ONE shared validator (lib/place-media) so
 *   the Admin gets instant feedback with the same limits the server enforces.
 */

const KIND_HINT: Record<PlaceProfilePhotoKind, string> = {
  foto: "Foto profil yang sedang dipakai aplikasi — muncul di Home dan halaman Tempat.",
  placeholder:
    "Belum ada foto profil tersimpan. Home dan halaman Tempat menampilkan gambar placeholder bawaan aplikasi.",
  dummy:
    "Tempat ini ditandai sebagai Dummy Place (fixture data/DEV), jadi fotonya bukan foto Tempat nyata.",
};

const KIND_TONE: Record<PlaceProfilePhotoKind, string> = {
  foto: "border-emerald-200 bg-emerald-50 text-emerald-800",
  placeholder: "border-amber-200 bg-amber-50 text-amber-800",
  dummy: "border-amber-200 bg-amber-50 text-amber-800",
};

const ERROR_TEXT: Record<string, string> = {
  place_photo_type_invalid: "Format foto tidak didukung. Gunakan JPG, PNG, WebP, atau AVIF.",
  place_photo_size_invalid: "Ukuran foto tidak valid (maksimal 5 MB).",
  place_photo_file_required: "Pilih file foto terlebih dahulu.",
};

function messageForCode(code: string | null | undefined, fallback: string): string {
  if (!code) return fallback;
  return ERROR_TEXT[code] ?? fallback;
}

export default function AdminPlaceCoverEditor({
  placeId,
  placeName,
  coverImageUrl,
  publicationStatus,
  isDummy,
}: {
  placeId: string;
  placeName: string;
  /** Canonical cover URL of the Place, straight from the server read. */
  coverImageUrl: string | null;
  publicationStatus: string;
  isDummy: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * The photo the surface shows. It is DERIVED, never copied: a successful save
   * records the server's answer together with the prop value it replaced, so
   * the moment the freshly read canonical value arrives (router.refresh) the
   * prop wins again — a second Admin's newer photo can never be masked by this
   * session's own earlier result.
   */
  const [savedPhoto, setSavedPhoto] = useState<{ base: string | null; url: string } | null>(null);
  const savedUrl = savedPhoto && savedPhoto.base === coverImageUrl ? savedPhoto.url : coverImageUrl;

  /** The picked-but-not-yet-saved file, with its local preview URL. */
  const [picked, setPicked] = useState<{ file: File; previewUrl: string } | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  // Revoke the last local preview when the surface goes away. No state is set
  // here: the preview URL is created and released in the event handlers that
  // own the picked file.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function releasePreview() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }

  const kind = resolvePlaceProfilePhotoKind({ coverImageUrl: savedUrl, isDummy });
  const archived = publicationStatus === "archived";

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setMessage("");
    setError("");
    releasePreview();
    setPicked(null);
    if (!file) return;
    try {
      // The SAME rule module the server enforces.
      validatePlaceMediaFile({ type: file.type, size: file.size });
    } catch (validationError) {
      setError(
        messageForCode(
          validationError instanceof PlaceMediaError ? validationError.code : null,
          "Foto tidak dapat dipakai.",
        ),
      );
      event.target.value = "";
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    previewUrlRef.current = previewUrl;
    setPicked({ file, previewUrl });
  }

  function clearPicked() {
    releasePreview();
    setPicked(null);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function save() {
    if (!picked) {
      setError(ERROR_TEXT.place_photo_file_required);
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const body = new FormData();
      body.append("file", picked.file);
      const response = await fetch(`/api/admin/places/${placeId}/cover`, { method: "POST", body });
      const payload: unknown = await response.json().catch(() => null);
      const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      if (!response.ok) {
        setError(
          messageForCode(
            record && typeof record.code === "string" ? record.code : null,
            typeof record?.error === "string" && record.error ? record.error : "Foto tidak dapat disimpan.",
          ),
        );
        return;
      }
      const savedRaw = record?.coverImageUrl;
      if (typeof savedRaw !== "string" || !savedRaw) {
        // A success answer without the stored URL is not a success: never show
        // the local preview as if it had been saved.
        setError("Server tidak mengembalikan foto tersimpan. Muat ulang halaman ini.");
        return;
      }
      releasePreview();
      setPicked(null);
      if (inputRef.current) inputRef.current.value = "";
      // The SERVER's stored URL is what the surface adopts — never the preview.
      setSavedPhoto({ base: coverImageUrl, url: savedRaw });
      setMessage("Foto profil Tempat tersimpan dan sudah dipakai aplikasi.");
      router.refresh();
    } catch {
      setError("Tidak dapat menghubungi server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <div className="grid gap-2">
          <div className="relative h-40 w-full overflow-hidden rounded-xl border border-black/10 bg-brand-cream sm:h-32">
            {savedUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element -- the cover is
                 an external Supabase Storage URL, the same value the public
                 Place hero renders with a plain <img>. */
              <img
                src={savedUrl}
                alt={`Foto profil ${placeName}`}
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element -- the app's
                 own placeholder asset, exactly what Home falls back to. */
              <img
                src="/place-cover-placeholder.svg"
                alt={`Placeholder foto profil ${placeName}`}
                className="h-full w-full object-cover"
              />
            )}
          </div>
          <span
            className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-[11px] font-bold ${KIND_TONE[kind]}`}
          >
            {PLACE_PROFILE_PHOTO_KIND_LABEL[kind]}
          </span>
          <p className="text-xs leading-5 text-black/55">{KIND_HINT[kind]}</p>
        </div>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <label
              htmlFor={`place-cover-file-${placeId}`}
              className="w-fit cursor-pointer rounded-full border border-black/15 bg-white px-4 py-2 text-xs font-bold text-black/75 transition hover:bg-black/[0.04] focus-within:ring-2 focus-within:ring-brand-primary/40"
            >
              {savedUrl ? "Pilih foto pengganti" : "Pilih foto dari perangkat"}
            </label>
            <input
              id={`place-cover-file-${placeId}`}
              ref={inputRef}
              type="file"
              accept={PLACE_MEDIA_ACCEPTED_TYPES.join(",")}
              onChange={pick}
              disabled={busy}
              className="sr-only"
            />
            <p className="text-xs leading-5 text-black/50">
              JPG, PNG, WebP, atau AVIF · maksimal {Math.round(PLACE_MEDIA_MAX_BYTES / (1024 * 1024))} MB.
            </p>
          </div>

          {picked ? (
            <div className="grid gap-3 rounded-xl border border-black/10 bg-black/[0.02] p-3 sm:grid-cols-[minmax(0,120px)_minmax(0,1fr)]">
              <div className="h-24 w-full overflow-hidden rounded-lg border border-black/10 bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element -- local
                    object URL of the file the Admin just picked. */}
                <img
                  src={picked.previewUrl}
                  alt="Pratinjau foto yang dipilih"
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="grid content-start gap-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Pratinjau</p>
                <p className="break-all text-xs text-black/60">{picked.file.name}</p>
                <p className="text-xs text-black/50">
                  Pratinjau ini belum tersimpan. Tekan Simpan Foto untuk mengunggahnya.
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={busy || !picked}
              aria-busy={busy}
              className="rounded-full bg-brand-primary px-5 py-2.5 text-xs font-bold text-white transition hover:bg-brand-primary-deep disabled:opacity-50"
            >
              {busy ? "Mengunggah…" : savedUrl ? "Simpan Foto Baru" : "Unggah Foto"}
            </button>
            {picked && !busy ? (
              <button
                type="button"
                onClick={clearPicked}
                className="rounded-full border border-black/15 px-4 py-2 text-xs font-bold text-black/70 transition hover:bg-black/[0.04]"
              >
                Batalkan pilihan
              </button>
            ) : null}
          </div>

          {busy ? (
            <p role="status" className="text-xs font-semibold text-black/60">
              Mengunggah foto ke penyimpanan Tempat…
            </p>
          ) : null}
          {message ? (
            <p
              role="status"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm font-semibold text-emerald-800"
            >
              {message}
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm font-semibold text-red-800"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <p className="text-xs leading-5 text-black/55">
        Foto profil adalah kewenangan administratif Platform Admin, terpisah dari hak pengelolaan digital. Memperbarui
        foto{" "}
        <span className="font-semibold">
          {archived ? "tidak memulihkan Tempat ini dari arsip" : "tidak mengubah status publikasi Tempat"}
        </span>
        , tidak menunjuk atau menambah Pengelola, dan tidak memberikan hak kelola kepada akun mana pun. Tempat tetap dapat
        dipertahankan tanpa Pengelola aktif.
      </p>
    </div>
  );
}
