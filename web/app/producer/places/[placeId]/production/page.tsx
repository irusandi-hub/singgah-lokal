"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProductionStage, ProductionStageStatus } from "@/lib/production-story";

type StageDraft = Pick<ProductionStage, "title" | "description" | "experienceIds">;

export default function ProductionStoryPage({ params }: { params: Promise<{ placeId: string }> }) {
  const [placeId, setPlaceId] = useState("");
  const [stages, setStages] = useState<ProductionStage[]>([]);
  const [draft, setDraft] = useState<StageDraft>({ title: "", description: "", experienceIds: [] });
  const [message, setMessage] = useState("");

  useEffect(() => {
    params.then(({ placeId: id }) => {
      setPlaceId(id);
      fetch(`/api/producer/places/${id}/production-story`).then(async (response) => {
        const data = await response.json();
        if (response.ok) setStages(data);
        else setMessage(data.error ?? "Production Story tidak dapat dimuat");
      });
    });
  }, [params]);

  async function createStage(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch(`/api/producer/places/${placeId}/production-story`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: draft.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), ...draft }),
    });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Stage tidak dapat dibuat"); return; }
    setStages((current) => [...current, data]);
    setDraft({ title: "", description: "", experienceIds: [] });
    setMessage("Stage disimpan sebagai draft");
  }

  async function updateStage(stage: ProductionStage, changes: StageDraft) {
    const response = await fetch(`/api/producer/places/${placeId}/production-story/${stage.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: stage.id, ...changes }),
    });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Stage tidak dapat diperbarui"); return; }
    setStages((current) => current.map((item) => item.id === data.id ? data : item));
    setMessage("Stage diperbarui");
  }

  async function changeStatus(stage: ProductionStage, status: ProductionStageStatus) {
    const response = await fetch(`/api/producer/places/${placeId}/production-story/${stage.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Status tidak dapat diubah"); return; }
    setStages((current) => current.map((item) => item.id === data.id ? data : item));
    setMessage(`Status stage: ${data.status}`);
  }

  async function moveStage(index: number, direction: -1 | 1) {
    const next = [...stages];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    const response = await fetch(`/api/producer/places/${placeId}/production-story/reorder`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stageIds: next.map((stage) => stage.id) }),
    });
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Urutan tidak dapat diubah"); return; }
    setStages(data);
  }

  return <main className="min-h-screen bg-[#f7f5ef] px-5 py-8 text-[#20231f] sm:px-8"><div className="mx-auto max-w-3xl"><Link className="text-sm font-bold text-[#7b5b38]" href={`/producer/places/${placeId}`}>← Kembali ke Place</Link><header className="mt-6 border-b border-black/10 pb-5"><p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#7b5b38]">Producer App</p><h1 className="mt-2 text-3xl font-black">Dari Sini / Production Story</h1><p className="mt-2 text-sm text-black/60">Susun cerita produksi Place berdasarkan tahap yang benar-benar terjadi.</p></header>{message && <p className="mt-5 rounded-lg bg-white p-3 text-sm" role="status">{message}</p>}<form className="mt-6 grid gap-3 rounded-xl border border-black/10 bg-white p-5" onSubmit={createStage}><h2 className="font-black">Tambah stage</h2><input required placeholder="ID dibuat dari judul" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} aria-label="Judul stage" /><textarea required rows={3} placeholder="Deskripsi berdasarkan fakta Producer" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} aria-label="Deskripsi stage" /><button className="w-fit rounded-lg bg-[#20231f] px-4 py-2 text-sm font-bold text-white" type="submit">Simpan draft</button></form><div className="mt-6 grid gap-4">{stages.map((stage, index) => <StageCard key={stage.id} stage={stage} onSave={updateStage} onStatus={changeStatus} onMove={moveStage} index={index} />)}{stages.length === 0 && <p className="text-sm text-black/60">Belum ada stage.</p>}</div></div></main>;
}

function StageCard({ stage, onSave, onStatus, onMove, index }: { stage: ProductionStage; onSave: (stage: ProductionStage, draft: StageDraft) => void; onStatus: (stage: ProductionStage, status: ProductionStageStatus) => void; onMove: (index: number, direction: -1 | 1) => void; index: number }) {
  const [title, setTitle] = useState(stage.title);
  const [description, setDescription] = useState(stage.description);
  return <article className="rounded-xl border border-black/10 bg-white p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[#7b5b38]">Urutan {stage.sortOrder + 1}</p><h2 className="mt-1 text-xl font-black">{stage.title}</h2></div><span className="text-xs font-bold uppercase text-[#7b5b38]">{stage.status}</span></div><div className="mt-4 grid gap-3"><input value={title} onChange={(event) => setTitle(event.target.value)} aria-label={`Judul ${stage.id}`} /><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} aria-label={`Deskripsi ${stage.id}`} /><div className="flex flex-wrap gap-2"><button className="rounded border border-black/15 px-3 py-1 text-sm font-semibold" type="button" onClick={() => onSave(stage, { title, description, experienceIds: stage.experienceIds })}>Simpan</button><button className="rounded border border-black/15 px-3 py-1 text-sm font-semibold" type="button" disabled={index === 0} onClick={() => onMove(index, -1)}>Naik</button><button className="rounded border border-black/15 px-3 py-1 text-sm font-semibold" type="button" disabled={index < 0} onClick={() => onMove(index, 1)}>Turun</button><button className="rounded border border-black/15 px-3 py-1 text-sm font-semibold" type="button" onClick={() => onStatus(stage, "review")}>Ajukan review</button><button className="rounded border border-black/15 px-3 py-1 text-sm font-semibold" type="button" onClick={() => onStatus(stage, "published")}>Publish</button></div></div></article>;
}
