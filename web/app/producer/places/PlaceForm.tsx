"use client";

import { useEffect, useState } from "react";
import type { Place } from "@/lib/places";

type Props = { place?: Place; onSaved?: (place: Place) => void };

export default function PlaceForm({ place, onSaved }: Props) {
  const [form, setForm] = useState<Record<string, string>>({
    id: place?.id ?? "", name: place?.name ?? "", shortDescription: place?.shortDescription ?? "",
    category: place?.category ?? "Kopi", type: place?.type ?? "production", area: place?.area ?? "",
    address: place?.address ?? "", contactInformation: place?.contactInformation ?? "",
    timezone: place?.timezone ?? "Asia/Jakarta", currency: place?.currency ?? "IDR",
    latitude: place?.latitude?.toString() ?? "", longitude: place?.longitude?.toString() ?? "",
  });
  const [message, setMessage] = useState("");

  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("Menyimpan...");
    const payload = { ...form, latitude: form.latitude ? Number(form.latitude) : null, longitude: form.longitude ? Number(form.longitude) : null };
    const response = await fetch(place ? `/api/producer/places/${place.id}` : "/api/producer/places", {
      method: place ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Place tidak dapat disimpan"); return; }
    setMessage(`Tersimpan sebagai ${data.publicationStatus}`);
    onSaved?.(data);
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      {!place && <label className="grid gap-1 text-sm font-semibold">ID Place<input required value={form.id} onChange={(event) => update("id", event.target.value)} placeholder="nama-place" /></label>}
      {[["name", "Nama Place"], ["shortDescription", "Deskripsi singkat"], ["area", "Area"], ["address", "Alamat"], ["contactInformation", "Kontak"], ["timezone", "Timezone IANA"], ["currency", "Currency ISO 4217"], ["latitude", "Latitude"], ["longitude", "Longitude"]].map(([key, label]) => (
        <label className="grid gap-1 text-sm font-semibold" key={key}>{label}<input required={!['contactInformation', 'latitude', 'longitude'].includes(key)} value={form[key]} onChange={(event) => update(key, event.target.value)} /></label>
      ))}
      <label className="grid gap-1 text-sm font-semibold">Kategori<select value={form.category} onChange={(event) => update("category", event.target.value)}><option>Kopi</option><option>Teh</option><option>Kuliner</option></select></label>
      <label className="grid gap-1 text-sm font-semibold">Tipe<select value={form.type} onChange={(event) => update("type", event.target.value)}><option value="production">Produksi</option><option value="experience">Experience</option></select></label>
      <button className="rounded-lg bg-[#20231f] px-4 py-3 text-sm font-bold text-white" type="submit">Simpan Place</button>
      {message && <p className="text-sm text-black/60" role="status">{message}</p>}
    </form>
  );
}

export function PlaceEditor({ id }: { id: string }) {
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
  return <><div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-black/60">Status: <strong>{place.publicationStatus}</strong><button className="rounded border border-black/15 px-3 py-1 font-semibold" onClick={() => changeStatus(place.publicationStatus === "published" ? "paused" : "published")} type="button">{place.publicationStatus === "published" ? "Pause" : "Publish"}</button><button className="rounded border border-black/15 px-3 py-1 font-semibold" onClick={() => changeStatus("archived")} type="button">Archive</button></div><PlaceForm place={place} onSaved={setPlace} /></>;
}