"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Place } from "@/lib/places";
import { PLACE_CATEGORIES, PLACE_CURRENCIES } from "@/lib/places";
import PlaceGeoFields from "@/components/place-geo-fields";
import PlaceLocationPicker from "@/components/place-location-picker";

/**
 * Admin Place editor — "Informasi Tempat" only.
 *
 * Deliberately narrower than the Producer Place form: the Admin edits the
 * canonical Place fields and nothing else. There is no owner field
 * (ownership arrives through the existing claim flow), no photo upload, and
 * no status control here — publication is the separate moderation action
 * below it, so an edit can never silently change visibility.
 *
 * The server remains the authority: /api/admin/places re-runs the one shared
 * Place mutation validator plus the server-side timezone resolver, and
 * re-verifies Platform Admin authorization.
 *
 * PO, 2026-09-28: the Timezone field is GONE — the zone is resolved
 * server-side from the coordinates (the same rule the Producer save path
 * already used), so the Admin never types or chooses one. Coordinates come
 * only from the shared map picker: no manual Latitude/Longitude input exists.
 * Category and Currency are selects over the canonical vocabularies; the
 * server and the database (migration 0033) refuse anything outside them.
 */
type Props = { place?: Place };

const CURRENCY_LABEL: Record<string, string> = {
  IDR: "IDR — Rupiah Indonesia",
  USD: "USD — Dolar Amerika Serikat",
};

function emptyForm(): Record<string, string> {
  return {
    name: "",
    shortDescription: "",
    category: "Sumber Daya Alam",
    type: "production",
    area: "",
    countryCode: "",
    regionName: "",
    address: "",
    contactInformation: "",
    currency: "IDR",
    latitude: "",
    longitude: "",
  };
}

const TEXT_FIELDS: Array<[string, string, boolean]> = [
  ["name", "Nama Tempat", true],
  ["shortDescription", "Deskripsi singkat", true],
  ["area", "Area", true],
  ["address", "Alamat", true],
  ["contactInformation", "Kontak", false],
];

const FIELD_CLASS =
  "rounded-lg border border-black/10 px-3 py-2 text-sm font-normal";

export default function AdminPlaceEditor({ place }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, string>>(
    place
      ? {
          name: place.name,
          shortDescription: place.shortDescription,
          category: place.category,
          type: place.type,
          area: place.area,
          countryCode: place.countryCode ?? "",
          regionName: place.regionName ?? "",
          address: place.address,
          contactInformation: place.contactInformation,
          currency: place.currency,
          latitude: place.latitude?.toString() ?? "",
          longitude: place.longitude?.toString() ?? "",
        }
      : emptyForm(),
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setError("");
    const payload = {
      ...form,
      latitude: form.latitude ? Number(form.latitude) : null,
      longitude: form.longitude ? Number(form.longitude) : null,
    };
    try {
      const response = await fetch(place ? `/api/admin/places/${place.id}` : "/api/admin/places", {
        method: place ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code =
          data && typeof data === "object" && "error" in data
            ? String((data as { error?: unknown }).error ?? "")
            : "";
        setError(code || "Tempat tidak dapat disimpan.");
        return;
      }
      setMessage("Tersimpan.");
      // A new Place is a draft without a Producer: send the Admin straight to
      // the workspace where moderation and the claim state live.
      router.push(`/admin/places/${(data as Place).id}`);
      router.refresh();
    } catch {
      setError("Tidak dapat menghubungi server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit} autoComplete="off">
      {TEXT_FIELDS.map(([key, label, required]) => (
        <label className="grid gap-1 text-sm font-semibold" key={key}>
          {label}
          <input
            className={FIELD_CLASS}
            required={required}
            value={form[key]}
            onChange={(event) => update(key, event.target.value)}
          />
        </label>
      ))}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold">
          Kategori
          <select className={FIELD_CLASS} value={form.category} onChange={(event) => update("category", event.target.value)}>
            {PLACE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Tipe
          <select className={FIELD_CLASS} value={form.type} onChange={(event) => update("type", event.target.value)}>
            <option value="production">Produksi</option>
            <option value="experience">Kegiatan</option>
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-sm font-semibold">
        Currency
        <select className={FIELD_CLASS} value={form.currency} onChange={(event) => update("currency", event.target.value)}>
          {PLACE_CURRENCIES.map((currency) => (
            <option key={currency} value={currency}>
              {CURRENCY_LABEL[currency]}
            </option>
          ))}
        </select>
      </label>
      <PlaceGeoFields
        countryCode={form.countryCode}
        regionName={form.regionName}
        onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
      />
      <div className="grid min-w-0 gap-2">
        <span className="text-sm font-semibold">Lokasi Tempat</span>
        <PlaceLocationPicker
          latitude={form.latitude}
          longitude={form.longitude}
          onChange={(latitude, longitude) =>
            setForm((current) => ({ ...current, latitude, longitude }))
          }
        />
        <p className="text-xs leading-5 text-black/55">
          Zona waktu dihitung otomatis di server dari koordinat peta saat Tempat disimpan.
        </p>
      </div>
      <p className="text-xs leading-5 text-black/55">
        Negara, provinsi/wilayah, alamat, dan koordinat wajib lengkap sebelum Tempat dapat diterbitkan. Area tetap
        diisi dengan nama area lokal.
      </p>
      <button
        className="justify-self-start rounded-lg bg-brand-primary px-5 py-3 text-sm font-bold text-white transition hover:bg-brand-primary-deep disabled:opacity-50"
        type="submit"
        disabled={busy}
      >
        {busy ? "Menyimpan…" : place ? "Simpan Perubahan" : "Buat Tempat"}
      </button>
      {message ? (
        <p className="text-sm font-semibold text-brand-primary" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm font-semibold text-red-700" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
