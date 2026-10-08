"use client";

import { useCallback, useEffect, useState } from "react";
import {
  PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES,
  PLACE_CLAIM_EVIDENCE_MAX_BYTES,
  type ClaimablePlace,
  type PlaceClaimSummary,
  placeClaimErrorMessage,
} from "@/lib/place-claim";
import { placeTypeLabel } from "@/lib/status-labels";
import { EmptyState, ErrorState, Panel, StatusBadge, StatusMessage, btn, metaTextClass, sectionTitleClass } from "@/components/ui/kit";

/**
 * AJUKAN PENGELOLAAN TEMPAT — the Producer claim surface.
 *
 * The flow the PO locked: list → pick an existing Place → see its canonical
 * data → upload proof of ownership → submit → the claim sits at "pending"
 * until an Admin reviews it.
 *
 * What this component deliberately does NOT do:
 * - it never creates or edits a Place, and there is no category/type input —
 *   the chosen Place's own canonical category and type are shown read-only;
 * - it never implies ownership. Submitting only files a claim; the copy says
 *   so, and the status list reflects what the server actually reports.
 *
 * The unowned-only filter is NOT implemented here: the list comes from the
 * server, which already excludes every Place that has an owner.
 */
type Feedback = { kind: "ok" | "error"; message: string } | null;

const STATUS_LABEL: Record<PlaceClaimSummary["status"], string> = {
  pending: "Menunggu penilaian Admin",
  approved: "Disetujui — ownership diberikan",
  rejected: "Ditolak",
};

export default function PlaceClaimPanel({ onBack }: { onBack: () => void }) {
  const [places, setPlaces] = useState<ClaimablePlace[] | null>(null);
  const [placesFailed, setPlacesFailed] = useState(false);
  const [claims, setClaims] = useState<PlaceClaimSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [placesResponse, claimsResponse] = await Promise.all([
        fetch("/api/producer/place-claims/claimable-places"),
        fetch("/api/producer/place-claims"),
      ]);
      if (placesResponse.ok) {
        const payload: unknown = await placesResponse.json().catch(() => null);
        const list =
          payload && typeof payload === "object" && "places" in payload
            ? (payload as { places: ClaimablePlace[] }).places
            : null;
        if (Array.isArray(list)) {
          setPlaces(list);
          setPlacesFailed(false);
        } else {
          setPlacesFailed(true);
        }
      } else {
        setPlacesFailed(true);
      }
      if (claimsResponse.ok) {
        const payload: unknown = await claimsResponse.json().catch(() => null);
        const list =
          payload && typeof payload === "object" && "claims" in payload
            ? (payload as { claims: PlaceClaimSummary[] }).claims
            : null;
        if (Array.isArray(list)) setClaims(list);
      }
    } catch {
      setPlacesFailed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const selected = places?.find((place) => place.id === selectedId) ?? null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (!selectedId) {
      setFeedback({ kind: "error", message: "Pilih Tempat yang ingin diklaim." });
      return;
    }
    if (!file) {
      // Mirrors the server rule: a claim without proof is refused.
      setFeedback({ kind: "error", message: placeClaimErrorMessage("place_claim_evidence_required") });
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("placeId", selectedId);
      form.set("file", file);
      form.set("note", note);
      const response = await fetch("/api/producer/place-claims", { method: "POST", body: form });
      const payload: unknown = await response.json().catch(() => null);
      const code =
        payload && typeof payload === "object" && "code" in payload
          ? String((payload as { code?: unknown }).code ?? "")
          : "";
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: code
            ? placeClaimErrorMessage(code)
            : "Klaim gagal dikirim. Coba lagi.",
        });
        return;
      }
      setSelectedId("");
      setFile(null);
      setNote("");
      setFeedback({
        kind: "ok",
        message:
          "Klaim terkirim dan berstatus menunggu penilaian. Ownership diberikan hanya setelah Admin menyetujui.",
      });
      await load();
    } catch {
      setFeedback({ kind: "error", message: "Tidak dapat menghubungi server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Ajukan Pengelolaan Tempat" className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={sectionTitleClass}>Ajukan Pengelolaan Tempat</h2>
        <button type="button" onClick={onBack} className={btn.compact}>
          Kembali ke Tempat
        </button>
      </div>
      <p className={`text-black/55 ${metaTextClass}`}>
        Hanya Tempat yang belum memiliki Pengelola yang dapat diajukan. Pengajuan tidak membuat
        atau mengubah data Tempat. Bukti kepemilikan tersimpan privat dan diarsipkan maksimal
        30 hari untuk kebutuhan operasional — lihat{" "}
        <a
          href="/policy"
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold text-brand-primary underline underline-offset-2"
        >
          Kebijakan
        </a>
        .
      </p>

      {claims.length > 0 && (
        <Panel>
          <h3 className="text-sm font-semibold">Status pengajuanmu</h3>
          <ul className="mt-1 divide-y divide-black/5">
            {claims.map((claim) => (
              <li key={claim.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{claim.placeName}</span>
                  <span className={`text-black/50 ${metaTextClass}`}>
                    {claim.category} · {placeTypeLabel(claim.type)} · diajukan {new Date(claim.createdAt).toLocaleDateString("id-ID")}
                  </span>
                </span>
                <StatusBadge tone={claim.status === "approved" ? "positive" : claim.status === "rejected" ? "negative" : "warning"}>
                  {STATUS_LABEL[claim.status]}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {placesFailed ? (
        <ErrorState message="Daftar Tempat tidak dapat dimuat. Coba muat ulang halaman." />
      ) : places === null ? (
        <StatusMessage message="Memuat…" />
      ) : places.length === 0 ? (
        <EmptyState
          title="Tidak ada Tempat tanpa Pengelola saat ini."
          description="Tempat yang sudah dikelola Pengelola lain tidak dapat diajukan."
        />
      ) : (
        <Panel>
        <form onSubmit={submit} className="grid gap-3">
          <label htmlFor="claim-place" className="block text-sm font-semibold">
            Tempat yang ingin kamu kelola
          </label>
          <select
            id="claim-place"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm"
          >
            <option value="">Pilih Tempat…</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name} — {place.area}
              </option>
            ))}
          </select>

          {selected && (
            <div className="rounded-xl bg-brand-cream/60 p-3">
              <p className="text-sm font-semibold">{selected.name}</p>
              <p className={`mt-1 text-black/60 ${metaTextClass}`}>{selected.shortDescription}</p>
              <p className={`mt-1 text-black/60 ${metaTextClass}`}>
                Kategori: <strong>{selected.category}</strong> · Tipe: <strong>{placeTypeLabel(selected.type)}</strong> · Area:{" "}
                <strong>{selected.area}</strong>
              </p>
              <p className={`mt-1 text-black/50 ${metaTextClass}`}>
                Kategori dan tipe mengikuti Tempat yang ada dan tidak dapat diubah lewat pengajuan.
              </p>
            </div>
          )}

          <label htmlFor="claim-evidence" className="block text-sm font-semibold">
            Bukti kepemilikan <span className="font-normal text-black/55">(wajib)</span>
          </label>
          <input
            id="claim-evidence"
            type="file"
            required
            accept={PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES.join(",")}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm"
          />
          <p className={`text-black/50 ${metaTextClass}`}>
            Maksimal {Math.round(PLACE_CLAIM_EVIDENCE_MAX_BYTES / (1024 * 1024))} MB, format{" "}
            {PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES.map((type) => type.split("/")[1].toUpperCase()).join(", ")}.
            Bukti disimpan secara privat dan hanya dapat dinilai Admin.
          </p>

          <label htmlFor="claim-note" className="block text-sm font-semibold">
            Catatan <span className="font-normal text-black/55">(opsional)</span>
          </label>
          <textarea
            id="claim-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={1000}
            className="w-full rounded-xl border border-black/10 px-3 py-2 text-sm"
          />

          <button type="submit" disabled={busy} className={`w-fit ${btn.primary}`}>
            {busy ? "Mengirim…" : "Kirim pengajuan"}
          </button>
        </form>
        </Panel>
      )}

      {feedback ? (
        <p
          className={`rounded-xl border px-3 py-2 text-xs font-semibold ${
            feedback.kind === "ok"
              ? "border-brand-primary/30 bg-brand-primary/10 text-brand-primary"
              : "border-red-800/30 bg-red-800/10 text-red-800"
          }`}
          role="status"
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
