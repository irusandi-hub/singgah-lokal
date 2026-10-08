"use client";

import { useEffect, useState } from "react";
import type { ProductionStage, ProductionStageStatus } from "@/lib/production-story";
import { productionStageStatusLabel } from "@/lib/status-labels";
import { StatusBadge, StatusMessage, btn, metaTextClass, sectionTitleClass } from "@/components/ui/kit";

type StageDraft = Pick<ProductionStage, "title" | "description" | "experienceIds">;

/**
 * DARI SINI — the production story of ONE Place ("Kelola Proses").
 *
 * UI/UX restructure 2026-10-08: same functionality (add stage, edit, reorder,
 * review, publish, status) through the same existing endpoints, but it is now
 * the FOURTH workspace item of the Place instead of a separately navigated
 * page — so it carries no page shell, no back link and no second navigation
 * layer. The nesting was flattened too: separators and spacing instead of a
 * panel inside a section inside a card.
 */
export default function ProductionStoryPanel({ placeId }: { placeId: string }) {
  const [stages, setStages] = useState<ProductionStage[]>([]);
  const [draft, setDraft] = useState<StageDraft>({ title: "", description: "", experienceIds: [] });
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/producer/places/${placeId}/production-story`).then(async (response) => {
      const data = await response.json();
      if (cancelled) return;
      if (response.ok) setStages(data);
      else setMessage(data.error ?? "Daftar tahap tidak dapat dimuat");
    }).catch(() => {
      // A failed load must not read as "Belum ada tahap".
      if (!cancelled) setMessage("Daftar tahap tidak dapat dimuat. Periksa koneksi lalu muat ulang.");
    });
    return () => {
      cancelled = true;
    };
  }, [placeId]);

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
    <section className="grid min-w-0 gap-5" aria-label="Dari Sini">
      <div>
        <h2 className={sectionTitleClass}>Dari Sini</h2>
        <p className={`mt-1 text-black/55 ${metaTextClass}`}>Susun cerita produksi Tempat berdasarkan tahap yang benar-benar terjadi.</p>
      </div>

      {message ? <StatusMessage message={message} /> : null}

      <div className="grid min-w-0 gap-3">
        <h3 className="text-sm font-semibold">Tambah tahap</h3>
        <form className="grid min-w-0 gap-3" onSubmit={createStage}>
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
      </div>

      <div className="grid min-w-0 gap-3">
        <h3 className="text-sm font-semibold">Tahap proses</h3>
        {stages.length === 0 ? (
          <p className={`text-black/55 ${metaTextClass}`}>Belum ada tahap.</p>
        ) : (
          <ol className="grid min-w-0 gap-3">
            {stages.map((stage, index) => (
              <StageRow key={stage.id} stage={stage} index={index} isLast={index === stages.length - 1} onSave={updateStage} onStatus={changeStatus} onMove={moveStage} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function StageRow({ stage, onSave, onStatus, onMove, index, isLast }: { stage: ProductionStage; onSave: (stage: ProductionStage, draft: StageDraft) => void; onStatus: (stage: ProductionStage, status: ProductionStageStatus) => void; onMove: (index: number, direction: -1 | 1) => void; index: number; isLast: boolean }) {
  const [title, setTitle] = useState(stage.title);
  const [description, setDescription] = useState(stage.description);
  return (
    <li className="grid min-w-0 gap-2 border-t border-black/10 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-black/40" aria-hidden>{String(index + 1).padStart(2, "0")}</span>
        <input
          className="min-w-0 flex-1"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label={`Judul tahap ${stage.id}`}
        />
        <StatusBadge tone={stage.status === "published" ? "positive" : stage.status === "review" ? "warning" : "neutral"}>
          {productionStageStatusLabel(stage.status)}
        </StatusBadge>
      </div>
      <textarea
        rows={2}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        aria-label={`Deskripsi tahap ${stage.id}`}
      />
      <div className="flex flex-wrap gap-2">
        <button className={btn.secondary} type="button" onClick={() => onSave(stage, { title, description, experienceIds: stage.experienceIds })}>
          Simpan
        </button>
        <button className={btn.compact} type="button" disabled={index === 0} onClick={() => onMove(index, -1)}>
          Naik
        </button>
        <button className={btn.compact} type="button" disabled={isLast} onClick={() => onMove(index, 1)}>
          Turun
        </button>
        <button className={btn.compact} type="button" onClick={() => onStatus(stage, "review")}>
          Ajukan peninjauan
        </button>
        <button className={btn.compact} type="button" onClick={() => onStatus(stage, "published")}>
          Tayangkan
        </button>
      </div>
    </li>
  );
}
