"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Place } from "@/lib/places";

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
 * Place mutation validator and re-verifies Platform Admin authorization.
 */
type Props = { place?: Place };

function emptyForm(): Record<string, string> {
  return {
    name: "",
    shortDescription: "",
    category: "Kopi",
    type: "production",
    area: "",
    address: "",
    contactInformation: "",
    timezone: "Asia/Jakarta",
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
  ["timezone", "Timezone", true],
  ["currency", "Currency", true],
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
          address: place.address,
          contactInformation: place.contactInformation,
          timezone: place.timezone,
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
            <option>Kopi</option>
            <option>Teh</option>
            <option>Kuliner</option>
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
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold">
          Latitude
          <input className={FIELD_CLASS} value={form.latitude} onChange={(event) => update("latitude", event.target.value)} />
        </label>
        <label className="grid gap-1 text-xs font-semibold">
          Longitude
          <input className={FIELD_CLASS} value={form.longitude} onChange={(event) => update("longitude", event.target.value)} />
        </label>
      </div>
      <p className="text-xs leading-5 text-black/55">
        Alamat dan koordinat wajib lengkap sebelum Tempat dapat diterbitkan.
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
