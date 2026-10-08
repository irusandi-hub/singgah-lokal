"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProductionStage, ProductionStageStatus } from "@/lib/production-story";
import { productionStageStatusLabel } from "@/lib/status-labels";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Panel,
  Section,
  StatusBadge,
  StatusMessage,
  backLinkClass,
  btn,
  metaTextClass,
} from "@/components/ui/kit";

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
        else setMessage(data.error ?? "Daftar tahap tidak dapat dimuat");
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
    if (!response.ok) { setMessage(data.error ?? "Tahap tidak dapat dibuat"); return; }
    setStages((current) => [...current, data]);
    setDraft({ title: "", description: "", experienceIds: [] });
    setMessage(`Tahap disimpan — Status: ${productionStageStatusLabel(data.status)}`);
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
    setMessage(`Tahap diperbarui — Status: ${productionStageStatusLabel(data.status)}`);
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
    setMessage(`Status tahap: ${productionStageStatusLabel(data.status)}`);
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
    if (!response.ok) { setMessage(data.error ?? "Urutan tahap tidak dapat diubah"); return; }
    setStages(data);
  }

  return (
    <PageShell>
      <PageHeader
        back={
          <Link className={backLinkClass} href={`/producer/places/${placeId}`}>
            ← Kembali ke Tempat
          </Link>
        }
        title="Dari Sini"
        description="Susun cerita produksi Tempat berdasarkan tahap yang benar-benar terjadi."
      />

      {message ? (
        <div className="mt-3">
          <StatusMessage message={message} />
        </div>
      ) : null}

      <div className="mt-4 grid gap-5">
        <Section title="Tambah tahap">
          <Panel>
            <form className="grid gap-3" onSubmit={createStage}>
              <input
                required
                placeholder="Judul tahap"
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                aria-label="Judul tahap"
              />
              <textarea
                required
                rows={3}
                placeholder="Deskripsi berdasarkan fakta Pengelola"
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                aria-label="Deskripsi tahap"
              />
              <button className={`w-fit ${btn.solid}`} type="submit">Simpan draft</button>
            </form>
          </Panel>
        </Section>

        <Section title="Tahap proses">
          {stages.length === 0 ? (
            <EmptyState title="Belum ada tahap." />
          ) : (
            <div className="grid gap-2">
              {stages.map((stage, index) => (
                <StageRow key={stage.id} stage={stage} index={index} onSave={updateStage} onStatus={changeStatus} onMove={moveStage} />
              ))}
            </div>
          )}
        </Section>
      </div>
    </PageShell>
  );
}

function StageRow({ stage, onSave, onStatus, onMove, index }: { stage: ProductionStage; onSave: (stage: ProductionStage, draft: StageDraft) => void; onStatus: (stage: ProductionStage, status: ProductionStageStatus) => void; onMove: (index: number, direction: -1 | 1) => void; index: number }) {
  const [title, setTitle] = useState(stage.title);
  const [description, setDescription] = useState(stage.description);
  return (
    <Panel className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={metaTextClass}>
          Urutan {stage.sortOrder + 1}
        </p>
        <StatusBadge tone={stage.status === "published" ? "positive" : stage.status === "review" ? "warning" : "neutral"}>
          {productionStageStatusLabel(stage.status)}
        </StatusBadge>
      </div>
      <label className="grid gap-1 text-xs font-semibold">
        Judul tahap
        <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label={`Judul tahap ${stage.id}`} />
      </label>
      <label className="grid gap-1 text-xs font-semibold">
        Deskripsi
        <textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} aria-label={`Deskripsi tahap ${stage.id}`} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button className={btn.secondary} type="button" onClick={() => onSave(stage, { title, description, experienceIds: stage.experienceIds })}>
          Simpan
        </button>
        <button className={btn.compact} type="button" disabled={index === 0} onClick={() => onMove(index, -1)}>
          Naik
        </button>
        <button className={btn.compact} type="button" disabled={index < 0} onClick={() => onMove(index, 1)}>
          Turun
        </button>
        <button className={btn.compact} type="button" onClick={() => onStatus(stage, "review")}>
          Ajukan peninjauan
        </button>
        <button className={btn.compact} type="button" onClick={() => onStatus(stage, "published")}>
          Tayangkan
        </button>
      </div>
    </Panel>
  );
}
