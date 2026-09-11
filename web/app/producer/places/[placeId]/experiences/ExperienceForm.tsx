"use client";

import { useEffect, useState } from "react";
import type { Experience } from "@/lib/experiences";

type Props = { placeId: string; placeTimezone: string; experience?: Experience; onSaved?: (experience: Experience) => void };

export default function ExperienceForm({ placeId, placeTimezone, experience, onSaved }: Props) {
  const [form, setForm] = useState({
    id: experience?.id ?? "", title: experience?.title ?? "", shortDescription: experience?.shortDescription ?? "",
    description: experience?.description ?? "", durationMinutes: String(experience?.durationMinutes ?? 60),
    capacity: experience?.capacity?.toString() ?? "", minPartySize: String(experience?.minPartySize ?? 1),
    maxPartySize: String(experience?.maxPartySize ?? 6), ageRequirement: experience?.ageRequirement ?? "",
    prerequisites: experience?.prerequisites.join("\n") ?? "", meetingPoint: experience?.meetingPoint ?? "",
    highlights: experience?.highlights.join("\n") ?? "", dayOfWeek: experience?.schedules[0]?.dayOfWeek ?? "Monday",
    startTime: experience?.schedules[0]?.startTime ?? "09:00", endTime: experience?.schedules[0]?.endTime ?? "15:00",
    scheduleStatus: experience?.schedules[0]?.status ?? "requires_confirmation",
  });
  const [message, setMessage] = useState("");
  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setMessage("Menyimpan...");
    const payload = {
      ...form, durationMinutes: Number(form.durationMinutes), capacity: form.capacity ? Number(form.capacity) : null,
      minPartySize: Number(form.minPartySize), maxPartySize: Number(form.maxPartySize),
      ageRequirement: form.ageRequirement || null, prerequisites: form.prerequisites.split("\n").map((item) => item.trim()).filter(Boolean),
      highlights: form.highlights.split("\n").map((item) => item.trim()).filter(Boolean),
      schedules: [{ dayOfWeek: form.dayOfWeek, startTime: form.startTime, endTime: form.endTime, timezone: placeTimezone, status: form.scheduleStatus }],
    };
    const response = await fetch(experience ? `/api/producer/places/${placeId}/experiences/${experience.id}` : `/api/producer/places/${placeId}/experiences`, { method: experience ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Experience tidak dapat disimpan"); return; }
    setMessage(`Tersimpan sebagai ${data.status}`); onSaved?.(data);
  }
  const fields: [string, string][] = [["title", "Judul"], ["shortDescription", "Deskripsi singkat"], ["description", "Deskripsi"], ["durationMinutes", "Durasi (menit)"], ["capacity", "Kapasitas (opsional)"], ["minPartySize", "Minimum peserta"], ["maxPartySize", "Maksimum peserta"], ["ageRequirement", "Syarat usia (opsional)"], ["meetingPoint", "Titik temu"]];
  return <form className="grid gap-4" onSubmit={submit}>{!experience && <label className="grid gap-1 text-sm font-semibold">ID Experience<input required value={form.id} onChange={(event) => update("id", event.target.value)} /></label>}{fields.map(([key, label]) => <label className="grid gap-1 text-sm font-semibold" key={key}>{label}{key === "description" ? <textarea required rows={4} value={form[key as keyof typeof form]} onChange={(event) => update(key, event.target.value)} /> : <input required={!['capacity', 'ageRequirement'].includes(key)} type={['durationMinutes', 'capacity', 'minPartySize', 'maxPartySize'].includes(key) ? "number" : "text"} value={form[key as keyof typeof form]} onChange={(event) => update(key, event.target.value)} />}</label>)}<label className="grid gap-1 text-sm font-semibold">Prasyarat, satu per baris<textarea rows={3} value={form.prerequisites} onChange={(event) => update("prerequisites", event.target.value)} /></label><label className="grid gap-1 text-sm font-semibold">Highlights, satu per baris<textarea rows={3} value={form.highlights} onChange={(event) => update("highlights", event.target.value)} /></label><fieldset className="grid gap-3 border-t border-black/10 pt-4"><legend className="text-sm font-black">Jadwal ({placeTimezone})</legend><select value={form.dayOfWeek} onChange={(event) => update("dayOfWeek", event.target.value)}>{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => <option key={day}>{day}</option>)}</select><div className="grid grid-cols-2 gap-3"><input type="time" value={form.startTime} onChange={(event) => update("startTime", event.target.value)} /><input type="time" value={form.endTime} onChange={(event) => update("endTime", event.target.value)} /></div><select value={form.scheduleStatus} onChange={(event) => update("scheduleStatus", event.target.value)}><option value="available">Available</option><option value="not_available">Not available</option><option value="requires_confirmation">Requires confirmation</option></select></fieldset><button className="rounded-lg bg-[#20231f] px-4 py-3 text-sm font-bold text-white" type="submit">Simpan Experience</button>{message && <p className="text-sm text-black/60" role="status">{message}</p>}</form>;
}

export function ExperienceEditor({ placeId, experienceId }: { placeId: string; experienceId: string }) {
  const [experience, setExperience] = useState<Experience | null>(null); const [placeTimezone, setPlaceTimezone] = useState(""); const [error, setError] = useState("");
  useEffect(() => { Promise.all([fetch(`/api/producer/places/${placeId}`).then((response) => response.json()), fetch(`/api/producer/places/${placeId}/experiences/${experienceId}`).then((response) => response.json())]).then(([place, item]) => { if (item.error) setError(item.error); else { setPlaceTimezone(place.timezone); setExperience(item); } }); }, [placeId, experienceId]);
  if (error) return <p className="rounded-lg bg-red-50 p-4 text-sm text-red-800">{error}</p>; if (!experience) return <p className="text-sm text-black/60">Memuat Experience...</p>;
  async function changeStatus(status: Experience["status"]) { const response = await fetch(`/api/producer/places/${placeId}/experiences/${experienceId}/publication`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) }); const data = await response.json(); if (response.ok) setExperience(data); else setError(data.error ?? "Status tidak dapat diubah"); }
  return <><div className="mb-5 flex flex-wrap items-center gap-3 text-sm text-black/60">Status: <strong>{experience.status}</strong><button className="rounded border border-black/15 px-3 py-1 font-semibold" type="button" onClick={() => changeStatus(experience.status === "published" ? "paused" : "published")}>{experience.status === "published" ? "Pause" : "Publish"}</button><button className="rounded border border-black/15 px-3 py-1 font-semibold" type="button" onClick={() => changeStatus("archived")}>Archive</button></div><ExperienceForm placeId={placeId} placeTimezone={placeTimezone} experience={experience} onSaved={setExperience} /></>;
}